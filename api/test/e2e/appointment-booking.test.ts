/**
 * Appointment Booking Integration Tests
 *
 * Tests the full appointment booking flow against real D1:
 * - POST /contact/api/submit with appointment data
 * - Slot availability validation
 * - Double-booking prevention
 * - Meeting link generation
 * - Platform validation
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

/** Get a date N days from now, formatted as YYYY-MM-DD */
function futureDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

/** Build an appointment submission request */
async function bookAppointment(opts: {
  name: string
  email: string
  date: string
  startHour: number
  duration?: number
  platform?: string
  ip?: string
}) {
  const {
    name,
    email,
    date,
    startHour,
    duration = 30,
    platform = 'discord',
    ip = '203.0.113.1'
  } = opts
  const startTime = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00.000Z`)
  const endTime = new Date(startTime.getTime() + duration * 60 * 1000)
  const slotId = `slot-${date}-${startTime.toISOString()}`

  return SELF.fetch('https://test.com/contact/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      Referer: 'https://hadoku.me/contact'
    },
    body: JSON.stringify({
      name,
      email,
      message: 'Meeting request',
      recipient: 'matthaeus@hadoku.me',
      appointment: {
        slotId,
        date,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
        platform
      }
    })
  })
}

describe('Appointment Booking Integration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()

    // Reset config to known state
    await env.DB.prepare(
      `UPDATE appointment_config SET
				timezone = 'America/New_York',
				business_hours_start = '09:00',
				business_hours_end = '17:00',
				available_days = '1,2,3,4,5',
				slot_duration_options = '15,30,60',
				max_advance_days = 30,
				min_advance_hours = 24,
				meeting_platforms = 'discord,google,teams,jitsi'
			WHERE id = 1`
    ).run()

    // Clear rate limits
    const keys = await env.RATE_LIMIT_KV.list()
    for (const key of keys.keys) {
      await env.RATE_LIMIT_KV.delete(key.name)
    }
  })

  describe('POST /contact/api/submit - Appointment Booking', () => {
    it('should create appointment in D1 with valid data', async () => {
      const date = futureDate(3)
      const response = await bookAppointment({
        name: 'John Doe',
        email: 'john@example.com',
        date,
        startHour: 14
      })

      expect(response.status).toBe(201)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.message).toContain('appointment')

      // Verify in real D1
      const { results: submissions } = await env.DB.prepare(
        'SELECT * FROM contact_submissions'
      ).all()
      expect(submissions).toHaveLength(1)
      expect(submissions[0].email).toBe('john@example.com')

      const { results: appointments } = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(appointments).toHaveLength(1)
      expect(appointments[0].name).toBe('John Doe')
      expect(appointments[0].email).toBe('john@example.com')
      expect(appointments[0].date).toBe(date)
      expect(appointments[0].duration).toBe(30)
      expect(appointments[0].platform).toBe('discord')
      expect(appointments[0].meeting_link).toBeDefined()
    })

    it('should handle multiple appointments on different days', async () => {
      const dates = [futureDate(2), futureDate(3), futureDate(4)]

      for (let i = 0; i < dates.length; i++) {
        const response = await bookAppointment({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          date: dates[i],
          startHour: 14
        })
        expect(response.status).toBe(201)
      }

      const { results } = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(results).toHaveLength(3)
      expect(new Set(results.map(a => a.date)).size).toBe(3)
    })
  })

  describe('Slot Availability', () => {
    it('should prevent double-booking same time slot', async () => {
      const date = futureDate(3)

      // First booking
      const r1 = await bookAppointment({
        name: 'User One',
        email: 'user1@example.com',
        date,
        startHour: 14
      })
      expect(r1.status).toBe(201)

      // Same slot — should fail
      const r2 = await bookAppointment({
        name: 'User Two',
        email: 'user2@example.com',
        date,
        startHour: 14,
        ip: '203.0.113.2'
      })

      expect(r2.status).toBe(409)
      const data = (await r2.json()) as Record<string, unknown>
      expect(data.message).toContain('booked')

      // Only one appointment in D1
      const { results } = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(results).toHaveLength(1)
      expect(results[0].email).toBe('user1@example.com')
    })

    it('should allow different time slots on same day', async () => {
      const date = futureDate(3)

      const r1 = await bookAppointment({
        name: 'User One',
        email: 'user1@example.com',
        date,
        startHour: 10
      })
      expect(r1.status).toBe(201)

      const r2 = await bookAppointment({
        name: 'User Two',
        email: 'user2@example.com',
        date,
        startHour: 14,
        ip: '203.0.113.2'
      })
      expect(r2.status).toBe(201)

      const { results } = await env.DB.prepare(
        'SELECT * FROM appointments ORDER BY start_time'
      ).all()
      expect(results).toHaveLength(2)
    })
  })

  describe('Platform Validation', () => {
    it('should accept valid platforms', async () => {
      const date = futureDate(3)
      const platforms = ['discord', 'jitsi', 'google']

      for (let i = 0; i < platforms.length; i++) {
        const response = await bookAppointment({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          date,
          startHour: 10 + i,
          platform: platforms[i]
        })
        expect(response.status).toBe(201)
      }

      const { results } = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(results).toHaveLength(platforms.length)
    })

    it('should reject teams platform (no longer bookable)', async () => {
      const response = await bookAppointment({
        name: 'Teams User',
        email: 'teams@example.com',
        date: futureDate(3),
        startHour: 14,
        platform: 'teams'
      })
      expect(response.status).toBe(400)
    })

    it('should reject invalid platform', async () => {
      const date = futureDate(3)
      const response = await bookAppointment({
        name: 'Invalid User',
        email: 'invalid@example.com',
        date,
        startHour: 14,
        platform: 'skype'
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: unknown[] }
      expect(data.errors).toBeDefined()

      const { results } = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(results).toHaveLength(0)
    })
  })
})
