/**
 * Meeting Platform Integration Tests
 *
 * Pins down the *actual* behavior of each meeting platform on /submit:
 *   - discord: returns a static invite (works)
 *   - jitsi:   constructs a meet.jit.si room URL (works)
 *   - google:  Google Calendar API call — falls back when OAuth not configured
 *              (full mock path covered in unit tests for createGoogleMeetEvent)
 *   - teams:   removed from VALID_PLATFORMS — bookings rejected by validation
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

function futureDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2)
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

  describe('Discord (static invite)', () => {
    it('stores a Discord invite URL on the appointment', async () => {
      const { response, slotId } = await bookWithPlatform('discord', 10)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string; meeting_id: string; platform: string }>()

      expect(apt!.platform).toBe('discord')
      expect(apt!.meeting_link).toMatch(/^https:\/\/discord\.gg\//)
      expect(apt!.meeting_id).toMatch(/^discord-/)
    })
    // DISCORD_INVITE_URL taking precedence is pinned in
    // api/test/unit/meeting-links.test.ts — SELF.fetch runs the worker with the
    // bindings from wrangler.test.toml, so mutating `env` here does not reach it.
  })

  describe('Jitsi (URL construction)', () => {
    it('constructs a meet.jit.si room URL', async () => {
      const { response, slotId } = await bookWithPlatform('jitsi', 11)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string; meeting_id: string }>()

      expect(apt!.meeting_link).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-[0-9a-z]+$/)
      expect(apt!.meeting_id).toBe(apt!.meeting_link.split('/').pop())
    })

    // The room is the whole access control on meet.jit.si, and slot ids are
    // published by the public GET /appointments/slots listing. A room derived
    // from one is a room any reader of the calendar can walk into.
    it('does not derive the room from the slot id', async () => {
      const { response, slotId } = await bookWithPlatform('jitsi', 13)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string }>()

      expect(apt!.meeting_link).not.toContain(slotId)
      // The date is the coarsest thing the slot id leaks; not even that.
      expect(apt!.meeting_link).not.toContain(slotId.slice(5, 15))
    })

    it('gives two bookings of the same slot different rooms', async () => {
      const first = await bookWithPlatform('jitsi', 15, 'a-jitsi@example.com')
      expect(first.response.status).toBe(201)

      await env.DB.prepare('DELETE FROM appointments WHERE slot_id = ?').bind(first.slotId).run()
      const keys = await env.RATE_LIMIT_KV.list()
      for (const key of keys.keys) await env.RATE_LIMIT_KV.delete(key.name)

      const second = await bookWithPlatform('jitsi', 15, 'b-jitsi@example.com')
      expect(second.response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT meeting_link FROM appointments WHERE slot_id = ?')
        .bind(second.slotId)
        .first<{ meeting_link: string }>()

      expect(apt!.meeting_link).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-[0-9a-z]+$/)
      expect(apt!.meeting_link).not.toBe(
        (await first.response.clone().json<{ meetingLink?: string }>()).meetingLink
      )
    })
  })

  describe('/submit response carries the link', () => {
    // The browser has no other route to it: the confirmation email is the only
    // other copy, and it is the one that can be delayed or filtered.
    it('returns meetingLink alongside the booking', async () => {
      const { response } = await bookWithPlatform('jitsi', 16)
      expect(response.status).toBe(201)

      const body = await response.json<{ meetingLink?: string; appointmentId?: string }>()
      expect(body.appointmentId).toBeTruthy()
      expect(body.meetingLink).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-/)
    })
  })

  describe('Google Meet (Calendar API failure path)', () => {
    beforeEach(() => {
      fetchMock.activate()
      fetchMock.disableNetConnect()
    })
    afterEach(() => {
      fetchMock.deactivate()
    })

    it('booking succeeds with meeting_link=null when OAuth fails', async () => {
      // Simulate Google OAuth refusing the refresh token (e.g., revoked).
      fetchMock
        .get('https://oauth2.googleapis.com')
        .intercept({ path: '/token', method: 'POST' })
        .reply(401, 'invalid_grant')

      const { response, slotId } = await bookWithPlatform('google', 12)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string | null; platform: string }>()

      expect(apt!.platform).toBe('google')
      expect(apt!.meeting_link).toBeNull()
    })
  })

  describe('Teams (rejected — not in VALID_PLATFORMS)', () => {
    it('rejects teams platform on /submit with 400', async () => {
      const { response } = await bookWithPlatform('teams', 14)
      expect(response.status).toBe(400)

      const apts = await env.DB.prepare('SELECT * FROM appointments').all()
      expect(apts.results).toHaveLength(0)
    })
  })
})
