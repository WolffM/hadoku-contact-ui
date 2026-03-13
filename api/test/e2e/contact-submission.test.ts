/**
 * Contact Submission Integration Tests
 *
 * Tests the full contact submission flow against real D1/KV:
 * - POST /contact/api/submit endpoint
 * - D1 database storage verification
 * - Rate limiting with KV
 * - Referrer validation
 * - Honeypot detection
 * - Public recipient bypass
 * - Recipient validation
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

/** Helper to POST a contact submission */
async function submitContact(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return SELF.fetch('https://test.com/contact/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.1',
      Referer: 'https://hadoku.me/contact',
      ...headers
    },
    body: JSON.stringify(body)
  })
}

describe('Contact Submission Integration', () => {
  /** Generate a unique IP to avoid cross-test rate limit leaking */
  let testIpCounter = 0
  function uniqueIp(): string {
    testIpCounter++
    return `10.${Math.floor(testIpCounter / 256) % 256}.${testIpCounter % 256}.1`
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
  })

  describe('POST /contact/api/submit - Success Flow', () => {
    it('should create submission in D1 and track rate limit in KV', async () => {
      const ip = uniqueIp()
      const response = await submitContact(
        {
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          recipient: 'matthaeus@hadoku.me'
        },
        { 'X-Forwarded-For': ip }
      )

      expect(response.status).toBe(201)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.message).toBe('Message submitted successfully')

      // Verify D1 storage
      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('John Doe')
      expect(results[0].email).toBe('john@example.com')
      expect(results[0].status).toBe('unread')
      expect(results[0].recipient).toBe('matthaeus@hadoku.me')

      // Verify KV rate limit tracking
      const kvEntry = await env.RATE_LIMIT_KV.get(`rate-limit:${ip}`)
      expect(kvEntry).not.toBeNull()
    })

    it('should handle multiple submissions from different IPs', async () => {
      const ip1 = uniqueIp()
      const ip2 = uniqueIp()

      const r1 = await submitContact(
        {
          name: 'User One',
          email: 'user1@example.com',
          message: 'First message for testing',
          recipient: 'matthaeus@hadoku.me'
        },
        { 'X-Forwarded-For': ip1 }
      )
      expect(r1.status).toBe(201)

      const r2 = await submitContact(
        {
          name: 'User Two',
          email: 'user2@example.com',
          message: 'Second message for testing',
          recipient: 'mw@hadoku.me'
        },
        { 'X-Forwarded-For': ip2 }
      )
      expect(r2.status).toBe(201)

      const { results } = await env.DB.prepare(
        'SELECT * FROM contact_submissions ORDER BY created_at'
      ).all()
      expect(results).toHaveLength(2)
      expect(results[0].email).toBe('user1@example.com')
      expect(results[1].email).toBe('user2@example.com')
    })
  })

  describe('Rate Limiting', () => {
    it('should enforce rate limit after max submissions', async () => {
      const ip = uniqueIp()
      const headers = { 'X-Forwarded-For': ip }

      // Make 5 successful submissions
      for (let i = 0; i < 5; i++) {
        const response = await submitContact(
          {
            name: `User ${i}`,
            email: `user${i}@example.com`,
            message: `Message ${i} with enough text to pass validation`,
            recipient: 'matthaeus@hadoku.me'
          },
          headers
        )
        if (response.status !== 201) {
          const body = await response.text()
          throw new Error(`Submission ${i} failed with ${response.status}: ${body}`)
        }
      }

      // 6th should be rate limited
      const response = await submitContact(
        {
          name: 'User 6',
          email: 'user6@example.com',
          message: 'Should be blocked',
          recipient: 'matthaeus@hadoku.me'
        },
        headers
      )

      expect(response.status).toBe(429)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.message).toContain('Rate limit exceeded')
      expect(response.headers.get('X-RateLimit-Limit')).toBe('5')
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
      expect(response.headers.get('Retry-After')).toBeDefined()

      // Verify only 5 in D1
      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(5)
    })
  })

  describe('Validation', () => {
    it('should reject submission with invalid referrer', async () => {
      const response = await submitContact(
        {
          name: 'Spammer',
          email: 'spam@evil.com',
          message: 'Spam',
          recipient: 'matthaeus@hadoku.me'
        },
        { Referer: 'https://evil.com/spam' }
      )

      expect(response.status).toBe(400)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.message).toContain('Invalid referrer')

      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(0)
    })

    it('should reject submission with honeypot field filled', async () => {
      const response = await submitContact({
        name: 'Bot',
        email: 'bot@example.com',
        message: 'Bot message',
        recipient: 'matthaeus@hadoku.me',
        website: 'http://spam.com'
      })

      expect(response.status).toBe(400)

      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(0)
    })

    it('should reject submission with missing required fields', async () => {
      const response = await submitContact({
        name: 'John Doe',
        message: 'Test message',
        recipient: 'matthaeus@hadoku.me'
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: Array<{ path: string[] }> }
      expect(data.errors).toBeDefined()
      expect(data.errors.some(e => e.path.includes('email'))).toBe(true)
    })

    it('should reject submission with invalid email format', async () => {
      const response = await submitContact({
        name: 'John Doe',
        email: 'not-an-email',
        message: 'Test message',
        recipient: 'matthaeus@hadoku.me'
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: unknown[] }
      expect(data.errors).toBeDefined()
    })

    it('should reject submission with message too long', async () => {
      const response = await submitContact({
        name: 'John Doe',
        email: 'john@example.com',
        message: 'a'.repeat(10001),
        recipient: 'matthaeus@hadoku.me'
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: unknown[] }
      expect(data.errors).toBeDefined()
    })
  })

  describe('Public Recipient Bypass', () => {
    it('should bypass referrer validation for public@hadoku.me', async () => {
      const ip = uniqueIp()
      const response = await submitContact(
        {
          name: 'External User',
          email: 'user@external.com',
          message: 'Signup from external site',
          recipient: 'public@hadoku.me'
        },
        { Referer: 'https://external-site.com/signup', 'X-Forwarded-For': ip }
      )

      expect(response.status).toBe(201)
      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(1)
      expect(results[0].recipient).toBe('public@hadoku.me')
    })

    it('should bypass referrer for public@hadoku.me with no referrer', async () => {
      const ip = uniqueIp()
      const response = await SELF.fetch('https://test.com/contact/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': ip
        },
        body: JSON.stringify({
          name: 'No Referrer',
          email: 'user@example.com',
          message: 'Direct call',
          recipient: 'public@hadoku.me'
        })
      })

      expect(response.status).toBe(201)
    })

    it('should still require referrer for non-public recipients', async () => {
      const ip = uniqueIp()
      const response = await submitContact(
        {
          name: 'External User',
          email: 'user@external.com',
          message: 'Should fail',
          recipient: 'matthaeus@hadoku.me'
        },
        { Referer: 'https://external-site.com/contact', 'X-Forwarded-For': ip }
      )

      expect(response.status).toBe(400)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.message).toContain('Invalid referrer')
    })

    it('should handle public recipient case-insensitively', async () => {
      const ip = uniqueIp()
      const response = await submitContact(
        {
          name: 'Case Test',
          email: 'user@example.com',
          message: 'Testing case',
          recipient: 'PUBLIC@hadoku.me'
        },
        { Referer: 'https://evil.com', 'X-Forwarded-For': ip }
      )

      expect(response.status).toBe(201)
    })
  })

  describe('Recipient Validation', () => {
    it('should accept valid recipients', async () => {
      const validRecipients = ['matthaeus@hadoku.me', 'mw@hadoku.me', 'admin@hadoku.me']

      for (const recipient of validRecipients) {
        const ip = uniqueIp()
        const response = await submitContact(
          {
            name: 'John Doe',
            email: 'john@example.com',
            message: 'Test message',
            recipient
          },
          { 'X-Forwarded-For': ip }
        )
        expect(response.status).toBe(201)
      }

      const { results } = await env.DB.prepare('SELECT * FROM contact_submissions').all()
      expect(results).toHaveLength(validRecipients.length)
    })

    it('should reject invalid recipient', async () => {
      const ip = uniqueIp()
      const response = await submitContact(
        {
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Test message',
          recipient: 'invalid@example.com'
        },
        { 'X-Forwarded-For': ip }
      )

      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: Array<{ path: string[] }> }
      expect(data.errors).toBeDefined()
      expect(data.errors.some(e => e.path.includes('recipient'))).toBe(true)
    })
  })
})
