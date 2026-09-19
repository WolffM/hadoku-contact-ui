/**
 * The scoped mail feed's one query.
 *
 * Everything that decides WHAT a caller sees is here, in SQL, expressed as a
 * WHERE clause the database enforces. Nothing is fetched and then filtered in
 * TypeScript: a post-filter is a filter that can be forgotten on one code path,
 * and the thing it separates is an ecosystem service from the operator's
 * private correspondence.
 *
 * Two tables, because the mailbox is two tables. `archiveOldSubmissions` moves
 * anything older than ARCHIVE_AFTER_DAYS into `contact_submissions_archive`, so
 * a feed that read only the live table would show a consumer 30 days of history
 * and call it the record. The archive keeps `email`, `message`, `created_at`
 * and `user_agent` — everything this feed reports — and drops only columns it
 * does not use (`direction`, `recipient`, `filtered_reason`, `resend_email_id`).
 */

import { MAILFEED_INBOUND_USER_AGENT } from '../constants'
import type { MailfeedScope } from '../services/mailfeed-scope'

export interface MailfeedMessage {
  id: string
  /** Epoch millis the mail arrived. */
  receivedAt: number
  /** The sender. On an inbound row `email` is always the counterparty. */
  from: string
  /** The registrable-or-deeper domain the match was made against. */
  fromDomain: string
  /** Parsed out of the stored `Subject: …\n\n…` envelope; null if absent. */
  subject: string | null
  body: string
  /** Which table it came from. Purely informational. */
  source: 'live' | 'archive'
}

export interface MailfeedPage {
  messages: MailfeedMessage[]
  /** Pass back as `cursor` to continue; null when the caller has caught up. */
  nextCursor: string | null
}

export interface MailfeedQuery {
  scope: MailfeedScope
  /** Epoch millis floor, inclusive. */
  since?: number | null
  cursor?: string | null
  limit: number
}

/**
 * `<createdAt>:<id>` — the exact tuple the ORDER BY uses.
 *
 * Ordering by `created_at` alone is not enough to page safely: two mails can
 * share a millisecond, and a cursor that carries only the timestamp must then
 * either re-serve one of them or skip one. Neither is acceptable for a consumer
 * whose whole job is to decide what it has already seen.
 */
