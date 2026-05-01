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
  })

  describe('Jitsi (URL construction)', () => {
    it('constructs a meet.jit.si room URL deterministic on slot_id', async () => {
      const { response, slotId } = await bookWithPlatform('jitsi', 11)
      expect(response.status).toBe(201)

      const apt = await env.DB.prepare('SELECT * FROM appointments WHERE slot_id = ?')
        .bind(slotId)
        .first<{ meeting_link: string; meeting_id: string }>()

      expect(apt!.meeting_link).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-/)
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
