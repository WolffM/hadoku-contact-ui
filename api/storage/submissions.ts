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
}

export interface CreateSubmissionParams {
  name: string
  email: string
  message: string
  ip_address: string | null
  user_agent: string | null
  referrer: string | null
  recipient?: string | null
  direction?: 'inbound' | 'outbound'
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
  const status = direction === 'outbound' ? 'read' : 'unread'

  await db
    .prepare(
      `INSERT INTO contact_submissions
			(id, name, email, message, status, created_at, ip_address, user_agent, referrer, recipient, direction)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      direction
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
    direction
  }

  return result
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

  const result = await db
    .prepare(
      `DELETE FROM contact_submissions WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?`
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

  const copyResult = await db
    .prepare(
      `INSERT INTO contact_submissions_archive
			(id, name, email, message, status, created_at, archived_at, ip_address, user_agent, referrer)
			SELECT id, name, email, message, status, created_at, ?, ip_address, user_agent, referrer
			FROM contact_submissions
			WHERE created_at < ?`
    )
    .bind(archivedAt, cutoffTime)
    .run()

  await db.prepare(`DELETE FROM contact_submissions WHERE created_at < ?`).bind(cutoffTime).run()

  return copyResult.meta?.changes ?? 0
}
