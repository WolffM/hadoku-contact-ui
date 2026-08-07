/**
 * Contact submission storage operations
 */

import { RETENTION_CONFIG, PAGINATION_DEFAULTS } from '../constants'

export interface StoredSubmission {
  id: string
  name: string
  email: string
  message: string
  status: 'unread' | 'read' | 'archived' | 'deleted'
  created_at: number
  deleted_at: number | null
  ip_address: string | null
  user_agent: string | null
  referrer: string | null
  recipient: string | null
  direction: 'inbound' | 'outbound'
  /** Resend's id for the received email. NULL for web-form and outbound rows. */
  resend_email_id: string | null
  /**
   * Non-NULL means the mail was quarantined rather than accepted into the
   * inbox. It is still a real, readable row — the point is that nothing is
   * silently discarded any more.
   */
  filtered_reason: string | null
}

/**
 * Why a mail was quarantined instead of accepted.
 *
 * Only one reason today. Retrieval failures are deliberately NOT a reason:
 * a mail whose body we could not fetch is left unledgered so the next sweep
 * retries it with a real body, rather than being frozen as a permanent stub.
 */
export type FilteredReason = 'not_whitelisted'

export interface CreateSubmissionParams {
  name: string
  email: string
  message: string
  ip_address: string | null
  user_agent: string | null
  referrer: string | null
  recipient?: string | null
  direction?: 'inbound' | 'outbound'
  resend_email_id?: string | null
  filtered_reason?: FilteredReason | null
  /** Overrides the direction-derived default. Used to backfill old mail as read. */
  status?: 'unread' | 'read'
}

export interface SubmissionStats {
  total: number
  unread: number
  read: number
  archived: number
  deleted: number
}

export async function createSubmission(
  db: D1Database,
  params: CreateSubmissionParams
): Promise<StoredSubmission> {
  const id = (globalThis.crypto as { randomUUID: () => string }).randomUUID()
  const created_at = Date.now()

  const direction = params.direction ?? 'inbound'
  const status = params.status ?? (direction === 'outbound' ? 'read' : 'unread')

  await db
    .prepare(
      `INSERT INTO contact_submissions
			(id, name, email, message, status, created_at, ip_address, user_agent, referrer, recipient, direction, resend_email_id, filtered_reason)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      params.name,
      params.email,
      params.message,
      status,
      created_at,
      params.ip_address,
      params.user_agent,
      params.referrer,
      params.recipient ?? null,
      direction,
      params.resend_email_id ?? null,
      params.filtered_reason ?? null
    )
    .run()

  const result: StoredSubmission = {
    id,
    name: params.name,
    email: params.email,
    message: params.message,
    status,
    created_at,
    ip_address: params.ip_address,
    user_agent: params.user_agent,
    referrer: params.referrer,
    recipient: params.recipient ?? null,
    deleted_at: null,
    direction,
    resend_email_id: params.resend_email_id ?? null,
    filtered_reason: params.filtered_reason ?? null
  }

  return result
}

/**
 * Stamp a Resend id onto a submission the webhook stored BEFORE this column
 * existed, instead of inserting a duplicate.
 *
 * Without this, the first reconciliation sweep would re-ingest every email the
 * webhook had already handled — the user would open the command station and
 * find two of everything from the last 30 days. Inbound rows are written by
 * the webhook with a known shape (`email` = the cleaned sender, `recipient` =
 * the destination mailbox, `message` = `Subject: {subject}\n\n{body}`), so
 * that triple identifies the row precisely enough to adopt it.
 *
 * Only ever touches a row whose resend_email_id IS NULL, so a correctly
 * stamped row can never be re-pointed at a different email.
 *
 * Returns the adopted submission id, or null if there was nothing to adopt.
 */
export async function adoptSubmissionForResendId(
  db: D1Database,
  params: { resendEmailId: string; email: string; recipient: string | null; subject: string }
): Promise<string | null> {
  const candidate = await db
    .prepare(
      `SELECT id FROM contact_submissions
			WHERE resend_email_id IS NULL
				AND direction = 'inbound'
				AND email = ?
				AND recipient IS ?
				AND message LIKE ? ESCAPE '\\'
			ORDER BY created_at DESC
			LIMIT 1`
    )
    .bind(params.email, params.recipient, `${escapeLike(`Subject: ${params.subject}`)}%`)
    .first<{ id: string }>()

  if (!candidate) return null

  // The WHERE clause repeats `resend_email_id IS NULL`: between the SELECT and
  // this UPDATE a concurrent sweep could have claimed the same row, and D1
  // gives us no transaction spanning the two.
  const updated = await db
    .prepare(
      `UPDATE contact_submissions SET resend_email_id = ?
			WHERE id = ? AND resend_email_id IS NULL`
    )
    .bind(params.resendEmailId, candidate.id)
    .run()

  return (updated.meta?.changes ?? 0) > 0 ? candidate.id : null
}

/** LIKE treats % and _ as wildcards; a subject containing either would match too much. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

export async function getAllSubmissions(
  db: D1Database,
  limit = PAGINATION_DEFAULTS.LIMIT,
  offset = PAGINATION_DEFAULTS.OFFSET,
  includeDeleted = false
): Promise<StoredSubmission[]> {
  const whereClause = includeDeleted ? '' : `WHERE status != 'deleted'`
  const result = await db
    .prepare(
      `SELECT * FROM contact_submissions
			${whereClause}
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<StoredSubmission>()

  return result.results ?? []
}

export async function getSubmissionById(
  db: D1Database,
  id: string
): Promise<StoredSubmission | null> {
  const result = await db
    .prepare(`SELECT * FROM contact_submissions WHERE id = ?`)
    .bind(id)
    .first<StoredSubmission>()

  return result
}

export async function updateSubmissionStatus(
  db: D1Database,
  id: string,
  status: 'unread' | 'read' | 'archived'
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE contact_submissions SET status = ? WHERE id = ?`)
    .bind(status, id)
    .run()

  return result.success
}

export async function deleteSubmission(db: D1Database, id: string): Promise<boolean> {
  const deleted_at = Date.now()
  const result = await db
    .prepare(`UPDATE contact_submissions SET status = 'deleted', deleted_at = ? WHERE id = ?`)
    .bind(deleted_at, id)
    .run()

  return result.success
}

export async function restoreSubmission(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE contact_submissions SET status = 'unread', deleted_at = NULL WHERE id = ?`)
    .bind(id)
    .run()

  return result.success
}

