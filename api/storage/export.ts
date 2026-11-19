/**
 * The mailbox export: every stored row, oldest first, for a second copy kept
 * outside this database.
 *
 * It reads BOTH tables and applies no state filter. The mail screen hides
 * trashed, quarantined and archived rows, and the retention sweeps then destroy
 * or thin them: trash after `DELETED_RETENTION_DAYS`, spam after
 * `SPAM_RETENTION_DAYS`, and anything older than `ARCHIVE_AFTER_DAYS` loses
 * `recipient`, `direction`, `filtered_reason` and `resend_email_id` on its way
 * into the archive. A copy taken before those run is the only complete record,
 * so the export hands out a row in whatever state it is in.
 *
 * Ordering is the same `(created_at, id)` tuple the mail feed pages on, and
 * `created_at` is this database's clock at insert, so a consumer that keeps its
 * last cursor sees every later insert.
 */

import { decodeCursor, encodeCursor } from './mailfeed'
import type { StoredSubmission } from './submissions'

export interface ExportedSubmission extends Omit<StoredSubmission, 'direction' | 'status'> {
  /** The archive's `status` has no CHECK, so it is whatever the row held. */
  status: string
  /** NULL on an archive row: the archive has no such column. */
  direction: 'inbound' | 'outbound' | null
  /** When the 30-day sweep moved it; NULL on a live row. */
  archived_at: number | null
  source: 'live' | 'archive'
}

export interface ExportPage {
  rows: ExportedSubmission[]
  /** Pass back as `cursor` to continue; null when the caller has caught up. */
  nextCursor: string | null
}

export interface ExportQuery {
  /** Epoch millis floor, inclusive. */
  since?: number | null
  cursor?: string | null
  limit: number
}

/** A cursor that does not decode. The route answers 400 rather than restarting the walk. */
export class BadExportCursor extends Error {}

export async function exportSubmissions(db: D1Database, q: ExportQuery): Promise<ExportPage> {
  const cursor = q.cursor ? decodeCursor(q.cursor) : null
  if (q.cursor && !cursor) throw new BadExportCursor(q.cursor)

  const where: string[] = []
  const binds: unknown[] = []

  if (typeof q.since === 'number' && Number.isFinite(q.since)) {
    where.push('created_at >= ?')
    binds.push(q.since)
  }
  if (cursor) {
    where.push('(created_at > ? OR (created_at = ? AND id > ?))')
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }

  const sql = `
    WITH merged AS (
      SELECT id, name, email, message, status, created_at, deleted_at, ip_address,
             user_agent, referrer, recipient, direction, resend_email_id,
             filtered_reason, spammed_at, NULL AS archived_at, 'live' AS source
        FROM contact_submissions
      UNION ALL
      SELECT id, name, email, message, status, created_at, NULL, ip_address,
             user_agent, referrer, NULL, NULL, NULL,
             NULL, NULL, archived_at, 'archive'
        FROM contact_submissions_archive
    )
    SELECT * FROM merged
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`
  binds.push(q.limit + 1)

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<ExportedSubmission>()

  const all = result.results ?? []
  const hasMore = all.length > q.limit
  const rows = hasMore ? all.slice(0, q.limit) : all
  const last = rows[rows.length - 1]
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
  }
}
