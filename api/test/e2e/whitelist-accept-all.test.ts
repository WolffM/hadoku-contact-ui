/**
 * The inbound gate with INBOUND_WHITELIST_MODE=accept-all.
 *
 * These drive `ingestInboundEmail` directly rather than through the webhook
 * route, because the binding has to vary per case and the worker's env does
 * not. The route contributes only the Resend retrieve and the signature check,
 * neither of which touches the gate.
 *
 * The pairing matters: every case here has a mirror asserting the DEFAULT still
 * quarantines. A switch that silently applies everywhere is the bug this file
 * exists to catch.
 */
import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ingestInboundEmail } from '../../services/inbound-ingest'
import {
  addToBlocklist,
  applyBlockToExistingMail,
  createSubmission,
  releaseQuarantinedSubmissions,
  restoreBlockedMail
} from '../../storage'
import { EMAIL_CONFIG } from '../../constants'

/** A mailbox deliberately NOT in PUBLIC_RECIPIENTS, so the whitelist tier applies. */
const NON_PUBLIC_RECIPIENT = 'support@hadoku.me'

if ((EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]).includes(NON_PUBLIC_RECIPIENT)) {
  throw new Error(
    `${NON_PUBLIC_RECIPIENT} is now in PUBLIC_RECIPIENTS and cannot stand in for a ` +
      `whitelist-gated mailbox. Pick another address for NON_PUBLIC_RECIPIENT.`
  )
}

const acceptAll = { ...env, INBOUND_WHITELIST_MODE: 'accept-all' }

function coldEmail(emailId: string) {
  return {
    emailId,
    from: 'Stranger <stranger@example.com>',
    to: [NON_PUBLIC_RECIPIENT],
    subject: 'Contract opportunity',
    text: 'Are you available for contract work?'
  }
}

async function reasonOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT filtered_reason FROM contact_submissions WHERE id = ?')
    .bind(id)
    .first<{ filtered_reason: string | null }>()
  return row?.filtered_reason ?? null
}

describe('ingestInboundEmail with the whitelist off', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM inbound_email_ledger').run()
  })

  it('lands an unvouched sender in the Inbox', async () => {
    const result = await ingestInboundEmail(acceptAll, coldEmail('em_open'), 'webhook')

    expect(result.outcome).toBe('stored')
    expect(result.filteredReason).toBeUndefined()
    expect(await reasonOf(result.submissionId!)).toBeNull()
  })

  it('quarantines the same mail when the binding is absent', async () => {
    // The control. Without this the test above passes on a build where the
    // whitelist tier was deleted outright rather than made switchable.
    const result = await ingestInboundEmail(env, coldEmail('em_gated'), 'webhook')

    expect(result.outcome).toBe('filtered')
    expect(result.filteredReason).toBe('not_whitelisted')
  })

  it('still routes a BLOCKED sender to Spam', async () => {
    // The whole point of splitting the two tiers: dropping "nobody has vouched
    // for this sender" must not also drop "I looked at this sender and said no".
    await addToBlocklist(env.DB, {
      pattern: 'stranger@example.com',
      kind: 'address',
      blockedBy: 'test'
    })

    const result = await ingestInboundEmail(acceptAll, coldEmail('em_blocked'), 'webhook')

    expect(result.outcome).toBe('filtered')
    expect(result.filteredReason).toBe('blocked')
  })

  it('marks mail unread, since it is now Inbox mail the operator has not seen', async () => {
    const result = await ingestInboundEmail(acceptAll, coldEmail('em_unread'), 'webhook')

    const row = await env.DB.prepare('SELECT status FROM contact_submissions WHERE id = ?')
      .bind(result.submissionId!)
      .first<{ status: string }>()
    expect(row?.status).toBe('unread')
  })
})

describe('restoreBlockedMail with the whitelist off', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM email_blocklist').run()
  })

  async function blockedRow() {
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')
    return row
  }

  it('returns an unblocked sender to the Inbox, not to Filtered', async () => {
    // Filtered is where the ENFORCED gate puts unvouched mail. With the gate
    // off there is no such folder for it to fall back to, and sending it there
    // anyway would leave the restored mail sitting somewhere the sender's NEXT
    // message will never appear.
    const row = await blockedRow()

    expect(await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address', false)).toBe(1)
    expect(await reasonOf(row.id)).toBeNull()
  })

  it('clears the retention clock, exactly as the enforced path does', async () => {
    const row = await blockedRow()
    await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address', false)

    const stamped = await env.DB.prepare('SELECT spammed_at FROM contact_submissions WHERE id = ?')
      .bind(row.id)
      .first<{ spammed_at: number | null }>()
    expect(stamped?.spammed_at).toBeNull()
  })

  it('defaults to re-evaluating the whitelist when no mode is passed', async () => {
    const row = await blockedRow()

    expect(await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address')).toBe(1)
    expect(await reasonOf(row.id)).toBe('not_whitelisted')
  })
})

describe('releaseQuarantinedSubmissions', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_blocklist').run()
  })

  async function quarantined(email: string) {
    return createSubmission(env.DB, {
      name: email.split('@')[0],
      email,
      message: 'cold outreach',
      ip_address: null,
      user_agent: null,
      referrer: null,
      filtered_reason: 'not_whitelisted'
    })
  }

  it('clears the backlog the switch left behind', async () => {
    // Turning the gate off stops new mail being stamped and says nothing about
    // mail already behind it, which would otherwise sit in Filtered for the life
    // of the row.
    const a = await quarantined('one@example.com')
    const b = await quarantined('two@example.com')

    expect(await releaseQuarantinedSubmissions(env.DB)).toBe(2)
    expect(await reasonOf(a.id)).toBeNull()
    expect(await reasonOf(b.id)).toBeNull()
  })

  it('leaves blocked mail in Spam', async () => {
    // The one thing this must not do. Blocked mail is on a 90-day destruction
    // clock and releasing it would put an explicitly-rejected sender back in
    // the Inbox — the opposite of what the operator asked for.
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(await releaseQuarantinedSubmissions(env.DB)).toBe(0)
    expect(await reasonOf(row.id)).toBe('blocked')

    const stamped = await env.DB.prepare('SELECT spammed_at FROM contact_submissions WHERE id = ?')
      .bind(row.id)
      .first<{ spammed_at: number | null }>()
    expect(stamped?.spammed_at).not.toBeNull()
  })

  it('is a no-op on the second run', async () => {
    // Daily maintenance calls this every day forever. It has to converge, not
    // keep finding work.
    await quarantined('one@example.com')

    expect(await releaseQuarantinedSubmissions(env.DB)).toBe(1)
    expect(await releaseQuarantinedSubmissions(env.DB)).toBe(0)
  })
})