export function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`
}

export function decodeCursor(raw: string): { createdAt: number; id: string } | null {
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const createdAt = Number(raw.slice(0, sep))
  const id = raw.slice(sep + 1)
  if (!Number.isFinite(createdAt) || !id) return null
  return { createdAt, id }
}

/**
 * `Subject: X\n\nbody` — the envelope `ingestInboundEmail` glues together,
 * taken back apart.
 *
 * `contact_submissions` has no subject column (see CONTACT_UI_THREADING.md),
 * and adding one is a migration this feed has no standing to demand. Splitting
 * here keeps that shape an implementation detail of storage rather than
 * something every consumer has to know about the mailbox.
 */
export function splitStoredMessage(message: string): { subject: string | null; body: string } {
  const match = /^Subject: ([^\n]*)\n\n([\s\S]*)$/.exec(message)
  if (!match) return { subject: null, body: message }
  return { subject: match[1], body: match[2] }
}

/**
 * `no-reply@GREENHOUSE.io` -> `greenhouse.io`; mirrors the SQL's own extraction
 * so the value reported back matches the value matched on.
 */
function domainOfSender(email: string): string {
  const at = email.indexOf('@')
  return at < 0 ? email.toLowerCase() : email.slice(at + 1).toLowerCase()
}

/**
 * One domain, two ways to match it: the sender IS the domain, or the sender is
 * BELOW it.
 *
 * The `'%.' || ?` half is why `parseMailfeedScopes` refuses a domain containing
 * anything but `[a-z0-9.-]`. A `%` surviving into this concatenation would make
 * the predicate match every sender in the mailbox.
 */
function domainPredicate(domains: string[]): { sql: string; binds: string[] } {
  const clauses = domains.map(() => "(sender_domain = ? OR sender_domain LIKE '%.' || ?)")
  const binds: string[] = []
  for (const d of domains) binds.push(d, d)
  return { sql: `(${clauses.join(' OR ')})`, binds }
}

interface RawRow {
  id: string
  email: string
  message: string
  created_at: number
  source: 'live' | 'archive'
}

export async function queryMailfeed(db: D1Database, q: MailfeedQuery): Promise<MailfeedPage> {
  const { sql: domainSql, binds: domainBinds } = domainPredicate(q.scope.senderDomains)
  const cursor = q.cursor ? decodeCursor(q.cursor) : null

  const binds: unknown[] = []

  // Live rows. THREE exclusions, each load-bearing:
  //
  //  - `direction = 'inbound'` — an outbound row's `email` is the RECIPIENT, so
  //    without this a reply the operator once sent to someone at an in-scope
  //    domain would come back as if that domain had written to them.
  //  - `filtered_reason IS NULL` — quarantined mail has not passed the inbound
  //    gate. Serving `blocked` mail here would let a sender the operator
  //    explicitly refused reach a consumer by forging a From domain, which is
  //    the one attack this feed is otherwise wide open to.
  //  - `status != 'deleted'` — a trashed mail is a mail the operator took back.
  //
  // `user_agent` is the inbound marker and the ONLY discriminator that survives
  // archiving (the archive has no `direction` column), so it is applied to both
  // halves rather than to the one that needs it.
  let sql = `
    WITH merged AS (
      SELECT id, email, message, created_at, 'live' AS source,
             substr(lower(email), instr(lower(email), '@') + 1) AS sender_domain
        FROM contact_submissions
       WHERE direction = 'inbound'
         AND user_agent = ?
         AND filtered_reason IS NULL
         AND spammed_at IS NULL
         AND status != 'deleted'
      UNION ALL
      SELECT id, email, message, created_at, 'archive' AS source,
             substr(lower(email), instr(lower(email), '@') + 1) AS sender_domain
        FROM contact_submissions_archive
       WHERE user_agent = ?
         AND status != 'deleted'
    )
    SELECT id, email, message, created_at, source
      FROM merged
     WHERE ${domainSql}`
  binds.push(MAILFEED_INBOUND_USER_AGENT, MAILFEED_INBOUND_USER_AGENT, ...domainBinds)

  if (typeof q.since === 'number' && Number.isFinite(q.since)) {
    sql += ' AND created_at >= ?'
    binds.push(q.since)
  }

  if (cursor) {
    sql += ' AND (created_at > ? OR (created_at = ? AND id > ?))'
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }

  // ASCENDING, and that is the whole reason a backfill needs no separate
  // machinery: a consumer starting from no cursor walks the mailbox from its
  // first message to its last, and the same walk continued tomorrow returns
  // only what arrived since. Newest-first would have made the initial import
  // and the steady-state poll two different problems.
  //
  // One row over the limit is fetched purely to answer "is there more?" without
  // a second COUNT query over the same predicate.
  sql += ' ORDER BY created_at ASC, id ASC LIMIT ?'
  binds.push(q.limit + 1)

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<RawRow>()

  const rows = result.results ?? []
  const hasMore = rows.length > q.limit
  const page = hasMore ? rows.slice(0, q.limit) : rows

  const messages: MailfeedMessage[] = page.map(row => {
    const { subject, body } = splitStoredMessage(row.message)
    return {
      id: row.id,
      receivedAt: row.created_at,
      from: row.email,
      fromDomain: domainOfSender(row.email),
      subject,
      body,
      source: row.source
    }
  })

  const last = page[page.length - 1]
  return {
    messages,
    // A cursor is returned ONLY when there is more to fetch. Handing one back
    // on the final page would read as "keep going" forever; the consumer's own
    // high-water mark is the last message's cursor, which it can build itself.
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
  }
}
