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
  /**
   * When this mail entered the Spam folder, and the start of its
   * SPAM_RETENTION_DAYS countdown. Non-NULL exactly when
   * `filtered_reason = 'blocked'`; NULL for every other row.
   */
  spammed_at: number | null
}

/**
 * Why a mail was quarantined instead of accepted.
 *
 * The two are not degrees of the same thing, and the difference is what the
 * operator has said:
 *
 *   not_whitelisted  nobody has vouched for this sender yet. Reviewable in
 *                    Filtered, kept on the ordinary archive schedule.
 *   blocked          the operator judged this sender unwanted. Spam folder,
 *                    exempt from archiving, destroyed after 90 days.
 *
 * Retrieval failures are deliberately NOT a reason: a mail whose body we could
 * not fetch is left unledgered so the next sweep retries it with a real body,
 * rather than being frozen as a permanent stub.
 */
export type FilteredReason = 'not_whitelisted' | 'blocked'

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
  /**
   * Start of the spam retention clock. Set only alongside
   * `filtered_reason: 'blocked'`; ingest passes `Date.now()`.
   */
  spammed_at?: number | null
  /** Overrides the direction-derived default. Used to backfill old mail as read. */
  status?: 'unread' | 'read'
}

export interface SubmissionStats {
  /** Live, non-spam mail. Spam is excluded — a blocked sender must not inflate it. */
  total: number
  /** Likewise spam-free, so blocked mail can never drive the unread badge. */
  unread: number
  read: number
  archived: number
  deleted: number
  spam: number
}

