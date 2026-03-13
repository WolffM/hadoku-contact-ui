/**
 * Email Whitelist E2E Tests
 *
 * Tests whitelist behavior in full HTTP flows:
 * - Whitelisted emails bypass referrer restrictions
 * - Non-whitelisted emails with invalid referrer are rejected
 * - Auto-whitelisting on admin reply
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addToWhitelist } from '../../storage'

describe('Whitelist in Contact Submission', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()

    const keys = await env.RATE_LIMIT_KV.list()
    for (const key of keys.keys) {
      await env.RATE_LIMIT_KV.delete(key.name)
    }
  })

  it('should allow whitelisted email without valid referrer', async () => {
    await addToWhitelist(env.DB, 'whitelisted@example.com', 'admin')

    const response = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '1.2.3.4'
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'whitelisted@example.com',
        message: 'Should work because whitelisted'
      })
    })

    expect(response.status).toBe(201)
  })

  it('should reject non-whitelisted email with invalid referrer', async () => {
    const response = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '1.2.3.4',
        Referer: 'https://evil-site.com/spam'
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'notwhitelisted@example.com',
        message: 'Should fail'
      })
    })

    expect(response.status).toBe(400)
    const data = (await response.json()) as { message: string }
    expect(data.message).toBe('Invalid referrer')
  })

  it('should allow non-whitelisted email with valid referrer', async () => {
    const response = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '1.2.3.4',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Test User',
        email: 'notwhitelisted@example.com',
        message: 'Works with valid referrer'
      })
    })

    expect(response.status).toBe(201)
  })
})

describe('Auto-Whitelist on Admin Reply', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('should whitelist recipient after sending email', async () => {
    fetchMock
      .get('https://api.resend.com')
      .intercept({ path: '/emails', method: 'POST' })
      .reply(200, JSON.stringify({ id: 'test-message-id' }))

    const response = await SELF.fetch('https://test.com/contact/api/admin/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Key': 'test-admin-key'
      },
      body: JSON.stringify({
        from: 'matthaeus@hadoku.me',
        to: 'recipient@example.com',
        subject: 'Test Reply',
        text: 'Thanks for contacting us!'
      })
    })

    expect(response.status).toBe(200)

    const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
      .bind('recipient@example.com')
      .first()
    expect(row).not.toBeNull()
    expect(row!.notes as string).toContain('Auto-whitelisted')
  })
})
