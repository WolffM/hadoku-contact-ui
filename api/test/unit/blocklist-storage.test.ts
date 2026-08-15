/**
 * Sender blocklist storage tests, against real D1.
 *
 * The cases that matter are the ones where a block could silently fail to hold:
 * outbound rows sharing the sender's address, the archive sweep reaching spam
 * before the 90-day purge does, and unblocking restoring mail to the wrong folder.
 */
import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  addToBlocklist,
  applyBlockToExistingMail,
  archiveOldSubmissions,
  createSubmission,
  findBlockRule,
  getAllBlocklistEntries,
  normalizeBlockPattern,
  purgeOldSpamSubmissions,
  removeFromBlocklist,
  restoreBlockedMail,
  addToWhitelist,
  getSubmissionStats
} from '../../storage'
import { RETENTION_CONFIG } from '../../constants'

const DAY = 24 * 60 * 60 * 1000

async function spamRowCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM contact_submissions WHERE filtered_reason = 'blocked'`
  ).first<{ n: number }>()
  return row?.n ?? 0
}

async function reasonOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT filtered_reason FROM contact_submissions WHERE id = ?')
    .bind(id)
    .first<{ filtered_reason: string | null }>()
  return row?.filtered_reason ?? null
}

describe('normalizeBlockPattern', () => {
  it('infers an address rule from an @', () => {
    expect(normalizeBlockPattern('info@cerebras.net')).toEqual({
      pattern: 'info@cerebras.net',
      kind: 'address'
    })
  })

  it('infers a domain rule from a bare host', () => {
    expect(normalizeBlockPattern('cerebras.net')).toEqual({
      pattern: 'cerebras.net',
      kind: 'domain'
    })
  })

  it('treats a leading @ as the hand-written form of "whole domain"', () => {
    expect(normalizeBlockPattern('@cerebras.net')).toEqual({
      pattern: 'cerebras.net',
      kind: 'domain'
    })
  })

  it('reduces an address to its host when domain scope is explicit', () => {
    // The Block button passes the domain already extracted, but an operator
    // typing a full address into the list editor with scope=domain means the
    // host — storing the address under kind='domain' would match nothing ever.
    expect(normalizeBlockPattern('info@cerebras.net', 'domain')).toBeNull()
    expect(normalizeBlockPattern('cerebras.net', 'domain')).toEqual({
      pattern: 'cerebras.net',
      kind: 'domain'
    })
  })

  it('lowercases and trims', () => {
    expect(normalizeBlockPattern('  INFO@Cerebras.NET  ')).toEqual({
      pattern: 'info@cerebras.net',
      kind: 'address'
    })
  })

  it('rejects junk', () => {
    expect(normalizeBlockPattern('')).toBeNull()
    expect(normalizeBlockPattern('   ')).toBeNull()
    expect(normalizeBlockPattern('notadomain')).toBeNull()
    expect(normalizeBlockPattern('@')).toBeNull()
  })
})

describe('blocklist matching', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
  })

  it('matches an address rule exactly', async () => {
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin'
    })

    expect(await findBlockRule(env.DB, 'info@cerebras.net')).not.toBeNull()
    expect(await findBlockRule(env.DB, 'hello@cerebras.net')).toBeNull()
  })

  it('matches every local part under a domain rule', async () => {
    await addToBlocklist(env.DB, { pattern: 'cerebras.net', kind: 'domain', blockedBy: 'admin' })

    expect(await findBlockRule(env.DB, 'info@cerebras.net')).not.toBeNull()
    expect(await findBlockRule(env.DB, 'hello@cerebras.net')).not.toBeNull()
    // ...but not a domain that merely ends with it.
    expect(await findBlockRule(env.DB, 'info@notcerebras.net')).toBeNull()
  })

  it('is case-insensitive on the sender', async () => {
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin'
    })
    expect(await findBlockRule(env.DB, 'INFO@Cerebras.NET')).not.toBeNull()
  })

  it('reports the most specific rule when both could match', async () => {
    await addToBlocklist(env.DB, { pattern: 'cerebras.net', kind: 'domain', blockedBy: 'admin' })
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin'
    })

    const rule = await findBlockRule(env.DB, 'info@cerebras.net')
    expect(rule?.kind).toBe('address')
    expect(rule?.pattern).toBe('info@cerebras.net')
  })

  it('re-blocking an existing pattern updates rather than throwing', async () => {
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin',
      notes: 'first'
    })
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin2',
      notes: 'second'
    })

    const entries = await getAllBlocklistEntries(env.DB)
    expect(entries).toHaveLength(1)
    expect(entries[0].blocked_by).toBe('admin2')
  })
})

describe('applying a block to mail already in the mailbox', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
  })

  it("moves the sender's existing mail into Spam", async () => {
    await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'buy compute',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await createSubmission(env.DB, {
      name: 'real',
      email: 'friend@example.com',
      message: 'hello',
      ip_address: null,
      user_agent: null,
      referrer: null
    })

    const moved = await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(moved).toBe(1)
    expect(await spamRowCount()).toBe(1)
  })

  it('never sweeps in mail the operator SENT to that address', async () => {
    // An outbound row stores the RECIPIENT in `email`, so without the direction
    // guard, blocking a sender would drag your own replies into Spam.
    const outbound = await createSubmission(env.DB, {
      name: 'Re: hello',
      email: 'info@cerebras.net',
      message: 'my reply',
      ip_address: null,
      user_agent: null,
      referrer: null,
      direction: 'outbound'
    })

    const moved = await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(moved).toBe(0)
    expect(await reasonOf(outbound.id)).toBeNull()
  })

  it("leaves Trash alone so blocking cannot EXTEND a message's life", async () => {
    const doomed = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await env.DB.prepare(
      `UPDATE contact_submissions SET status = 'deleted', deleted_at = ? WHERE id = ?`
    )
      .bind(Date.now(), doomed.id)
      .run()

    const moved = await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(moved).toBe(0)
    expect(await reasonOf(doomed.id)).toBeNull()
  })

  it('stamps the clock at block time, not at the message date', async () => {
    // The whole reason spammed_at exists: a year-old backlog must get its full
    // 90 days, not be hard-deleted on tonight's sweep.
    const old = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'ancient spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await env.DB.prepare('UPDATE contact_submissions SET created_at = ? WHERE id = ?')
      .bind(Date.now() - 400 * DAY, old.id)
      .run()

    await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    const row = await env.DB.prepare('SELECT spammed_at FROM contact_submissions WHERE id = ?')
      .bind(old.id)
      .first<{ spammed_at: number }>()
    expect(row!.spammed_at).toBeGreaterThan(Date.now() - 60_000)

    // ...and so it survives the purge it would otherwise fail.
    expect(await purgeOldSpamSubmissions(env.DB)).toBe(0)
  })

  it('is idempotent — re-applying does not re-stamp the clock', async () => {
    await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })

    expect(await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')).toBe(1)
    expect(await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')).toBe(0)
  })
})

describe('spam retention', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM contact_submissions_archive').run()
  })

  async function makeSpam(spammedAgoDays: number, createdAgoDays = 1): Promise<string> {
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null,
      filtered_reason: 'blocked',
      spammed_at: Date.now() - spammedAgoDays * DAY
    })
    await env.DB.prepare('UPDATE contact_submissions SET created_at = ? WHERE id = ?')
      .bind(Date.now() - createdAgoDays * DAY, row.id)
      .run()
    return row.id
  }

  it('keeps spam inside the retention window', async () => {
    await makeSpam(RETENTION_CONFIG.SPAM_RETENTION_DAYS - 5)
    expect(await purgeOldSpamSubmissions(env.DB)).toBe(0)
    expect(await spamRowCount()).toBe(1)
  })

  it('hard-deletes spam past the retention window', async () => {
    await makeSpam(RETENTION_CONFIG.SPAM_RETENTION_DAYS + 5)
    expect(await purgeOldSpamSubmissions(env.DB)).toBe(1)
    expect(await spamRowCount()).toBe(0)
  })

  it('exempts spam from the 30-day archive sweep', async () => {
    // The load-bearing one. The archive table has no filtered_reason/spammed_at
    // columns, so spam that reached it would become ordinary old mail — invisible
    // to the Spam folder and immortal, because the purge only scans
    // contact_submissions. It must still be there after the sweep.
    const id = await makeSpam(5, RETENTION_CONFIG.ARCHIVE_AFTER_DAYS + 10)

    const archived = await archiveOldSubmissions(env.DB)

    expect(archived).toBe(0)
    expect(await reasonOf(id)).toBe('blocked')

    const inArchive = await env.DB.prepare(
      'SELECT id FROM contact_submissions_archive WHERE id = ?'
    )
      .bind(id)
      .first()
    expect(inArchive).toBeNull()
  })

  it('still archives ordinary old mail alongside exempt spam', async () => {
    await makeSpam(5, RETENTION_CONFIG.ARCHIVE_AFTER_DAYS + 10)
    const ordinary = await createSubmission(env.DB, {
      name: 'friend',
      email: 'friend@example.com',
      message: 'old but wanted',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await env.DB.prepare('UPDATE contact_submissions SET created_at = ? WHERE id = ?')
      .bind(Date.now() - (RETENTION_CONFIG.ARCHIVE_AFTER_DAYS + 10) * DAY, ordinary.id)
      .run()

    expect(await archiveOldSubmissions(env.DB)).toBe(1)
    expect(await spamRowCount()).toBe(1)
  })

  it('keeps spam out of the inbox totals and the unread badge', async () => {
    await makeSpam(1)
    const stats = await getSubmissionStats(env.DB)
    expect(stats.spam).toBe(1)
    expect(stats.total).toBe(0)
    expect(stats.unread).toBe(0)
  })
})

describe('unblocking', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
  })

  it('removes the rule', async () => {
    await addToBlocklist(env.DB, {
      pattern: 'info@cerebras.net',
      kind: 'address',
      blockedBy: 'admin'
    })
    expect(await removeFromBlocklist(env.DB, 'info@cerebras.net')).toBe(true)
    expect(await findBlockRule(env.DB, 'info@cerebras.net')).toBeNull()
  })

  it("returns a whitelisted sender's mail to the Inbox", async () => {
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await addToWhitelist(env.DB, 'info@cerebras.net', 'admin')
    await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address')).toBe(1)
    expect(await reasonOf(row.id)).toBeNull()
  })

  it("returns an unvouched sender's mail to Filtered, not the Inbox", async () => {
    // Clearing to NULL would assert the mail passed the whitelist gate, which is
    // a separate question that still answers "no" — and the row would then sit in
    // the Inbox while the sender's NEXT mail landed in Filtered.
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null
    })
    await applyBlockToExistingMail(env.DB, 'info@cerebras.net', 'address')

    expect(await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address')).toBe(1)
    expect(await reasonOf(row.id)).toBe('not_whitelisted')
  })

  it('clears the retention clock so restored mail is not purged', async () => {
    const row = await createSubmission(env.DB, {
      name: 'info',
      email: 'info@cerebras.net',
      message: 'spam',
      ip_address: null,
      user_agent: null,
      referrer: null,
      filtered_reason: 'blocked',
      spammed_at: Date.now() - (RETENTION_CONFIG.SPAM_RETENTION_DAYS + 5) * DAY
    })

    await restoreBlockedMail(env.DB, 'info@cerebras.net', 'address')

    expect(await purgeOldSpamSubmissions(env.DB)).toBe(0)
    const after = await env.DB.prepare('SELECT spammed_at FROM contact_submissions WHERE id = ?')
      .bind(row.id)
      .first<{ spammed_at: number | null }>()
    expect(after!.spammed_at).toBeNull()
  })
})
