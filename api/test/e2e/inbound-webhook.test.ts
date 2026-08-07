/**
 * Inbound webhook E2E tests.
 *
 * The regression these exist to prevent: mail arriving at Resend and never
 * reaching the command station. The webhook used to answer 200 and discard
 * anything from a non-whitelisted sender, which meant the only way to read
 * your own mail was the Resend dashboard.
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addToWhitelist } from '../../storage'

interface SubmissionRow {
  id: string
  email: string
  message: string
  recipient: string | null
  status: string
  resend_email_id: string | null
  filtered_reason: string | null
}

function mockRetrieve(emailId: string, body: Record<string, unknown>, status = 200) {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: `/emails/receiving/${emailId}`, method: 'GET' })
    .reply(status, JSON.stringify(body))
}

async function postWebhook(data: {
  email_id: string
  from: string
  to: string[]
  subject: string
}) {
  return SELF.fetch('https://test.com/contact/api/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data })
  })
}

async function rowFor(emailId: string): Promise<SubmissionRow | null> {
  return env.DB.prepare('SELECT * FROM contact_submissions WHERE resend_email_id = ?')
    .bind(emailId)
    .first<SubmissionRow>()
}

describe('POST /contact/api/inbound', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM inbound_email_ledger').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('QUARANTINES mail from a non-whitelisted sender instead of discarding it', async () => {
    // This is the bug. matthaeus@hadoku.me is the primary mailbox and is NOT
    // in PUBLIC_RECIPIENTS, so before this change a cold email to it vanished
    // with a 200 and no row anywhere.
    mockRetrieve('em_cold', { id: 'em_cold', text: 'Are you available for contract work?' })

    const response = await postWebhook({
      email_id: 'em_cold',
      from: 'Stranger <stranger@example.com>',
      to: ['matthaeus@hadoku.me'],
      subject: 'Contract opportunity'
    })

    expect(response.status).toBe(200)

    const row = await rowFor('em_cold')
    expect(row).not.toBeNull()
    expect(row?.filtered_reason).toBe('not_whitelisted')
    expect(row?.email).toBe('stranger@example.com')
    expect(row?.recipient).toBe('matthaeus@hadoku.me')
    expect(row?.message).toContain('Contract opportunity')
    expect(row?.message).toContain('Are you available for contract work?')
  })

  it('accepts mail from a whitelisted sender with no filtered_reason', async () => {
    await addToWhitelist(env.DB, 'friend@example.com', 'admin')
    mockRetrieve('em_friend', { id: 'em_friend', text: 'Reply body' })

    await postWebhook({
      email_id: 'em_friend',
      from: 'friend@example.com',
      to: ['matthaeus@hadoku.me'],
      subject: 'Re: our chat'
    })

    const row = await rowFor('em_friend')
    expect(row?.filtered_reason).toBeNull()
    expect(row?.status).toBe('unread')
  })

  it('accepts mail to a public recipient from any sender', async () => {
    mockRetrieve('em_public', { id: 'em_public', text: 'Hello from the form' })

    await postWebhook({
      email_id: 'em_public',
      from: 'anyone@example.com',
      to: ['public@hadoku.me'],
      subject: 'Question'
    })

    const row = await rowFor('em_public')
    expect(row).not.toBeNull()
    expect(row?.filtered_reason).toBeNull()
  })

  it('strips a display name from the sender address', async () => {
    mockRetrieve('em_display', { id: 'em_display', text: 'body' })

    await postWebhook({
      email_id: 'em_display',
      from: 'Ada Lovelace <ada@example.com>',
      to: ['matthaeus@hadoku.me'],
      subject: 'Hi'
    })

    expect((await rowFor('em_display'))?.email).toBe('ada@example.com')
  })

  it('falls back to the HTML body when there is no plain text part', async () => {
    mockRetrieve('em_html', { id: 'em_html', html: '<p>rich body</p>', text: null })

    await postWebhook({
      email_id: 'em_html',
      from: 'someone@example.com',
      to: ['matthaeus@hadoku.me'],
      subject: 'HTML only'
    })

    expect((await rowFor('em_html'))?.message).toContain('<p>rich body</p>')
  })

  it('is idempotent across webhook retries — one email, one submission', async () => {
    // Resend retries deliveries. Without the ledger check the second delivery
    // would hit the UNIQUE index on resend_email_id and be reported as an
    // internal error for mail that had in fact already landed.
    mockRetrieve('em_retry', { id: 'em_retry', text: 'body' })

    const first = await postWebhook({
      email_id: 'em_retry',
      from: 'someone@example.com',
      to: ['matthaeus@hadoku.me'],
      subject: 'Retried'
    })
    expect(first.status).toBe(200)

    const second = await postWebhook({
      email_id: 'em_retry',
      from: 'someone@example.com',
      to: ['matthaeus@hadoku.me'],
      subject: 'Retried'
    })
    // ok() wraps the payload as { data, timestamp }.
    const body = (await second.json()) as { data: { success: boolean; message: string } }
    expect(body.data.success).toBe(true)
    expect(body.data.message).toBe('Already processed')

    const count = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM contact_submissions WHERE resend_email_id = ?'
    )
      .bind('em_retry')
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('leaves an email UNLEDGERED when the body cannot be fetched, so the sweep retries it', async () => {
    // The old code returned 200 here and the email was gone for good.
    mockRetrieve('em_unfetchable', { message: 'boom' }, 500)

    const response = await postWebhook({
      email_id: 'em_unfetchable',
      from: 'someone@example.com',
      to: ['matthaeus@hadoku.me'],
      subject: 'Unfetchable'
    })
    expect(response.status).toBe(200)

    const ledgered = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM inbound_email_ledger WHERE resend_email_id = ?'
    )
      .bind('em_unfetchable')
      .first<{ n: number }>()
    expect(ledgered?.n).toBe(0)
  })

  it('rejects a payload with no email_id', async () => {
    const response = await SELF.fetch('https://test.com/contact/api/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.received', data: {} })
    })
    expect(response.status).toBe(400)
  })
})
