/**
 * Recipient-based dispatch for inbound emails received via Resend.
 *
 * When a forwarded Gmail message lands on a special-purpose mailbox like
 * `pickleball-waitlist@hadoku.me`, we forward the relevant metadata as a
 * signed POST to another hadoku service (instead of persisting it as a
 * contact submission). See `FORWARD_RECIPIENTS` in constants.ts for the
 * recipient → destination map.
 */

import { FORWARD_RECIPIENTS, type ForwardRecipient } from '../constants'
import type { ContactEnv } from '../types'

export interface ForwardedEmailInput {
  recipient: string | null
  senderEmail: string
  subject: string
  body: string | null
  emailId: string
}

export interface ForwardResult {
  handled: boolean
  label?: string
  status?: number
  ok?: boolean
  responseBody?: string
  error?: string
}

function isForwardRecipient(value: string | null): value is ForwardRecipient {
  return !!value && value in FORWARD_RECIPIENTS
}

export async function maybeForwardInboundEmail(
  env: ContactEnv,
  input: ForwardedEmailInput,
  fetchImpl: typeof fetch = fetch
): Promise<ForwardResult> {
  const recipient = input.recipient?.toLowerCase() ?? null
  if (!isForwardRecipient(recipient)) {
    return { handled: false }
  }

  const rule = FORWARD_RECIPIENTS[recipient]
  const baseUrl = (env as Record<string, string | undefined>)[rule.urlEnv]
  const apiKey = (env as Record<string, string | undefined>)[rule.keyEnv]

  if (!baseUrl || !apiKey) {
    console.warn(
      `[inbound-forward] Missing ${rule.urlEnv}/${rule.keyEnv} — dropping forward for ${recipient}`
    )
    return {
      handled: true,
      label: rule.label,
      ok: false,
      error: 'forward_target_not_configured'
    }
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${rule.path}`
  const payload = buildForwardPayload(recipient, input)

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Hadoku-Forward-Source': 'contact-api/inbound',
        'X-Hadoku-Forward-Recipient': recipient
      },
      body: JSON.stringify(payload)
    })

    const text = await response.text()
    const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text
    console.log(
      `[inbound-forward] ${rule.label} → ${response.status} ${response.ok ? 'ok' : 'fail'}`
    )
    return {
      handled: true,
      label: rule.label,
      status: response.status,
      ok: response.ok,
      responseBody: preview
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[inbound-forward] ${rule.label} error: ${message}`)
    return {
      handled: true,
      label: rule.label,
      ok: false,
      error: message
    }
  }
}

function buildForwardPayload(
  recipient: ForwardRecipient,
  input: ForwardedEmailInput
): Record<string, unknown> {
  const base = {
    email_id: input.emailId,
    email_from: input.senderEmail,
    email_subject: input.subject,
    email_body: input.body,
    recipient
  }

  if (recipient === 'pickleball-waitlist@hadoku.me') {
    const parsed = parsePickleballWaitlistSubject(input.subject ?? '')
    return {
      ...base,
      event_url: extractEventUrl(input.body ?? '', input.subject ?? ''),
      event_name_hint: parsed.eventName,
      weekday_hint: parsed.weekday,
      date_hint: parsed.dateText
    }
  }

  return base
}

/**
 * Parses Pickleball Kingdom waitlist-trigger subject lines.
 *
 * Samples (both 2025-2026):
 *   "Open Play - Social / Low Intermediate (Tuesday, January 20) has a new open spot!"
 *   "Open Play - Intermediate - RED (Wednesday, December 17) has a new open spot!"
 *
 * Returns null fields when the pattern doesn't match — the scraper falls
 * back to single-active-row matching in that case.
 */
export function parsePickleballWaitlistSubject(subject: string): {
  eventName: string | null
  weekday: string | null
  dateText: string | null
} {
  const match = subject.match(
    /^\s*(.+?)\s*\((Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*([^)]+)\)\s*has\s+a\s+new\s+open\s+spot/i
  )
  if (!match) {
    return { eventName: null, weekday: null, dateText: null }
  }
  return {
    eventName: match[1].trim(),
    weekday: match[2],
    dateText: match[3].trim()
  }
}

function extractEventUrl(body: string, subject: string): string | null {
  // Defensive fallback — Pickleball Kingdom currently sends SIGN UP as a
  // SendGrid click-tracker (u*.ct.sendgrid.net/...) so this usually returns
  // null on real emails. Kept in case the template ever links directly.
  const haystack = `${subject}\n${body}`
  const match = haystack.match(
    /https?:\/\/[^\s<>"']*podplay[^\s<>"']*\/community\/events\/[a-zA-Z0-9-]+/i
  )
  return match ? match[0].replace(/[),.;]+$/, '') : null
}
