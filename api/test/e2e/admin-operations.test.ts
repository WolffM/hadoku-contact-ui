/**
 * Admin Operations Integration Tests
 *
 * Tests all admin CRUD operations against real D1:
 * - Submission management (list, get, update, delete)
 * - Whitelist management (list, add, remove, upsert)
 * - Appointment management (list, update status)
 * - Appointment configuration (get, update, round-trip)
 * - Email sending with auto-whitelisting
 * - Statistics endpoint
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-User-Key': 'test-admin-key'
}

const NO_AUTH_HEADERS = {
  'Content-Type': 'application/json'
}

/** Helper to make admin API requests */
async function adminRequest(path: string, options: RequestInit = {}) {
  return SELF.fetch(`https://test.com${path}`, {
    headers: ADMIN_HEADERS,
    ...options
  })
}

/** Unwrap { data: T } wrapper */
function unwrapData<T>(result: Record<string, unknown>): T {
  return result.data as T
}

describe('Admin Operations Integration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM appointments').run()
  })

  describe('Submission Management', () => {
    beforeEach(async () => {
      await env.DB.prepare(
        'INSERT INTO contact_submissions (id, name, email, message, status, created_at, recipient) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          'sub-1',
          'User One',
          'user1@example.com',
          'First message',
          'unread',
          Date.now() - 3600000,
          'matthaeus@hadoku.me'
        )
        .run()

      await env.DB.prepare(
        'INSERT INTO contact_submissions (id, name, email, message, status, created_at, recipient) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          'sub-2',
          'User Two',
          'user2@example.com',
          'Second message',
          'read',
          Date.now() - 1800000,
          'mw@hadoku.me'
        )
        .run()
    })

    it('GET /contact/api/admin/submissions - should list all submissions', async () => {
      const response = await adminRequest('/contact/api/admin/submissions?limit=10&offset=0')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ submissions: unknown[]; stats: unknown }>(result)
      expect(data.submissions).toHaveLength(2)
      expect(data.stats).toBeDefined()
    })

    it('GET /contact/api/admin/submissions/:id - should get single submission', async () => {
      const response = await adminRequest('/contact/api/admin/submissions/sub-1')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ submission: Record<string, unknown> }>(result)
      expect(data.submission.id).toBe('sub-1')
      expect(data.submission.email).toBe('user1@example.com')
    })

    it('PATCH - should update submission status in D1', async () => {
      const response = await adminRequest('/contact/api/admin/submissions/sub-1/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'archived' })
      })

      expect(response.status).toBe(200)

      // Verify in real D1
      const row = await env.DB.prepare('SELECT status FROM contact_submissions WHERE id = ?')
        .bind('sub-1')
        .first()
      expect(row!.status).toBe('archived')
    })

    it('DELETE - should soft-delete submission in D1', async () => {
      const response = await adminRequest('/contact/api/admin/submissions/sub-1', {
        method: 'DELETE'
      })

      expect(response.status).toBe(200)

      // Verify soft-delete in D1
      const row = await env.DB.prepare(
        'SELECT status, deleted_at FROM contact_submissions WHERE id = ?'
      )
        .bind('sub-1')
        .first()
      expect(row!.status).toBe('deleted')
      expect(row!.deleted_at).toBeDefined()
    })

    it('should require admin authentication for all submission endpoints', async () => {
      const endpoints = [
        { method: 'GET', path: '/contact/api/admin/submissions' },
        { method: 'GET', path: '/contact/api/admin/submissions/sub-1' },
        { method: 'PATCH', path: '/contact/api/admin/submissions/sub-1/status' },
        { method: 'DELETE', path: '/contact/api/admin/submissions/sub-1' }
      ]

      for (const ep of endpoints) {
        const response = await SELF.fetch(`https://test.com${ep.path}`, {
          method: ep.method,
          headers: NO_AUTH_HEADERS,
          body: ep.method === 'PATCH' ? JSON.stringify({ status: 'read' }) : undefined
        })
        expect(response.status).toBe(403)
      }
    })
  })

  describe('Whitelist Management', () => {
    beforeEach(async () => {
      await env.DB.prepare(
        'INSERT INTO email_whitelist (email, whitelisted_at, whitelisted_by, notes) VALUES (?, ?, ?, ?)'
      )
        .bind('whitelisted@example.com', Date.now() - 86400000, 'admin', 'Existing entry')
        .run()
    })

    it('GET - should list all whitelisted emails', async () => {
      const response = await adminRequest('/contact/api/admin/whitelist')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ emails: Array<Record<string, unknown>>; total: number }>(result)
      expect(data.emails).toHaveLength(1)
      expect(data.total).toBe(1)
      expect(data.emails[0].email).toBe('whitelisted@example.com')
    })

    it('POST - should add email to whitelist in D1', async () => {
      const response = await adminRequest('/contact/api/admin/whitelist', {
        method: 'POST',
        body: JSON.stringify({ email: 'newuser@example.com', notes: 'Test addition' })
      })

      expect(response.status).toBe(200)

      // Verify in real D1
      const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
        .bind('newuser@example.com')
        .first()
      expect(row).not.toBeNull()
      expect(row!.notes).toBe('Test addition')
    })

    it('DELETE - should remove from whitelist in D1', async () => {
      const response = await adminRequest('/contact/api/admin/whitelist/whitelisted@example.com', {
        method: 'DELETE'
      })

      expect(response.status).toBe(200)

      const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
        .bind('whitelisted@example.com')
        .first()
      expect(row).toBeNull()
    })

    it('POST - should upsert existing entry', async () => {
      const response = await adminRequest('/contact/api/admin/whitelist', {
        method: 'POST',
        body: JSON.stringify({ email: 'whitelisted@example.com', notes: 'Updated notes' })
      })

      expect(response.status).toBe(200)

      // No duplicate, just updated
      const { results } = await env.DB.prepare('SELECT * FROM email_whitelist').all()
      expect(results).toHaveLength(1)
      expect(results[0].notes).toBe('Updated notes')
    })

    it('should require admin authentication', async () => {
      for (const ep of [
        { method: 'GET', path: '/contact/api/admin/whitelist' },
        { method: 'POST', path: '/contact/api/admin/whitelist' },
        { method: 'DELETE', path: '/contact/api/admin/whitelist/test@example.com' }
      ]) {
        const response = await SELF.fetch(`https://test.com${ep.path}`, {
          method: ep.method,
          headers: NO_AUTH_HEADERS,
          body: ep.method === 'POST' ? JSON.stringify({ email: 'test@example.com' }) : undefined
        })
        expect(response.status).toBe(403)
      }
    })
  })

  describe('Email Sending with Auto-Whitelisting', () => {
    beforeEach(() => {
      fetchMock.activate()
      fetchMock.disableNetConnect()
    })

    afterEach(() => {
      fetchMock.deactivate()
    })

    it('POST send-email - should send and auto-whitelist recipient', async () => {
      // Mock Resend API
      const resendMock = fetchMock.get('https://api.resend.com')
      resendMock
        .intercept({ path: '/emails', method: 'POST' })
        .reply(200, JSON.stringify({ id: 'test-message-id' }))

      const response = await adminRequest('/contact/api/admin/send-email', {
        method: 'POST',
        body: JSON.stringify({
          from: 'matthaeus@hadoku.me',
          to: 'newrecipient@example.com',
          subject: 'Test Email',
          text: 'This is a test email'
        })
      })

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<Record<string, unknown>>(result)
      expect(data.messageId).toBe('test-message-id')

      // Verify auto-whitelisting in real D1
      const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
        .bind('newrecipient@example.com')
        .first()
      expect(row).not.toBeNull()
      expect(row!.notes as string).toContain('Auto-whitelisted')
    })

    it('should validate email fields before sending', async () => {
      const response = await adminRequest('/contact/api/admin/send-email', {
        method: 'POST',
        body: JSON.stringify({
          from: 'invalid-email',
          to: 'recipient@example.com',
          subject: 'Test',
          text: 'Test'
        })
      })

      expect(response.status).toBe(400)

      // No whitelist entry should be created
      const { results } = await env.DB.prepare('SELECT * FROM email_whitelist').all()
      expect(results).toHaveLength(0)
    })
  })

  describe('Appointment Management', () => {
    beforeEach(async () => {
      await env.DB.prepare(
        `INSERT INTO appointments (id, name, email, slot_id, date, start_time, end_time, duration, timezone, platform, meeting_link, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          'apt-1',
          'Meeting One',
          'meeting1@example.com',
          'slot-1',
          '2025-12-15',
          '2025-12-15T14:00:00.000Z',
          '2025-12-15T14:30:00.000Z',
          30,
          'America/New_York',
          'discord',
          'https://discord.gg/abc',
          'confirmed',
          Date.now(),
          Date.now()
        )
        .run()

      await env.DB.prepare(
        `INSERT INTO appointments (id, name, email, slot_id, date, start_time, end_time, duration, timezone, platform, meeting_link, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          'apt-2',
          'Meeting Two',
          'meeting2@example.com',
          'slot-2',
          '2025-12-16',
          '2025-12-16T10:00:00.000Z',
          '2025-12-16T10:30:00.000Z',
          30,
          'America/New_York',
          'google',
          'https://meet.google.com/abc',
          'confirmed',
          Date.now(),
          Date.now()
        )
        .run()
    })

    it('GET - should list all appointments', async () => {
      const response = await adminRequest('/contact/api/admin/appointments')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ appointments: unknown[] }>(result)
      expect(data.appointments).toHaveLength(2)
    })

    it('POST - should create admin event without going through booking flow', async () => {
      const response = await adminRequest('/contact/api/admin/appointments', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Personal Event',
          email: 'matthaeus@hadoku.me',
          date: '2030-06-15',
          start_time: '2030-06-15T14:00:00.000Z',
          end_time: '2030-06-15T15:00:00.000Z',
          duration: 60,
          timezone: 'America/Los_Angeles',
          platform: 'jitsi',
          message: 'Dentist appointment'
        })
      })
      expect(response.status).toBe(201)
      const result = (await response.json()) as {
        success: boolean
        data: { appointment: { id: string; name: string; submission_id: string | null } }
      }
      expect(result.success).toBe(true)
      expect(result.data.appointment.name).toBe('Personal Event')
      expect(result.data.appointment.submission_id).toBeNull()
    })

    it('POST - should reject malformed body with 400', async () => {
      const response = await adminRequest('/contact/api/admin/appointments', {
        method: 'POST',
        body: JSON.stringify({ name: 'Bad', email: 'not-an-email' })
      })
      expect(response.status).toBe(400)
    })

    it('POST - should require admin auth', async () => {
      const response = await SELF.fetch('https://test.com/contact/api/admin/appointments', {
        method: 'POST',
        headers: NO_AUTH_HEADERS,
        body: JSON.stringify({ name: 'X' })
      })
      expect(response.status).toBe(403)
    })

    it('POST - should 409 when slot is already booked', async () => {
      const slotId = 'admin-2030-07-01-2030-07-01T10:00:00.000Z'
      await env.DB.prepare(
        `INSERT INTO appointments (id, name, email, slot_id, date, start_time, end_time, duration, timezone, platform, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          'apt-existing',
          'Existing',
          'someone@example.com',
          slotId,
          '2030-07-01',
          '2030-07-01T10:00:00.000Z',
          '2030-07-01T11:00:00.000Z',
          60,
          'UTC',
          'jitsi',
          'confirmed',
          Date.now(),
          Date.now()
        )
        .run()

      const response = await adminRequest('/contact/api/admin/appointments', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Clash',
          email: 'admin@hadoku.me',
          date: '2030-07-01',
          start_time: '2030-07-01T10:00:00.000Z',
          end_time: '2030-07-01T11:00:00.000Z',
          duration: 60,
          timezone: 'UTC',
          platform: 'jitsi',
          slot_id: slotId
        })
      })
      expect(response.status).toBe(409)
    })

    it('PATCH status - should update appointment status in D1', async () => {
      const response = await adminRequest('/contact/api/admin/appointments/apt-1/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' })
      })

      expect(response.status).toBe(200)

      const row = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?')
        .bind('apt-1')
        .first()
      expect(row!.status).toBe('cancelled')
    })

    it('should require admin authentication', async () => {
      for (const ep of [
        { method: 'GET', path: '/contact/api/admin/appointments' },
        { method: 'PATCH', path: '/contact/api/admin/appointments/apt-1/status' }
      ]) {
        const response = await SELF.fetch(`https://test.com${ep.path}`, {
          method: ep.method,
          headers: NO_AUTH_HEADERS,
          body: ep.method === 'PATCH' ? JSON.stringify({ status: 'confirmed' }) : undefined
        })
        expect(response.status).toBe(403)
      }
    })
  })

  describe('Appointment Configuration', () => {
    it('GET config - should transform DB fields to frontend format', async () => {
      const response = await adminRequest('/contact/api/admin/appointments/config')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ config: Record<string, unknown> }>(result)

      expect(data.config.timezone).toBe('America/Los_Angeles')
      expect(data.config.start_hour).toBe(9)
      expect(data.config.end_hour).toBe(17)
      expect(data.config.available_days).toEqual([1, 2, 3, 4, 5])
      expect(data.config.platforms).toEqual(['discord', 'google', 'teams', 'jitsi'])
      expect(data.config.advance_notice_hours).toBe(24)
      expect(data.config.slot_duration_options).toEqual([15, 30, 60])
      expect(data.config.max_advance_days).toBe(30)
    })

    it('PUT config - should transform frontend fields to DB format', async () => {
      const response = await adminRequest('/contact/api/admin/appointments/config', {
        method: 'PUT',
        body: JSON.stringify({
          timezone: 'America/Los_Angeles',
          start_hour: 8,
          end_hour: 18,
          available_days: [1, 2, 3, 4, 5, 6],
          platforms: ['discord', 'google', 'teams'],
          advance_notice_hours: 48
        })
      })

      expect(response.status).toBe(200)

      // Verify real D1 has database field names
      const row = await env.DB.prepare('SELECT * FROM appointment_config WHERE id = 1').first()
      expect(row!.timezone).toBe('America/Los_Angeles')
      expect(row!.business_hours_start).toBe('08:00')
      expect(row!.business_hours_end).toBe('18:00')
      expect(row!.available_days).toBe('1,2,3,4,5,6')
      expect(row!.meeting_platforms).toBe('discord,google,teams')
      expect(row!.min_advance_hours).toBe(48)
    })

    it('PUT + GET config round-trip should preserve values', async () => {
      await adminRequest('/contact/api/admin/appointments/config', {
        method: 'PUT',
        body: JSON.stringify({
          timezone: 'Europe/London',
          start_hour: 10,
          end_hour: 16,
          available_days: [1, 2, 3],
          platforms: ['discord', 'jitsi'],
          advance_notice_hours: 12
        })
      })

      const response = await adminRequest('/contact/api/admin/appointments/config')
      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<{ config: Record<string, unknown> }>(result)

      expect(data.config.timezone).toBe('Europe/London')
      expect(data.config.start_hour).toBe(10)
      expect(data.config.end_hour).toBe(16)
      expect(data.config.available_days).toEqual([1, 2, 3])
      expect(data.config.platforms).toEqual(['discord', 'jitsi'])
      expect(data.config.advance_notice_hours).toBe(12)
    })
  })

  describe('Statistics Endpoint', () => {
    beforeEach(async () => {
      await env.DB.prepare(
        'INSERT INTO contact_submissions (id, name, email, message, status, created_at, recipient) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind('stat-1', 'User', 'u@e.com', 'Msg', 'unread', Date.now(), 'mw@hadoku.me')
        .run()
      await env.DB.prepare(
        'INSERT INTO contact_submissions (id, name, email, message, status, created_at, recipient) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind('stat-2', 'User', 'u2@e.com', 'Msg', 'read', Date.now(), 'mw@hadoku.me')
        .run()
    })

    it('GET /admin/stats - should return stats from real D1', async () => {
      const response = await adminRequest('/contact/api/admin/stats')

      expect(response.status).toBe(200)
      const result = (await response.json()) as Record<string, unknown>
      const data = unwrapData<Record<string, unknown>>(result)
      expect(data.submissions).toBeDefined()
      expect(data.database).toBeDefined()
    })

    it('should require admin authentication', async () => {
      const response = await SELF.fetch('https://test.com/contact/api/admin/stats', {
        headers: NO_AUTH_HEADERS
      })
      expect(response.status).toBe(403)
    })
  })
})
