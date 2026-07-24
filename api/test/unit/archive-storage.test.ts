/**
 * Archive maintenance tests — pins the fix for the wedged nightly
 * `contact-api:daily-maintenance` job (D1 UNIQUE constraint on
 * contact_submissions_archive.id, observed failing every night 2026-07).
 *
 * Root cause: archiveOldSubmissions copied rows into the archive then deleted
 * them from the source as two SEPARATE, non-atomic D1 statements. If a run was
 * interrupted after the copy but before the delete, the rows stayed in the
 * source; the next run re-inserted ids already in the archive and died on the
 * PRIMARY KEY — throwing before the delete, so it never un-stuck itself. Fix:
 * INSERT OR IGNORE (idempotent) + db.batch() (atomic).
 */
import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { archiveOldSubmissions } from '../../storage'

const DAY = 24 * 60 * 60 * 1000

async function seedActive(id: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO contact_submissions (id, name, email, message, status, created_at)
     VALUES (?, ?, ?, ?, 'unread', ?)`
  )
    .bind(id, 'Name', 'a@example.com', 'hello', createdAt)
    .run()
}

async function seedAppointment(id: string, submissionId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, submission_id, name, email, slot_id, date, start_time, end_time, duration, timezone, platform, created_at, updated_at)
     VALUES (?, ?, 'A', 'a@example.com', ?, '2026-05-01', '2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 30, 'UTC', 'discord', ?, ?)`
  )
    .bind(id, submissionId, `slot-${id}`, Date.now(), Date.now())
    .run()
}

async function count(table: string, id: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe('archiveOldSubmissions', () => {
  beforeEach(async () => {
    // appointments FK -> contact_submissions, so clear children first
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM contact_submissions_archive').run()
  })

  it('archives rows older than the cutoff and leaves recent ones', async () => {
    const old = Date.now() - 40 * DAY
    const recent = Date.now() - 1 * DAY
    await seedActive('old-1', old)
    await seedActive('recent-1', recent)

    const archived = await archiveOldSubmissions(env.DB)

    expect(archived).toBe(1)
    expect(await count('contact_submissions', 'old-1')).toBe(0) // moved out of source
    expect(await count('contact_submissions_archive', 'old-1')).toBe(1) // into archive
    expect(await count('contact_submissions', 'recent-1')).toBe(1) // recent untouched
    expect(await count('contact_submissions_archive', 'recent-1')).toBe(0)
  })

  it('does not archive/delete an old submission still referenced by an appointment (FK-safe)', async () => {
    // Regression for the FOREIGN KEY constraint failure the idempotency fix
    // surfaced: appointments.submission_id -> contact_submissions(id) with no
    // ON DELETE, so deleting a referenced old submission throws. A referenced
    // submission is still in use — it must stay active, not be archived.
    const old = Date.now() - 40 * DAY
    await seedActive('ref-1', old)
    await seedAppointment('appt-1', 'ref-1')
    await seedActive('free-1', old)

    // Must NOT throw, and must archive only the unreferenced old submission.
    await expect(archiveOldSubmissions(env.DB)).resolves.toBe(1)

    // Referenced submission: stays active, NOT archived (integrity preserved).
    expect(await count('contact_submissions', 'ref-1')).toBe(1)
    expect(await count('contact_submissions_archive', 'ref-1')).toBe(0)
    // Unreferenced old submission: archived + removed as normal.
    expect(await count('contact_submissions', 'free-1')).toBe(0)
    expect(await count('contact_submissions_archive', 'free-1')).toBe(1)
  })

  it('self-heals a wedged split-state instead of throwing (the production bug)', async () => {
    const old = Date.now() - 40 * DAY
    // Mimic a prior run that copied the row into the archive but was interrupted
    // before deleting it from the source — the exact state that wedged the job.
    await seedActive('dup-1', old)
    await env.DB.prepare(
      `INSERT INTO contact_submissions_archive
       (id, name, email, message, status, created_at, archived_at)
       VALUES (?, 'Name', 'a@example.com', 'hello', 'unread', ?, ?)`
    )
      .bind('dup-1', old, old)
      .run()

    // Before the fix this threw "UNIQUE constraint failed:
    // contact_submissions_archive.id" and left the source row behind forever.
    await expect(archiveOldSubmissions(env.DB)).resolves.toBeTypeOf('number')

    // The stale source row is finally cleared — the job un-stuck itself...
    expect(await count('contact_submissions', 'dup-1')).toBe(0)
    // ...and the archive still holds exactly one copy (no duplicate, no loss).
    expect(await count('contact_submissions_archive', 'dup-1')).toBe(1)
  })

  it('is idempotent across repeated runs', async () => {
    const old = Date.now() - 40 * DAY
    await seedActive('a', old)
    await seedActive('b', old)

    await expect(archiveOldSubmissions(env.DB)).resolves.toBe(2)
    // Second run has nothing new to archive and must not throw.
    await expect(archiveOldSubmissions(env.DB)).resolves.toBe(0)
    expect(await count('contact_submissions_archive', 'a')).toBe(1)
    expect(await count('contact_submissions_archive', 'b')).toBe(1)
  })
})
