/**
 * The admin/service tier split.
 *
 * Rationale and the admission rule live in CLAUDE.md, "Admin and service
 * surfaces". This file is the executable half: it pins the boundary in both
 * directions so a later route cannot drift onto the service side unnoticed.
 *
 * Note these tests exercise the WORKER gate only. Edge-router gates by prefix
 * ahead of it and is not in the loop here, so a green run does not prove a
 * route is reachable in production — that needs the matching rule in
 * ../hadoku_site/workers/edge-router/src/route-tiers.ts.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

const SERVICE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'service'
}

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

const FRIEND_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'friend'
}

const APPT_ID = 'tier-split-appointment'

async function seedAppointment() {
  // created_at/updated_at are INTEGER NOT NULL — epoch millis, not a datetime
  // string. Passing datetime('now') inserts a string and the NOT NULL on
  // updated_at rejects the row outright.
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, submission_id, name, email, message, slot_id, date, start_time, end_time,
        duration, timezone, platform, meeting_link, meeting_id, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1788000000000, 1788000000000)`
  )
    .bind(
      APPT_ID,
      // NULL, not a made-up id — submission_id carries an FK to
      // contact_submissions, and the column is nullable precisely for
      // appointments that did not come from a contact-form submission.
      null,
      'Tier Split',
      'tier@example.com',
      'seed',
      'slot-tier-split',
      '2026-09-15',
      '2026-09-15T17:00:00.000Z',
      '2026-09-15T17:30:00.000Z',
      30,
      'America/Los_Angeles',
      'jitsi',
      'https://meet.jit.si/hadoku-seed',
      'hadoku-seed'
    )
    .run()
}

describe('/admin tier split', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await seedAppointment()
  })

  describe('the one route that was lowered', () => {
    it('lets a SERVICE key cancel an appointment', async () => {
      const res = await SELF.fetch(
        `https://test.com/contact/api/service/appointments/${APPT_ID}/status`,
        {
          method: 'PATCH',
          headers: SERVICE_HEADERS,
          body: JSON.stringify({ status: 'cancelled' })
        }
      )

      expect(res.status).toBe(200)

      const row = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?')
        .bind(APPT_ID)
        .first<{ status: string }>()
      expect(row!.status).toBe('cancelled')
    })

    it('still lets an ADMIN key use it', async () => {
      const res = await SELF.fetch(
        `https://test.com/contact/api/admin/appointments/${APPT_ID}/status`,
        {
          method: 'PATCH',
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ status: 'completed' })
        }
      )

      expect(res.status).toBe(200)
    })

    // Service is rank 2; friend is 1. Lowering the gate must not open it.
    it('refuses a FRIEND key', async () => {
      const res = await SELF.fetch(
        `https://test.com/contact/api/service/appointments/${APPT_ID}/status`,
        {
          method: 'PATCH',
          headers: FRIEND_HEADERS,
          body: JSON.stringify({ status: 'cancelled' })
        }
      )

      expect(res.status).toBe(403)

      const row = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?')
        .bind(APPT_ID)
        .first<{ status: string }>()
      expect(row!.status).toBe('confirmed')
    })

    // Same handler, two mounts, two tiers. The /admin mount must NOT inherit
    // the lower gate — otherwise the split is cosmetic and lowering the edge
    // rule for /contact/api/admin would be enough to reach it.
    it('refuses a SERVICE key on the ADMIN mount of the same handler', async () => {
      const res = await SELF.fetch(
        `https://test.com/contact/api/admin/appointments/${APPT_ID}/status`,
        {
          method: 'PATCH',
          headers: SERVICE_HEADERS,
          body: JSON.stringify({ status: 'cancelled' })
        }
      )

      expect(res.status).toBe(403)

      const row = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?')
        .bind(APPT_ID)
        .first<{ status: string }>()
      expect(row!.status).toBe('confirmed')
    })

    it('still validates the status value', async () => {
      const res = await SELF.fetch(
        `https://test.com/contact/api/service/appointments/${APPT_ID}/status`,
        {
          method: 'PATCH',
          headers: SERVICE_HEADERS,
          body: JSON.stringify({ status: 'deleted' })
        }
      )

      expect(res.status).toBe(400)
    })
  })

  // The point of the split. A service key must not reach anything that returns
  // submission contents or sends mail.
  describe('everything else stays admin-only', () => {
    const serviceForbidden: [string, string, string | undefined][] = [
      ['GET', '/contact/api/admin/submissions', undefined],
      ['GET', '/contact/api/admin/stats', undefined],
      ['GET', '/contact/api/admin/appointments', undefined],
      ['GET', `/contact/api/admin/appointments/${APPT_ID}`, undefined],
      ['GET', '/contact/api/admin/whitelist', undefined],
      ['GET', '/contact/api/admin/blocklist', undefined],
      ['GET', '/contact/api/admin/appointments/config', undefined],
      ['POST', '/contact/api/admin/send-email', JSON.stringify({ to: 'x@example.com' })]
    ]

    it.each(serviceForbidden)('refuses a SERVICE key on %s %s', async (method, path, body) => {
      const res = await SELF.fetch(`https://test.com${path}`, {
        method,
        headers: SERVICE_HEADERS,
        ...(body ? { body } : {})
      })

      expect(res.status).toBe(403)
    })

    it('a SERVICE key cannot read a submission body through the list endpoint', async () => {
      const res = await SELF.fetch('https://test.com/contact/api/admin/submissions', {
        headers: SERVICE_HEADERS
      })

      expect(res.status).toBe(403)
      const text = await res.text()
      expect(text).not.toContain('tier@example.com')
    })
  })
})
