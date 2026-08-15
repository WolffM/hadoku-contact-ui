/**
 * Sender blocklist — the explicit half of the inbound gate.
 *
 * The whitelist says who is vouched for; failing it is soft (`not_whitelisted`,
 * reviewable in Filtered). This says who is unwanted; matching it is hard
 * (`blocked`, Spam folder, destroyed after SPAM_RETENTION_DAYS).
 *
 * Every write here is paired with a sweep over existing mail, because a block
 * that only affected future mail would leave the backlog that PROVOKED the
 * block sitting in the inbox.
 */

import { EMAIL_CONFIG } from '../constants'

export type BlockKind = 'address' | 'domain'

export interface BlocklistEntry {
  pattern: string
  kind: BlockKind
  blocked_at: number
  blocked_by: string
  contact_id: string | null
  notes: string | null
}

/** `cerebras.net` from `info@cerebras.net`; '' if there is no `@`. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

/**
 * Normalise operator input into a (pattern, kind) pair.
 *
 * A leading `@` is how people write "the whole domain" by hand, so `@cerebras.net`
 * and `cerebras.net` both mean the domain, while anything with an interior `@`
 * is a full address.
 */
export function normalizeBlockPattern(
  raw: string,
  kind?: BlockKind
): { pattern: string; kind: BlockKind } | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  if (kind === 'domain' || trimmed.startsWith('@')) {
    const host = trimmed.replace(/^@+/, '')
    // A domain pattern must be a bare host. Letting an address through as
    // kind='domain' would store a row that can never match anything, since the
    // domain comparison only ever sees the part after the `@`.
    if (!host || host.includes('@') || !host.includes('.')) return null
    return { pattern: host, kind: 'domain' }
  }

  if (kind === 'address') {
    if (!trimmed.includes('@') || domainOf(trimmed) === '') return null
    return { pattern: trimmed, kind: 'address' }
  }

  // Unstated: infer. An `@` means the sender, no `@` means the host.
  if (trimmed.includes('@')) {
    if (domainOf(trimmed) === '') return null
    return { pattern: trimmed, kind: 'address' }
  }
  if (!trimmed.includes('.')) return null
  return { pattern: trimmed, kind: 'domain' }
}

/**
 * The rule that blocks this sender, or null.
 *
 * Returns the ENTRY rather than a boolean so callers can log/report which rule
 * fired — "blocked by @cerebras.net" and "blocked by info@cerebras.net" are
 * very different things to see in a ledger when a block turns out to be too wide.
 * An address rule wins over a domain rule purely so that reporting names the
 * most specific rule; both produce the same outcome.
 */
export async function findBlockRule(db: D1Database, email: string): Promise<BlocklistEntry | null> {
  const address = email.trim().toLowerCase()
  const domain = domainOf(address)
  if (!address) return null

  const result = await db
    .prepare(
      `SELECT pattern, kind, blocked_at, blocked_by, contact_id, notes
       FROM email_blocklist
       WHERE (kind = 'address' AND pattern = ?)
          OR (kind = 'domain' AND pattern = ?)
       ORDER BY kind = 'address' DESC
       LIMIT 1`
    )
    .bind(address, domain)
    .all<BlocklistEntry>()

  return result.results?.[0] ?? null
}

export async function getAllBlocklistEntries(db: D1Database): Promise<BlocklistEntry[]> {
  const result = await db
    .prepare(
      `SELECT pattern, kind, blocked_at, blocked_by, contact_id, notes
       FROM email_blocklist
       ORDER BY blocked_at DESC`
    )
    .all<BlocklistEntry>()

  return result.results ?? []
}

/**
 * SQL fragment matching contact_submissions rows sent BY a blocked sender.
 *
 * `substr(email, instr(email, '@') + 1)` rather than `email LIKE '%@' || ?`
 * because `_` is a LIKE wildcard and a legal hostname character — the LIKE form
 * would let a block on `mail_x.net` silently also match `mailax.net`. The substr
 * form is an exact comparison with no wildcard surface at all.
 *
 * The direction guard matters: an outbound row's `email` column holds the
 * RECIPIENT, so without it, blocking a sender would sweep your own replies to
 * that person into Spam. `direction IS NULL` is included because rows predating
 * migration 0006 have no value and are inbound by definition.
 */
