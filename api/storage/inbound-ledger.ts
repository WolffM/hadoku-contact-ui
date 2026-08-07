/**
 * Inbound email ledger — one row per Resend email id we have ever made a
 * decision about.
 *
 * This exists because `contact_submissions` is NOT a durable record of what
 * arrived: archiveOldSubmissions() moves rows older than ARCHIVE_AFTER_DAYS
 * into contact_submissions_archive, and purgeOldDeletedSubmissions() hard-
 * deletes trashed ones. Deduping the reconciliation sync against the
 * submissions table alone would re-ingest every archived or deleted email on
 * the next poll — an inbox that resurrects its own trash. The ledger is never
 * purged, so "have we seen this id?" always has a truthful answer.
 */

export type InboundSource = 'webhook' | 'sync' | 'adopt'
export type InboundOutcome = 'stored' | 'filtered' | 'forwarded' | 'forward_skipped' | 'error'

export interface InboundLedgerEntry {
  resend_email_id: string
  submission_id: string | null
  ingested_at: number
  source: InboundSource
  outcome: InboundOutcome
}

/**
 * Record a decision. Idempotent by design: a webhook that Resend retries, or a
 * poll that races the webhook for the same id, must not produce a second row —
 * and must not overwrite the first decision either, since the first is the one
 * whose submission_id actually exists.
 */
export async function recordInboundEmail(
  db: D1Database,
  entry: {
    resendEmailId: string
    submissionId?: string | null
    source: InboundSource
    outcome: InboundOutcome
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO inbound_email_ledger
			(resend_email_id, submission_id, ingested_at, source, outcome)
			VALUES (?, ?, ?, ?, ?)`
    )
    .bind(entry.resendEmailId, entry.submissionId ?? null, Date.now(), entry.source, entry.outcome)
    .run()
}

/**
 * Which of `ids` have we already handled? Returned as a Set so the caller can
 * filter a whole page of Resend results with one round trip instead of one
 * SELECT per email.
 */
export async function getSeenEmailIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()

  const placeholders = ids.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT resend_email_id FROM inbound_email_ledger
			WHERE resend_email_id IN (${placeholders})`
    )
    .bind(...ids)
    .all<{ resend_email_id: string }>()

  return new Set((result.results ?? []).map(row => row.resend_email_id))
}

export async function getLedgerEntry(
  db: D1Database,
  resendEmailId: string
): Promise<InboundLedgerEntry | null> {
  return db
    .prepare(`SELECT * FROM inbound_email_ledger WHERE resend_email_id = ?`)
    .bind(resendEmailId)
    .first<InboundLedgerEntry>()
}
