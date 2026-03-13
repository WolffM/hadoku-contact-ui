/**
 * Send Email Endpoint Tests
 *
 * Tests the admin send-email endpoint against real D1/KV
 * with fetchMock for the Resend API.
 */
import { SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-User-Key': 'test-admin-key'
}

async function sendEmail(body: Record<string, unknown>, headers = ADMIN_HEADERS) {
  return SELF.fetch('https://test.com/contact/api/admin/send-email', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
}

describe('POST /contact/api/admin/send-email', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('should require admin authentication', async () => {
    const response = await sendEmail(
      { from: 'test@hadoku.me', to: 'r@example.com', subject: 'Test', text: 'Test' },
      { 'Content-Type': 'application/json' }
    )

    expect(response.status).toBe(403)
    const data = (await response.json()) as { message: string }
    expect(data.message).toContain('Admin access required')
  })

  it('should send email successfully with valid data', async () => {
    fetchMock
      .get('https://api.resend.com')
      .intercept({ path: '/emails', method: 'POST' })
      .reply(200, JSON.stringify({ id: 'test-message-id' }))

    const response = await sendEmail({
      from: 'matthaeus@hadoku.me',
      to: 'test@example.com',
      subject: 'Test Email',
      text: 'This is a test email'
    })

    expect(response.status).toBe(200)
    const data = (await response.json()) as { data: Record<string, unknown> }
    expect(data.data.success).toBe(true)
    expect(data.data.messageId).toBeDefined()
  })

  it('should validate required fields', async () => {
    const testCases = [
      { field: 'from', body: { to: 'test@example.com', subject: 'Test', text: 'Test' } },
      { field: 'to', body: { from: 'test@hadoku.me', subject: 'Test', text: 'Test' } },
      { field: 'subject', body: { from: 'test@hadoku.me', to: 'test@example.com', text: 'Test' } },
      { field: 'text', body: { from: 'test@hadoku.me', to: 'test@example.com', subject: 'Test' } }
    ]

    for (const tc of testCases) {
      const response = await sendEmail(tc.body)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message?: string; error?: string }
      expect(data.message || data.error).toContain(tc.field)
    }
  })

  it('should reject non-hadoku.me sender addresses', async () => {
    const response = await sendEmail({
      from: 'attacker@evil.com',
      to: 'victim@example.com',
      subject: 'Phishing',
      text: 'Click here'
    })

    expect(response.status).toBe(400)
    const data = (await response.json()) as { message?: string; error?: string }
    expect(data.message || data.error).toContain('hadoku.me')
  })

  it('should handle email provider failures', async () => {
    fetchMock
      .get('https://api.resend.com')
      .intercept({ path: '/emails', method: 'POST' })
      .reply(500, 'Internal Server Error')

    const response = await sendEmail({
      from: 'test@hadoku.me',
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'Test'
    })

    expect(response.status).toBe(500)
  })

  it('should accept all valid hadoku.me sender addresses', async () => {
    const senders = [
      'matthaeus@hadoku.me',
      'mw@hadoku.me',
      'support@hadoku.me',
      'no-reply@hadoku.me'
    ]

    for (const sender of senders) {
      fetchMock
        .get('https://api.resend.com')
        .intercept({ path: '/emails', method: 'POST' })
        .reply(200, JSON.stringify({ id: 'msg-id' }))

      const response = await sendEmail({
        from: sender,
        to: 'test@example.com',
        subject: 'Test',
        text: 'Test'
      })
      expect(response.status).toBe(200)
    }
  })
})
