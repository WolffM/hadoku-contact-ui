/**
 * The one place an inbound email becomes a row.
 *
 * Both entry points funnel through here — the live Resend webhook
 * (routes/inbound.ts) and the reconciliation sweep (services/resend-sync.ts) —
 * so the two can never drift into disagreeing about what mail is worth
 * keeping. Before this existed the webhook was the only ingest path AND it
 * discarded four classes of mail with a 200 and no record, which is why the
 * command station could not show what Resend actually held.
 *
 * The governing rule: nothing is ever silently dropped. Mail that fails the
 * whitelist gate is QUARANTINED (stored with a `filtered_reason`), not
 * discarded, so it is one folder away instead of gone. Blocked mail is the one
 * case with an expiry on that promise — it is still stored and still visible,
 * but in Spam, and it is hard-deleted after SPAM_RETENTION_DAYS.
 */

import { EMAIL_CONFIG } from '../constants'
import {
  isEmailWhitelisted,
  findBlockRule,
  createSubmission,
  adoptSubmissionForResendId,
  recordInboundEmail,
  type FilteredReason,
  type InboundSource
} from '../storage'
import { maybeForwardInboundEmail, isForwardRecipient } from '../routes/inbound-forwarders'
import type { ContactEnv } from '../types'

export interface InboundEmailInput {
  emailId: string
  /** Raw `from` header — may be `Display Name <addr@host>`. */
  from: string
  to: string[]
  subject: string
  text?: string | null
  html?: string | null
  /** ISO 8601 from Resend. Absent on the webhook payload; present on sync. */
  createdAt?: string | null
}

export interface IngestResult {
  processed: boolean
  outcome: 'stored' | 'filtered' | 'forwarded' | 'forward_skipped' | 'error'
  submissionId?: string
  filteredReason?: FilteredReason
  /** True when an existing row was stamped rather than a new one inserted. */
  adopted?: boolean
  message: string
  forwardStatus?: number | null
  forwardError?: string | null
}

/** `Matt <matt@example.com>` -> `matt@example.com`; a bare address passes through. */
export function extractAddress(raw: string): string {
  const lowered = raw.toLowerCase()
  const match = /<(.+)>/.exec(lowered)
  return (match?.[1] ?? lowered).trim()
}

function isPublicRecipient(recipient: string | null): boolean {
  if (!recipient) return false
  return (EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]).includes(recipient)
}