function matchClause(kind: BlockKind): string {
  const senderMatch = kind === 'address' ? `email = ?` : `substr(email, instr(email, '@') + 1) = ?`
  return `(direction IS NULL OR direction != 'outbound') AND ${senderMatch}`
}

export async function addToBlocklist(
  db: D1Database,
  entry: {
    pattern: string
    kind: BlockKind
    blockedBy: string
    contactId?: string | null
    notes?: string | null
  }
): Promise<void> {
  const blockedAt = Date.now()

  await db
    .prepare(
      `INSERT INTO email_blocklist (pattern, kind, blocked_at, blocked_by, contact_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pattern) DO UPDATE SET
         kind = excluded.kind,
         blocked_at = excluded.blocked_at,
         blocked_by = excluded.blocked_by,
         contact_id = COALESCE(excluded.contact_id, contact_id),
         notes = COALESCE(excluded.notes, notes)`
    )
    .bind(
      entry.pattern,
      entry.kind,
      blockedAt,
      entry.blockedBy,
      entry.contactId ?? null,
      entry.notes ?? null
    )
    .run()
}

/**
 * Move mail already in the mailbox into Spam. Returns the number moved.
 *
 * `spammed_at` is stamped NOW, not backdated to `created_at`: the 90-day clock
 * measures how long the operator has to change their mind, so it starts when the
 * judgement was made. Backdating would hard-delete a months-old backlog on the
 * next nightly sweep, before it was ever visible in the Spam folder.
 *
 * Trash is left alone — `status='deleted'` mail is already on the 7-day purge and
 * pulling it into Spam would EXTEND its life to 90 days, the opposite of intent.
 */
export async function applyBlockToExistingMail(
  db: D1Database,
  pattern: string,
  kind: BlockKind
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE contact_submissions
       SET filtered_reason = 'blocked', spammed_at = ?
       WHERE ${matchClause(kind)}
         AND status != 'deleted'
         AND (filtered_reason IS NULL OR filtered_reason != 'blocked')`
    )
    .bind(Date.now(), pattern)
    .run()

  return result.meta?.changes ?? 0
}

export async function removeFromBlocklist(db: D1Database, pattern: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM email_blocklist WHERE pattern = ?`)
    .bind(pattern.trim().toLowerCase())
    .run()

  return (result.meta?.changes ?? 0) > 0
}

/**
 * Pull a sender's mail back out of Spam after an unblock. Returns the count.
 *
 * It does NOT simply clear `filtered_reason` to NULL. That would assert the mail
 * passed the whitelist gate, which is a different question that may well still
 * have the answer "no" — and the row would then sit in the Inbox while a NEW mail
 * from the same sender landed in Filtered, two paths disagreeing about one sender.
 * So the gate is RE-EVALUATED here, in the same terms ingest uses: whitelisted, or
 * addressed to a public recipient, means Inbox; otherwise back to Filtered.
 */
export async function restoreBlockedMail(
  db: D1Database,
  pattern: string,
  kind: BlockKind
): Promise<number> {
  const publicRecipients = EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]
  // Built from a compile-time constant, never from caller input — the values are
  // still bound, the placeholders only size the list.
  const publicPlaceholders = publicRecipients.map(() => '?').join(', ')
  const publicClause = publicRecipients.length ? `OR recipient IN (${publicPlaceholders})` : ''

  const result = await db
    .prepare(
      `UPDATE contact_submissions
       SET filtered_reason = CASE
             WHEN EXISTS (
               SELECT 1 FROM email_whitelist w WHERE w.email = contact_submissions.email
             ) ${publicClause}
             THEN NULL
             ELSE 'not_whitelisted'
           END,
           spammed_at = NULL
       WHERE ${matchClause(kind)}
         AND filtered_reason = 'blocked'`
    )
    .bind(...publicRecipients, pattern)
    .run()

  return result.meta?.changes ?? 0
}
