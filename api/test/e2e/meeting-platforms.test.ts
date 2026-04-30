/**
 * Meeting Platform Integration Tests
 *
 * Pins down the *actual* behavior of each meeting platform on booking:
 *   - discord: returns a static invite (works)
 *   - jitsi:   constructs a meet.jit.si room URL (works)
 *   - google:  no implementation; meeting_link is null
 *   - teams:   no implementation; meeting_link is null
 *
 * No external calendar event is created on any platform.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

function futureDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  // Skip weekends — default config disallows them
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  return d.toISOString().split('T')[0]
}

async function bookWithPlatform(
  platform: string,
  hour: number,
  email = `t-${platform}@example.com`
) {
  const date = futureDate(3)
  const startTime = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`)
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000)
  const slotId = `slot-${date}-${startTime.toISOString()}`

  const response = await SELF.fetch('https://test.com/contact/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `203.0.113.${hour}`,
      Referer: 'https://hadoku.me/contact'
    },
    body: JSON.stringify({
      name: `Test ${platform}`,
      email,
      message: 'Booking via ' + platform,
      recipient: 'matthaeus@hadoku.me',
      appointment: {
        slotId,
        date,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration: 30,
        platform
      }
    })
  })

  return { response, slotId, date }
}

describe('Meeting Platform Integration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    const keys = await env.RATE_LIMIT_KV.list()
    for (const key of keys.keys) await env.RATE_LIMIT_KV.delete(key.name)
  })

  describe('Discord (works — static invite)', () => {
    it('stores a Discord invite URL on the appointment', async () => {
      const { response, slotId } = await bookWithPlatform('discord', 10)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string; meeting_id: string; platform: string }>()

      expect(apt).not.toBeNull()
      expect(apt!.platform).toBe('discord')
      expect(apt!.meeting_link).toMatch(/^https:\/\/discord\.gg\//)
      expect(apt!.meeting_id).toMatch(/^discord-/)
    })
  })

  describe('Jitsi (works — URL construction)', () => {
    it('constructs a meet.jit.si room URL deterministic on slot_id', async () => {
      const { response, slotId } = await bookWithPlatform('jitsi', 11)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string; meeting_id: string }>()

      expect(apt!.meeting_link).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-/)
      expect(apt!.meeting_id).toMatch(/^hadoku-/)
    })
  })

  describe('Google Meet (NOT implemented)', () => {
    it('booking succeeds but stores NO meeting_link', async () => {
      const { response, slotId } = await bookWithPlatform('google', 12)
      // Booking still goes through — only the link generation fails silently
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string | null; meeting_id: string | null }>()

      expect(apt).not.toBeNull()
      expect(apt!.meeting_link).toBeNull()
      expect(apt!.meeting_id).toBeNull()
    })

    it('response does not include a usable meetingLink for Google', async () => {
      const { response } = await bookWithPlatform('google', 13)
      const data = (await response.json()) as { meetingLink?: string }
      // The submit handler only sets meetingLink when generation succeeded
      expect(data.meetingLink).toBeUndefined()
    })
  })

  describe('Teams (NOT implemented)', () => {
    it('booking succeeds but stores NO meeting_link', async () => {
      const { response, slotId } = await bookWithPlatform('teams', 14)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string | null; meeting_id: string | null }>()

      expect(apt!.meeting_link).toBeNull()
      expect(apt!.meeting_id).toBeNull()
    })
  })

  describe('No external calendar event is created (by design — gap to flag)', () => {
    it('appointment is stored only in D1; no calendar/event id from external source', async () => {
      const { response, slotId } = await bookWithPlatform('jitsi', 15)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_id: string }>()

      // meeting_id starts with 'hadoku-' (locally generated room name) —
      // never an external calendar/event id like a Google event id or Teams onlineMeeting id.
      expect(apt!.meeting_id.startsWith('hadoku-')).toBe(true)
      // (No appointment table column references an external calendar provider.)
    })
  })
})