export async function ingestInboundEmail(
  env: ContactEnv,
  input: InboundEmailInput,
  source: InboundSource
): Promise<IngestResult> {
  const db = env.DB
  const senderEmail = extractAddress(input.from)
  const recipient = input.to[0]?.toLowerCase() ?? null
  const messageBody = input.text ?? input.html ?? null

  // Recipient-based forwarders are trusted routes keyed on the destination
  // mailbox, so they bypass the whitelist entirely.
  if (isForwardRecipient(recipient)) {
    // ...but only the LIVE webhook may fire them. The sweep runs minutes to
    // days after the fact, and these forwards trigger real actions in other
    // services (the pickleball waitlist claims a spot). Replaying one from a
    // reconciliation pass would act on stale information.
    if (source !== 'webhook') {
      console.log(`[inbound] ${input.emailId}: forwarder recipient ${recipient} — not replaying`)
      await recordInboundEmail(db, {
        resendEmailId: input.emailId,
        source,
        outcome: 'forward_skipped'
      })
      return {
        processed: false,
        outcome: 'forward_skipped',
        message: `Forwarder recipient ${recipient} not replayed by reconciliation`
      }
    }

    const forwardResult = await maybeForwardInboundEmail(env, {
      recipient,
      senderEmail,
      subject: input.subject,
      body: messageBody,
      emailId: input.emailId
    })

    await recordInboundEmail(db, {
      resendEmailId: input.emailId,
      source,
      outcome: 'forwarded'
    })

    return {
      processed: forwardResult.ok ?? false,
      outcome: 'forwarded',
      message: `Forwarded to ${forwardResult.label}`,
      forwardStatus: forwardResult.status ?? null,
      forwardError: forwardResult.error ?? null
    }
  }

  // A mail the webhook already stored under a different id-less row: stamp it
  // rather than inserting a twin. Only the sweep can hit this — the webhook is
  // by definition the first thing to see its own email.
  if (source !== 'webhook') {
    const adoptedId = await adoptSubmissionForResendId(db, {
      resendEmailId: input.emailId,
      email: senderEmail,
      recipient,
      subject: input.subject
    })

    if (adoptedId) {
      console.log(`[inbound] ${input.emailId}: adopted existing submission ${adoptedId}`)
      await recordInboundEmail(db, {
        resendEmailId: input.emailId,
        submissionId: adoptedId,
        source: 'adopt',
        outcome: 'stored'
      })
      return {
        processed: true,
        outcome: 'stored',
        submissionId: adoptedId,
        adopted: true,
        message: 'Matched an email already stored by the webhook'
      }
    }
  }

  // The gate, in two tiers.
  //
  // The blocklist is consulted FIRST and overrides everything below it —
  // including the whitelist and the public-recipient bypass. Those two answer
  // "may this sender reach the inbox by default?", which a block has already
  // overruled: the operator looked at this sender and said no. Checking the
  // whitelist first would mean a single past reply (send-email auto-whitelists
  // its recipient) permanently outranked an explicit block, and mail to a public
  // mailbox could never be blocked at all — which is exactly the mail that most
  // needs blocking, since those addresses are the ones scraped off the site.
  const blockRule = await findBlockRule(db, senderEmail)

  let filteredReason: FilteredReason | null
  if (blockRule) {
    filteredReason = 'blocked'
  } else {
    const whitelisted = await isEmailWhitelisted(db, senderEmail)
    filteredReason = whitelisted || isPublicRecipient(recipient) ? null : 'not_whitelisted'
  }

  const submission = await createSubmission(db, {
    name: senderEmail.split('@')[0],
    email: senderEmail,
    message: `Subject: ${input.subject}\n\n${messageBody ?? '(No message body)'}`,
    ip_address: null,
    user_agent: 'Resend Inbound Email',
    referrer: null,
    recipient,
    resend_email_id: input.emailId,
    filtered_reason: filteredReason,
    // Starts the 90-day countdown at the moment of arrival for mail that was
    // already blocked when it landed.
    spammed_at: filteredReason === 'blocked' ? Date.now() : null,
    // Backfilled mail arrives already-read: a sweep that pulls in 30 days of
    // history should not detonate the unread badge with mail the user has
    // already seen in the Resend dashboard. Blocked mail is likewise never
    // unread — the entire point of blocking a sender is to stop being notified
    // by them, so an unread spam row would defeat the feature at the last step.
    status: source === 'webhook' && !blockRule ? 'unread' : 'read'
  })

  await recordInboundEmail(db, {
    resendEmailId: input.emailId,
    submissionId: submission.id,
    source: source === 'webhook' ? 'webhook' : 'sync',
    outcome: filteredReason ? 'filtered' : 'stored'
  })

  // Name the rule that fired, not just the verdict: "blocked by @cerebras.net"
  // and "blocked by info@cerebras.net" are the difference between a domain block
  // that is eating more than intended and one that is doing its job, and that is
  // the first thing worth knowing when a block turns out to be too wide.
  const detail = blockRule
    ? `blocked by ${blockRule.kind} rule ${blockRule.pattern}`
    : filteredReason
  console.log(
    `[inbound] ${input.emailId}: ${filteredReason ? `filtered (${detail})` : 'stored'} as ${submission.id}`
  )

  return {
    processed: true,
    outcome: filteredReason ? 'filtered' : 'stored',
    submissionId: submission.id,
    filteredReason: filteredReason ?? undefined,
    message: filteredReason ? `Quarantined: ${detail}` : 'Email processed successfully'
  }
}
