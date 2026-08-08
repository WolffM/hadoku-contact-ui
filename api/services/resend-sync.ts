/**
 * Reconciliation sweep — pulls Resend's received-mail list and ingests
 * anything the webhook never landed.
 *
 * The webhook alone can never be authoritative: it is a single push with no
 * retry visibility, and everything it drops (worker exception, Resend
 * fetch-back failure, a deploy in flight, a misconfigured endpoint) is
 * invisible forever. This sweep is what makes the command station converge on
 * what Resend actually holds — which is the whole point of the mailbox.
 *
 * Idempotency comes from the inbound_email_ledger, NOT from the submissions
 * table: submissions get archived after ARCHIVE_AFTER_DAYS and hard-deleted
 * out of the trash, so a submissions-only check would resurrect old mail on
 * every poll.
 *
 * API reference: https://resend.com/docs/api-reference/emails/list-received-emails
 */

import { INBOUND_SYNC_CONFIG } from '../constants'
import { getSeenEmailIds } from '../storage'
import { ingestInboundEmail } from './inbound-ingest'
import type { ContactEnv } from '../types'

const RESEND_API = 'https://api.resend.com'

interface ResendReceivedListItem {
  id: string
  to: string[]
  from: string
  created_at: string
  subject: string
}

interface ResendReceivedList {
  object: 'list'
  has_more: boolean
  data: ResendReceivedListItem[]
}

interface ResendReceivedEmail {
  id: string
  to: string[]
  from: string
  created_at: string
  subject: string
  html?: string | null
  text?: string | null
}

export interface SyncResult {
  scanned: number
  stored: number
  filtered: number
  adopted: number
  skipped: number
  errors: number
  pages: number
  /** True when we stopped on a bound rather than because we ran out of mail. */
  truncated: boolean
}

async function listReceived(
  apiKey: string,
  params: { limit: number; after?: string },
  fetchImpl: typeof fetch
): Promise<ResendReceivedList> {
  const url = new URL(`${RESEND_API}/emails/receiving`)
  url.searchParams.set('limit', String(params.limit))
  if (params.after) url.searchParams.set('after', params.after)

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!response.ok) {
    throw new Error(`Resend list failed: ${response.status} ${await response.text()}`)
  }
  return response.json<ResendReceivedList>()
}

async function retrieveReceived(
  apiKey: string,
  emailId: string,
  fetchImpl: typeof fetch
): Promise<ResendReceivedEmail | null> {
  const response = await fetchImpl(`${RESEND_API}/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!response.ok) {
    console.error(`[inbound-sync] retrieve ${emailId} failed: ${response.status}`)
    return null
  }
  return response.json<ResendReceivedEmail>()
}

export async function syncInboundEmails(
  env: ContactEnv,
  fetchImpl: typeof fetch = fetch
): Promise<SyncResult> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured — cannot reconcile inbound mail')
  }

  const result: SyncResult = {
    scanned: 0,
    stored: 0,
    filtered: 0,
    adopted: 0,
    skipped: 0,
    errors: 0,
    pages: 0,
    truncated: false
  }

  // Do not reach back past the archive horizon. Rows older than that have
  // already been moved to contact_submissions_archive by daily maintenance;
  // re-ingesting them would push archived mail back into the active inbox on
  // every single poll.
  const cutoff = Date.now() - INBOUND_SYNC_CONFIG.MAX_AGE_DAYS * 24 * 60 * 60 * 1000

  let after: string | undefined
  let reachedCutoff = false
  let hitIngestCap = false

  while (result.pages < INBOUND_SYNC_CONFIG.MAX_PAGES && !reachedCutoff && !hitIngestCap) {
    const page = await listReceived(
      apiKey,
      { limit: INBOUND_SYNC_CONFIG.PAGE_SIZE, after },
      fetchImpl
    )
    result.pages += 1

    if (page.data.length === 0) break

    // Resend returns newest first, so the first item past the cutoff means
    // every remaining item is older still.
    const inWindow: ResendReceivedListItem[] = []
    for (const item of page.data) {
      if (Date.parse(item.created_at) < cutoff) {
        reachedCutoff = true
        break
      }
      inWindow.push(item)
    }

    result.scanned += inWindow.length

    const seen = await getSeenEmailIds(
      env.DB,
      inWindow.map(item => item.id)
    )
    const fresh = inWindow.filter(item => !seen.has(item.id))

    for (const item of fresh) {
      // Stop cleanly at the per-run cap and leave the rest for the next run.
      // Each ingest below costs a sequential network round trip, so an
      // unbounded backlog would overrun mgmt-api's 15s cron dispatch and page
      // as a failure for work that actually succeeded. See
      // INBOUND_SYNC_CONFIG.MAX_INGESTS_PER_RUN.
      const ingestedCount = result.stored + result.filtered + result.adopted + result.skipped
      if (ingestedCount >= INBOUND_SYNC_CONFIG.MAX_INGESTS_PER_RUN) {
        hitIngestCap = true
        break
      }

      // Sequential on purpose. Resend rate-limits, D1 has a per-invocation
      // statement budget, and a backlog sweep that fans out would trip both.
      // The sweep is a background reconciler — latency is not the constraint.
      const detail = await retrieveReceived(apiKey, item.id, fetchImpl)
      if (!detail) {
        // Left UNLEDGERED so the next sweep retries it. A transient 5xx must
        // not permanently hide an email.
        result.errors += 1
        continue
      }

      try {
        const ingested = await ingestInboundEmail(
          env,
          {
            emailId: detail.id,
            from: detail.from,
            to: detail.to,
            subject: detail.subject,
            text: detail.text,
            html: detail.html,
            createdAt: detail.created_at
          },
          'sync'
        )

        if (ingested.outcome === 'stored') {
          if (ingested.adopted) result.adopted += 1
          else result.stored += 1
        } else if (ingested.outcome === 'filtered') {
          result.filtered += 1
        } else {
          result.skipped += 1
        }
      } catch (error) {
        // Same rule: no ledger row, so the next sweep tries again.
        //
        // Interpolate the message rather than passing the Error through:
        // Workers Logs renders a passed Error as its stack alone, and a D1
        // failure's stack is entirely internal frames — the one line that says
        // WHICH constraint or limit was hit gets dropped.
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[inbound-sync] ingest ${item.id} failed: ${message}`)
        result.errors += 1
      }
    }

    if (!page.has_more) break
    after = page.data[page.data.length - 1]?.id
    if (!after) break
  }

  // Truncated = there is known remaining work, so the next run has something to
  // do. Not an error: the sweep is incremental by design and the backlog drains
  // over successive runs. Surfaced so a PERMANENTLY truncated sweep (backlog
  // arriving faster than 10-per-10-minutes) is visible rather than silent.
  result.truncated =
    hitIngestCap || (result.pages >= INBOUND_SYNC_CONFIG.MAX_PAGES && !reachedCutoff)

  console.log(
    `[inbound-sync] scanned=${result.scanned} stored=${result.stored} adopted=${result.adopted} ` +
      `filtered=${result.filtered} skipped=${result.skipped} errors=${result.errors} ` +
      `pages=${result.pages}${result.truncated ? ' TRUNCATED (more remaining; next run continues)' : ''}`
  )

  return result
}