export async function createSubmission(
  db: D1Database,
  params: CreateSubmissionParams
): Promise<StoredSubmission> {
  // `crypto` is a bare global in the Workers runtime, declared by
  // @cloudflare/workers-types as `declare const` — which TypeScript does NOT
  // expose as a property of `globalThis`. Reaching through globalThis was the
  // reason the cast existed, and the cast is what hid that it did not typecheck.
  const id = crypto.randomUUID()
  const created_at = Date.now()

  const direction = params.direction ?? 'inbound'
  const status = params.status ?? (direction === 'outbound' ? 'read' : 'unread')

  await db
    .prepare(
      `INSERT INTO contact_submissions
			(id, name, email, message, status, created_at, ip_address, user_agent, referrer, recipient, direction, resend_email_id, filtered_reason, spammed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      params.filtered_reason ?? null,
      params.spammed_at ?? null
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
    filtered_reason: params.filtered_reason ?? null,
    spammed_at: params.spammed_at ?? null
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
  // Some row already carries this id, so the mail IS stored and only the
  // ledger entry is missing — a sweep that died between the INSERT and the
  // ledger write leaves exactly that state. Hand the id back so the caller
  // ledgers it and stops. Falling through instead would drive the id into the
  // UNIQUE index (from the adopt UPDATE or the later INSERT), throw, skip the
  // ledger write again, and wedge this email into a permanent retry loop.
  const stamped = await db
    .prepare(
      `SELECT id FROM contact_submissions
			WHERE resend_email_id = ?
			LIMIT 1`
    )
    .bind(params.resendEmailId)
    .first<{ id: string }>()

  if (stamped) return stamped.id

  // Prefix-match with substr(), NOT `message LIKE 'Subject: ...%'`: D1 caps a
  // LIKE/GLOB pattern at 50 bytes and raises "LIKE or GLOB pattern too
  // complex" past it, so any subject over ~40 characters threw here — and
  // since a throw skips the ledger write, every such email retried forever.
  // length() is evaluated by SQLite on the same bound string it slices, so the
  // two agree on character counting even for astral-plane subjects.
  const messagePrefix = `Subject: ${params.subject}`
  const candidate = await db
    .prepare(
      `SELECT id FROM contact_submissions
			WHERE resend_email_id IS NULL
				AND direction = 'inbound'
				AND email = ?
				AND recipient IS ?
				AND substr(message, 1, length(?)) = ?
			ORDER BY created_at DESC
			LIMIT 1`
    )
    .bind(params.email, params.recipient, messagePrefix, messagePrefix)
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

/**
 * Which slice of the mailbox a list read wants.
 *
 * The filters exist so a folder can be paged ON ITS OWN. The list used to be
 * one newest-first walk over every live row, with the caller sorting rows into
 * folders afterwards — which works until one mailbox outnumbers the rest. On
 * 2026-11-19 the live table held 1,044 rows and 927 of them were npm publish
 * notifications to a single alias, arriving at ~200 a day: a page of 100 was
 * under half a day of that one mailbox, and the mail a person actually wanted
 * was ten pages down.
 */
export interface SubmissionFilter {
  /** Only rows addressed to one of these. Empty or absent: no restriction. */
  mailboxes?: readonly string[]
  /**
   * Rows addressed to none of these. A row with NO recipient is kept: it is
   * not addressed to an excluded mailbox, and SQL's `NOT IN` would otherwise
   * drop it (NULL NOT IN (...) is unknown, not true).
   */
  excludeMailboxes?: readonly string[]
  /**
   * `live` (the default) is everything not in the trash, `only` is the trash
   * and nothing else, `include` is both.
   */
  deleted?: 'live' | 'only' | 'include'
}

/**
 * How many mailbox addresses one filter may name. Each is a bound parameter
 * and D1 binds at most 100 per statement; this leaves room for both lists plus
 * LIMIT and OFFSET with a wide margin, and is far past any real folder rail.
 */
export const MAX_FILTER_MAILBOXES = 40

function submissionWhere(filter: SubmissionFilter): { sql: string; binds: string[] } {
  const clauses: string[] = []
  const binds: string[] = []

  const deleted = filter.deleted ?? 'live'
  if (deleted === 'live') clauses.push(`status != 'deleted'`)
  if (deleted === 'only') clauses.push(`status = 'deleted'`)

  const mailboxes = filter.mailboxes ?? []
  if (mailboxes.length > 0) {
    clauses.push(`recipient IN (${mailboxes.map(() => '?').join(', ')})`)
    binds.push(...mailboxes)
  }

  const excluded = filter.excludeMailboxes ?? []
  if (excluded.length > 0) {
    clauses.push(`(recipient IS NULL OR recipient NOT IN (${excluded.map(() => '?').join(', ')}))`)
    binds.push(...excluded)
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', binds }
}

/** One page of the mailbox, newest first, narrowed by `filter`. */
export async function listSubmissions(
  db: D1Database,
  limit: number = PAGINATION_DEFAULTS.LIMIT,
  offset: number = PAGINATION_DEFAULTS.OFFSET,
  filter: SubmissionFilter = {}
): Promise<StoredSubmission[]> {
  const where = submissionWhere(filter)
  const result = await db
    .prepare(
      `SELECT * FROM contact_submissions
			${where.sql}
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`
    )
    .bind(...where.binds, limit, offset)
    .all<StoredSubmission>()

  return result.results ?? []
}

export async function getAllSubmissions(
  db: D1Database,
  limit: number = PAGINATION_DEFAULTS.LIMIT,
  offset: number = PAGINATION_DEFAULTS.OFFSET,
  includeDeleted = false
): Promise<StoredSubmission[]> {
  return listSubmissions(db, limit, offset, { deleted: includeDeleted ? 'include' : 'live' })
}

/** One mailbox and how much mail is in its folder. */
export interface MailboxCount {
  recipient: string
  total: number
}

/**
 * Every mailbox that holds mail, with its folder's size.
 *
 * Counts what a per-mailbox folder SHOWS: received, live, not quarantined. It
 * is what lets a client draw the folder rail without having every row in hand
 * — a mailbox it has deliberately not downloaded still gets its folder.
 */
export async function getMailboxCounts(db: D1Database): Promise<MailboxCount[]> {
  const result = await db
    .prepare(
      `SELECT recipient, COUNT(*) AS total FROM contact_submissions
			WHERE recipient IS NOT NULL
				AND status != 'deleted'
				AND direction != 'outbound'
				AND filtered_reason IS NULL
			GROUP BY recipient
			ORDER BY total DESC`
    )
    .all<MailboxCount>()

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

/**
 * Give a web-form row a subject. There is no subject column; the Inbox reads
 * one from the `Subject: X\n\n<body>` envelope inbound mail is stored in, so a
 * row given that envelope displays exactly like a real email's.
 *
 * Refuses a row that already has one, so a retry cannot stack two envelopes.
 */
export async function setSubmissionSubject(
  db: D1Database,
  id: string,
  subject: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE contact_submissions
			SET message = 'Subject: ' || ? || char(10, 10) || message
			WHERE id = ? AND substr(message, 1, 9) != 'Subject: '`
    )
    .bind(subject, id)
    .run()

  return (result.meta?.changes ?? 0) > 0
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

/**
 * Clear every lingering `not_whitelisted` stamp. Returns the count.
 *
 * For deployments that have switched the whitelist tier off
 * (INBOUND_WHITELIST_MODE=accept-all). Turning the gate off stops NEW mail being
 * stamped, but says nothing about mail already carrying the stamp — which then
 * sits in Filtered, quarantined by a policy that no longer exists, for as long
 * as the row survives. Daily maintenance calls this so storage converges on the
 * policy instead of preserving a fossil of the previous one.
 *
 * Blocked mail is untouched: `filtered_reason = 'not_whitelisted'` is the whole
 * predicate, so Spam and its retention clock are out of scope by construction.
 *
 * Idempotent, and a no-op on every run after the first — which is the point.
 * Switching the gate back ON does not re-stamp these rows, and should not: they
 * are mail the operator has had in the Inbox and left there.
 */
export async function releaseQuarantinedSubmissions(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE contact_submissions SET filtered_reason = NULL
       WHERE filtered_reason = 'not_whitelisted'`
    )
    .run()

  return result.meta?.changes ?? 0
}

export async function getSubmissionStats(db: D1Database): Promise<SubmissionStats> {
  const result = await db
    .prepare(
      `SELECT
				SUM(CASE WHEN status != 'deleted' AND spammed_at IS NULL THEN 1 ELSE 0 END) as total,
				SUM(CASE WHEN status = 'unread' AND spammed_at IS NULL THEN 1 ELSE 0 END) as unread,
				SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) as read,
				SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
				SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) as deleted,
				SUM(CASE WHEN spammed_at IS NOT NULL THEN 1 ELSE 0 END) as spam
			FROM contact_submissions`
    )
    .first<SubmissionStats>()

  return result ?? { total: 0, unread: 0, read: 0, archived: 0, deleted: 0, spam: 0 }
}

export async function archiveOldSubmissions(
  db: D1Database,
  daysOld: number = RETENTION_CONFIG.ARCHIVE_AFTER_DAYS
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

  // Spam is governed by its own clock and must never enter the archive.
  //
  // contact_submissions_archive carries none of the columns added after 0001 —
  // no `filtered_reason`, no `spammed_at`, no `recipient`, no `direction`. A spam
  // row that crossed the 30-day archive horizon would therefore come out the far
  // side stripped of every marker that identified it as spam: indistinguishable
  // from ordinary old mail, unreachable by the Spam folder (nothing reads the
  // archive table), and untouchable by purgeOldSpamSubmissions, which scans
  // contact_submissions alone. The 90-day deletion promise would be silently
  // broken for every blocked sender at day 30, in the direction that KEEPS the
  // mail forever. Excluding it here is what makes that promise keepable.
  const notSpam = 'spammed_at IS NULL'
  const [copyResult] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO contact_submissions_archive
			(id, name, email, message, status, created_at, archived_at, ip_address, user_agent, referrer)
			SELECT id, name, email, message, status, created_at, ?, ip_address, user_agent, referrer
			FROM contact_submissions
			WHERE created_at < ? AND ${notReferenced} AND ${notSpam}`
      )
      .bind(archivedAt, cutoffTime),
    db
      .prepare(
        `DELETE FROM contact_submissions
         WHERE created_at < ? AND ${notReferenced} AND ${notSpam}`
      )
      .bind(cutoffTime)
  ])

  return copyResult.meta?.changes ?? 0
}