export async function purgeOldDeletedSubmissions(db: D1Database): Promise<number> {
  const retentionMs = RETENTION_CONFIG.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const cutoffTime = Date.now() - retentionMs

  // Same FK guard as archiveOldSubmissions: a soft-deleted submission an
  // appointment still references cannot be hard-deleted (appointments.submission_id
  // FK, no ON DELETE) — skip it until that appointment is gone, or the purge throws
  // FOREIGN KEY constraint and daily-maintenance fails. IS NOT NULL: a NULL in a
  // NOT IN set voids the predicate.
  const result = await db
    .prepare(
      `DELETE FROM contact_submissions
       WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?
         AND id NOT IN (SELECT submission_id FROM appointments WHERE submission_id IS NOT NULL)`
    )
    .bind(cutoffTime)
    .run()

  return result.meta?.changes ?? 0
}

export async function getSubmissionStats(db: D1Database): Promise<SubmissionStats> {
  const result = await db
    .prepare(
      `SELECT
				SUM(CASE WHEN status != 'deleted' THEN 1 ELSE 0 END) as total,
				SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) as unread,
				SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) as read,
				SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
				SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) as deleted
			FROM contact_submissions`
    )
    .first<SubmissionStats>()

  return result ?? { total: 0, unread: 0, read: 0, archived: 0, deleted: 0 }
}

export async function archiveOldSubmissions(
  db: D1Database,
  daysOld = RETENTION_CONFIG.ARCHIVE_AFTER_DAYS
): Promise<number> {
  const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000
  const archivedAt = Date.now()

  // The copy-then-delete must be BOTH idempotent and atomic. D1 auto-commits each
  // statement, so a plain INSERT followed by a separate DELETE can leave rows
  // copied into the archive but NOT removed from the source if the run is
  // interrupted between them (dispatch timeout, worker eviction, a later step
  // throwing). On the next run those rows still satisfy `created_at < cutoff`, the
  // INSERT re-inserts ids already in the archive, and it dies on the archive's
  // `id TEXT PRIMARY KEY` — a UNIQUE failure that throws before the DELETE runs, so
  // the rows never leave the source and every subsequent night fails identically.
  // (Masked for months by the old error-swallowing handler; the execution-log
  // unification surfaced it 2026-07.) INSERT OR IGNORE makes the copy idempotent
  // (an already-archived id is skipped, not an error, so a wedged split-state
  // self-heals next run); db.batch() runs copy + delete as one transaction so they
  // can never split again.
  //
  // `appointments.submission_id` is a FK -> contact_submissions(id) with no ON DELETE
  // clause, so deleting an old submission a booked appointment still references fails
  // with FOREIGN KEY constraint. (The old code never hit this — it died at the INSERT
  // above first; fixing that surfaced the delete.) Exclude referenced submissions from
  // BOTH the copy and the delete: a submission an appointment points at is still in
  // use, so it stays active until that appointment is gone — never orphaned, never
  // half-archived. The `IS NOT NULL` guard is required: a NULL in a NOT IN set makes
  // the whole predicate unknown (nothing matches).
  const notReferenced =
    'id NOT IN (SELECT submission_id FROM appointments WHERE submission_id IS NOT NULL)'
  const [copyResult] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO contact_submissions_archive
			(id, name, email, message, status, created_at, archived_at, ip_address, user_agent, referrer)
			SELECT id, name, email, message, status, created_at, ?, ip_address, user_agent, referrer
			FROM contact_submissions
			WHERE created_at < ? AND ${notReferenced}`
      )
      .bind(archivedAt, cutoffTime),
    db
      .prepare(`DELETE FROM contact_submissions WHERE created_at < ? AND ${notReferenced}`)
      .bind(cutoffTime)
  ])

  return copyResult.meta?.changes ?? 0
}
