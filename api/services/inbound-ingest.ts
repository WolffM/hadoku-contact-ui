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
 * discarded, so it is one folder away instead of gone.
 */

import { EMAIL_CONFIG } from '../constants'
import {
  isEmailWhitelisted,
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

  // The gate. Failing it no longer means the mail disappears — it means the
  // mail lands in the Filtered folder with the reason attached.
  const whitelisted = await isEmailWhitelisted(db, senderEmail)
  const filteredReason: FilteredReason | null =
    whitelisted || isPublicRecipient(recipient) ? null : 'not_whitelisted'

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
    // Backfilled mail arrives already-read: a sweep that pulls in 30 days of
    // history should not detonate the unread badge with mail the user has
    // already seen in the Resend dashboard.
    status: source === 'webhook' ? 'unread' : 'read'
  })

  await recordInboundEmail(db, {
    resendEmailId: input.emailId,
    submissionId: submission.id,
    source: source === 'webhook' ? 'webhook' : 'sync',
    outcome: filteredReason ? 'filtered' : 'stored'
  })

  console.log(
    `[inbound] ${input.emailId}: ${filteredReason ? `filtered (${filteredReason})` : 'stored'} as ${submission.id}`
  )

  return {
    processed: true,
    outcome: filteredReason ? 'filtered' : 'stored',
    submissionId: submission.id,
    filteredReason: filteredReason ?? undefined,
    message: filteredReason ? `Quarantined: ${filteredReason}` : 'Email processed successfully'
  }
}