/**
 * Hard-delete spam whose SPAM_RETENTION_DAYS window has closed.
 *
 * Scans `spammed_at`, not `created_at`: the clock starts when the sender was
 * blocked, so a freshly-blocked backlog of year-old mail gets its full 90 days
 * of "actually, undo that" rather than evaporating on the next nightly run.
 *
 * Same appointments FK guard as the archive and trash sweeps — `appointments.submission_id`
 * references contact_submissions(id) with no ON DELETE clause, so deleting a row a
 * booked appointment still points at raises FOREIGN KEY constraint and fails the
 * whole daily-maintenance job. `IS NOT NULL` is required: a NULL inside a NOT IN
 * set makes the predicate unknown and matches nothing.
 */
export async function purgeOldSpamSubmissions(db: D1Database): Promise<number> {
  const retentionMs = RETENTION_CONFIG.SPAM_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const cutoffTime = Date.now() - retentionMs

  const result = await db
    .prepare(
      `DELETE FROM contact_submissions
       WHERE filtered_reason = 'blocked' AND spammed_at IS NOT NULL AND spammed_at < ?
         AND id NOT IN (SELECT submission_id FROM appointments WHERE submission_id IS NOT NULL)`
    )
    .bind(cutoffTime)
    .run()

  return result.meta?.changes ?? 0
}
