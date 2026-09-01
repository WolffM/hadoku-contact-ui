/**
 * The Google Calendar credential canary in daily maintenance.
 *
 * The failure it exists to catch is a QUIET one: a dead refresh token does not
 * break a booking. The booking still 201s, the confirmation still sends, the
 * admin row still looks complete — only `meeting_link` is null, in a column no
 * view renders. That is exactly how the feature shipped in v1.1.9 and produced
 * nothing for months without anyone noticing.
 *
 * So the canary's contract has three parts, and all three are pinned here:
 *   1. a dead credential FAILS the job (the only path that pages a human)
 *   2. the retention steps still ran first (a dead token costs no archiving)
 *   3. an unconfigured deployment is not a failure
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const CRON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'service'
}

async function runDaily() {
  return SELF.fetch('https://test.com/contact/api/internal/run-daily', {
    method: 'POST',
    headers: CRON_HEADERS
  })
}

/** A submission old enough that archiveOldSubmissions must move it. */
async function seedArchivableSubmission(id: string) {
  const longAgo = Date.now() - 400 * 24 * 60 * 60 * 1000
  // No updated_at column on this table — created_at is the only clock.
  await env.DB.prepare(
    `INSERT INTO contact_submissions (id, name, email, message, status, created_at)
     VALUES (?, 'Old Row', 'old@example.com', 'archive me', 'read', ?)`
  )
    .bind(id, longAgo)
    .run()
}

describe('daily maintenance — Google credential canary', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('fails the job when the refresh token is dead', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_grant' }))

    const res = await runDaily()

    expect(res.status).toBe(500)
    const body = await res.json<{ success: boolean; error: string }>()
    expect(body.success).toBe(false)
    // The alert is titled with the JOB, so the message is the only thing that
    // says which step broke. It must not read as a broken purge.
    expect(body.error).toContain('Google Calendar credential is dead')
    expect(body.error).toContain('retention steps all succeeded')
  })

  // Ordering is the whole reason the canary sits last. If it threw first, one
  // dead credential would silently stop archiving and purging every night.
  it('still completes the retention work before failing', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_grant' }))

    await seedArchivableSubmission('canary-archivable')

    const res = await runDaily()
    expect(res.status).toBe(500)

    // Archiving MOVES the row: copy into contact_submissions_archive, then
    // delete from the source, both in one db.batch(). So "archived" means gone
    // from here and present there — not a status flip.
    const source = await env.DB.prepare('SELECT id FROM contact_submissions WHERE id = ?')
      .bind('canary-archivable')
      .first()
    const archived = await env.DB.prepare('SELECT id FROM contact_submissions_archive WHERE id = ?')
      .bind('canary-archivable')
      .first()

    expect(source).toBeNull()
    expect(archived).not.toBeNull()
  })

  it('passes the job when the token still exchanges', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, JSON.stringify({ access_token: 'ok', expires_in: 3599, token_type: 'Bearer' }))

    const res = await runDaily()

    expect(res.status).toBe(200)
    const body = await res.json<{ success: boolean }>()
    expect(body.success).toBe(true)
  })

  // The unconfigured-deployment case is pinned in
  // api/test/unit/credential-check.test.ts — SELF.fetch runs the worker against
  // the bindings in wrangler.test.toml, so unsetting them on `env` here does
  // not reach it.
})
