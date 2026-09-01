/**
 * Database capacity reporting.
 *
 * The bug these pin: getDatabaseSize ran `PRAGMA page_count` / `PRAGMA
 * page_size`, D1 refuses PRAGMA with `SQLITE_AUTH`, the catch swallowed it, and
 * the function returned a hardcoded zero. Capacity read `0.0% (0.00 MB)` on
 * every nightly run and every /admin/stats response, `warning` was permanently
 * false, and the alarm could not fire however full the database got.
 *
 * So the assertions that matter are not "does it return a number" but "is the
 * number real, and is a failed read distinguishable from an empty database".
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { getDatabaseSize } from '../../storage'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

describe('getDatabaseSize', () => {
  it('reports a real, non-zero size', async () => {
    const size = await getDatabaseSize(env.DB)

    expect(size.available).toBe(true)
    // The regression was a hardcoded 0. A migrated D1 always has pages.
    expect(size.sizeBytes).toBeGreaterThan(0)
    expect(Number.isFinite(size.percentUsed)).toBe(true)
    expect(size.percentUsed).toBeGreaterThan(0)
  })

  it('does not throw on PRAGMA — it must not use PRAGMA at all', async () => {
    // D1 answers PRAGMA with `not authorized: SQLITE_AUTH`. If the
    // implementation regresses to one, this call still resolves (the catch is
    // still there) but `available` goes false and the size collapses to 0 —
    // which the first test would catch. This one documents the constraint.
    await expect(env.DB.prepare('PRAGMA page_count').run()).rejects.toThrow()
  })

  it('tracks growth after a write', async () => {
    const before = await getDatabaseSize(env.DB)

    const rows = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO contact_submissions (id, name, email, message, status, created_at)
         VALUES (?, 'Bulk', 'bulk@example.com', ?, 'unread', ?)`
      ).bind(`cap-${i}`, 'x'.repeat(400), Date.now())
    )
    await env.DB.batch(rows)

    const after = await getDatabaseSize(env.DB)

    // A real measurement moves when the database grows; the old hardcoded zero
    // could not.
    expect(after.sizeBytes).toBeGreaterThan(before.sizeBytes)

    await env.DB.prepare("DELETE FROM contact_submissions WHERE id LIKE 'cap-%'").run()
  })

  it('stays below the warning threshold for a small database', async () => {
    const size = await getDatabaseSize(env.DB)
    expect(size.warning).toBe(false)
  })
})

describe('GET /admin/stats — database block', () => {
  it('returns a real size rather than a fabricated zero', async () => {
    const res = await SELF.fetch('https://test.com/contact/api/admin/stats', {
      headers: ADMIN_HEADERS
    })

    expect(res.status).toBe(200)
    const body = await res.json<{
      data: {
        database: {
          available: boolean
          sizeBytes: number | null
          sizeMB: string | null
          percentUsed: string | null
        }
      }
    }>()

    const db = body.data.database
    expect(db.available).toBe(true)
    // sizeBytes is the assertion that matters: it was a hardcoded 0.
    expect(db.sizeBytes).toBeGreaterThan(0)
    // percentUsed is NOT asserted non-zero. A small database really is ~0% of
    // the free tier, and `.toFixed(2)` rounds it to "0.00" honestly — that
    // string was never the bug, the fabricated byte count was.
    expect(Number.isFinite(Number(db.percentUsed))).toBe(true)
    expect(Number.isFinite(Number(db.sizeMB))).toBe(true)
  })
})
