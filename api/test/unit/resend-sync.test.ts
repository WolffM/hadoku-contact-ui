/**
 * Reconciliation sweep tests.
 *
 * The sweep is what makes the command station converge on what Resend
 * actually holds, so the properties that matter are: it ingests what is
 * missing, it never double-ingests, it never resurrects archived mail, and it
 * never replays an outward-facing forward.
 */
import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { syncInboundEmails } from '../../services/resend-sync'
import { createSubmission, recordInboundEmail } from '../../storage'
import { INBOUND_SYNC_CONFIG, EMAIL_CONFIG } from '../../constants'
import type { ContactEnv } from '../../types'

/** A mailbox deliberately NOT in PUBLIC_RECIPIENTS, so the whitelist gate applies. */
const NON_PUBLIC_RECIPIENT = 'support@hadoku.me'

if ((EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]).includes(NON_PUBLIC_RECIPIENT)) {
  throw new Error(
    `${NON_PUBLIC_RECIPIENT} is now in PUBLIC_RECIPIENTS and cannot stand in for a ` +
      `whitelist-gated mailbox. Pick another address for NON_PUBLIC_RECIPIENT.`
  )
}

interface ListItem {
  id: string
  from: string
  to: string[]
  subject: string
  created_at: string
  text?: string | null
  html?: string | null
}

/**
 * A stand-in for Resend's two endpoints, driven off a fixed set of emails.
 * `failRetrieve` simulates the retrieve call erroring for specific ids.
 */
function makeResend(emails: ListItem[], opts: { failRetrieve?: string[] } = {}) {
  const calls = { list: 0, retrieve: [] as string[] }

  // `string | URL` rather than RequestInfo: the sweep only ever passes those
  // two, and RequestInfo is not in this test env's globals.
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))

    if (url.pathname === '/emails/receiving') {
      calls.list += 1
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const after = url.searchParams.get('after')
      const start = after ? emails.findIndex(e => e.id === after) + 1 : 0
      const page = emails.slice(start, start + limit)
      return new Response(
        JSON.stringify({
          object: 'list',
          has_more: start + limit < emails.length,
          data: page
        }),
        { status: 200 }
      )
    }

    const id = url.pathname.replace('/emails/receiving/', '')
    calls.retrieve.push(id)
    if (opts.failRetrieve?.includes(id)) {
      return new Response(JSON.stringify({ message: 'boom' }), { status: 500 })
    }
    const email = emails.find(e => e.id === id)
    if (!email) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(email), { status: 200 })
  })

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function testEnv(): ContactEnv {
  return { ...env, RESEND_API_KEY: 'test-resend-key' } as ContactEnv
}

/** Recent enough to sit inside the sweep's MAX_AGE_DAYS window. */
function recentIso(daysAgo = 1): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

async function countSubmissions(where = '1=1', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM contact_submissions WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe('syncInboundEmails', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM inbound_email_ledger').run()
  })

  it('ingests mail Resend has that the database does not', async () => {
    const { fetchImpl } = makeResend([
      {
        id: 'em_1',
        from: 'a@example.com',
        to: [NON_PUBLIC_RECIPIENT],
        subject: 'One',
        created_at: recentIso(),
        text: 'first'
      },
      {
        id: 'em_2',
        from: 'b@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Two',
        created_at: recentIso(),
        text: 'second'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.scanned).toBe(2)
    // One gated mailbox, one public one — the sweep ingests BOTH, which is the
    // whole point. Where they land differs; that they land does not.
    expect(result.filtered).toBe(1)
    expect(result.stored).toBe(1)
    expect(await countSubmissions()).toBe(2)
  })

  it('marks backfilled mail as read so a 30-day sweep does not detonate the unread badge', async () => {
    const { fetchImpl } = makeResend([
      {
        id: 'em_old',
        from: 'a@example.com',
        to: ['public@hadoku.me'],
        subject: 'Old news',
        created_at: recentIso(10),
        text: 'body'
      }
    ])

    await syncInboundEmails(testEnv(), fetchImpl)

    const row = await env.DB.prepare(
      'SELECT status FROM contact_submissions WHERE resend_email_id = ?'
    )
      .bind('em_old')
      .first<{ status: string }>()
    expect(row?.status).toBe('read')
  })

  it('skips ids already in the ledger', async () => {
    await recordInboundEmail(env.DB, {
      resendEmailId: 'em_seen',
      source: 'webhook',
      outcome: 'stored'
    })

    const { fetchImpl, calls } = makeResend([
      {
        id: 'em_seen',
        from: 'a@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Seen',
        created_at: recentIso(),
        text: 'body'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.scanned).toBe(1)
    expect(calls.retrieve).toHaveLength(0)
    expect(await countSubmissions()).toBe(0)
  })

  it('ADOPTS a submission the webhook already stored instead of duplicating it', async () => {
    // The pre-migration case: rows exist with no resend_email_id. Without
    // adoption the first sweep would show the user two of everything.
    await createSubmission(env.DB, {
      name: 'alice',
      email: 'alice@example.com',
      message: 'Subject: Already here\n\nthe body',
      ip_address: null,
      user_agent: 'Resend Inbound Email',
      referrer: null,
      recipient: 'matthaeus@hadoku.me'
    })

    const { fetchImpl } = makeResend([
      {
        id: 'em_dupe',
        from: 'alice@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Already here',
        created_at: recentIso(),
        text: 'the body'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.adopted).toBe(1)
    expect(result.stored).toBe(0)
    expect(await countSubmissions()).toBe(1)
    expect(await countSubmissions('resend_email_id = ?', 'em_dupe')).toBe(1)
  })

  it('does not re-adopt on a second sweep', async () => {
    await createSubmission(env.DB, {
      name: 'alice',
      email: 'alice@example.com',
      message: 'Subject: Twice\n\nbody',
      ip_address: null,
      user_agent: 'Resend Inbound Email',
      referrer: null,
      recipient: 'matthaeus@hadoku.me'
    })

    const emails: ListItem[] = [
      {
        id: 'em_twice',
        from: 'alice@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Twice',
        created_at: recentIso(),
        text: 'body'
      }
    ]

    await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)
    const second = await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)

    expect(second.adopted).toBe(0)
    expect(second.stored).toBe(0)
    expect(await countSubmissions()).toBe(1)
  })

  it('adopts a long-subject email instead of wedging on the D1 LIKE cap', async () => {
    // D1 raises "LIKE or GLOB pattern too complex" past a 50-BYTE pattern, so
    // matching the stored row with `message LIKE 'Subject: ...%'` threw for
    // every subject over ~40 characters. A throw skips the ledger write, so
    // the sweep retried the same email every ten minutes, forever. The match
    // is a substr() prefix compare now, which has no such bound.
    const subject = 'Your appointment request has been received and is awaiting confirmation'
    expect(`Subject: ${subject}`.length).toBeGreaterThan(50)

    await createSubmission(env.DB, {
      name: 'alice',
      email: 'alice@example.com',
      message: `Subject: ${subject}\n\nthe body`,
      ip_address: null,
      user_agent: 'Resend Inbound Email',
      referrer: null,
      recipient: 'matthaeus@hadoku.me'
    })

    const { fetchImpl } = makeResend([
      {
        id: 'em_long',
        from: 'alice@example.com',
        to: ['matthaeus@hadoku.me'],
        subject,
        created_at: recentIso(),
        text: 'the body'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.errors).toBe(0)
    expect(result.adopted).toBe(1)
    expect(await countSubmissions()).toBe(1)
  })

  it('recovers when a stored email lost its ledger row', async () => {
    // A sweep that died between the INSERT and the ledger write leaves the id
    // stamped on a row with nothing in the ledger. The next sweep sees the
    // email as fresh; if it tries to stamp that id onto some other id-less row
    // the UNIQUE index rejects it, the ledger write is skipped again, and the
    // email is wedged permanently. It has to recognise its own earlier work.
    await createSubmission(env.DB, {
      name: 'alice',
      email: 'alice@example.com',
      message: 'Subject: Repeat\n\nfirst copy',
      ip_address: null,
      user_agent: 'Resend Inbound Email',
      referrer: null,
      recipient: 'matthaeus@hadoku.me'
    })
    const stored = await createSubmission(env.DB, {
      name: 'alice',
      email: 'alice@example.com',
      message: 'Subject: Repeat\n\nsecond copy',
      ip_address: null,
      user_agent: 'Resend Inbound Email',
      referrer: null,
      recipient: 'matthaeus@hadoku.me',
      resend_email_id: 'em_orphan'
    })

    const { fetchImpl } = makeResend([
      {
        id: 'em_orphan',
        from: 'alice@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Repeat',
        created_at: recentIso(),
        text: 'second copy'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.errors).toBe(0)
    expect(result.adopted).toBe(1)
    // No third row, and the id stays on the row that already had it.
    expect(await countSubmissions()).toBe(2)
    expect(await countSubmissions('resend_email_id = ?', 'em_orphan')).toBe(1)

    const ledger = await env.DB.prepare(
      'SELECT submission_id, outcome FROM inbound_email_ledger WHERE resend_email_id = ?'
    )
      .bind('em_orphan')
      .first<{ submission_id: string; outcome: string }>()
    expect(ledger?.outcome).toBe('stored')
    expect(ledger?.submission_id).toBe(stored.id)
  })

  it('does NOT replay a forwarder recipient', async () => {
    // Firing a "new open spot" trigger from a reconciliation pass would act on
    // stale information in another service.
    const { fetchImpl } = makeResend([
      {
        id: 'em_fwd',
        from: 'noreply@pickleballkingdom.com',
        to: ['pickleball-waitlist@hadoku.me'],
        subject: 'A spot opened up',
        created_at: recentIso(),
        text: 'body'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.skipped).toBe(1)
    expect(await countSubmissions()).toBe(0)

    const ledger = await env.DB.prepare(
      'SELECT outcome FROM inbound_email_ledger WHERE resend_email_id = ?'
    )
      .bind('em_fwd')
      .first<{ outcome: string }>()
    expect(ledger?.outcome).toBe('forward_skipped')
  })

  it('leaves a failed retrieve unledgered so the next sweep retries it', async () => {
    const emails: ListItem[] = [
      {
        id: 'em_flaky',
        from: 'a@example.com',
        to: ['public@hadoku.me'],
        subject: 'Flaky',
        created_at: recentIso(),
        text: 'body'
      }
    ]

    const first = await syncInboundEmails(
      testEnv(),
      makeResend(emails, { failRetrieve: ['em_flaky'] }).fetchImpl
    )
    expect(first.errors).toBe(1)
    expect(await countSubmissions()).toBe(0)

    // Resend recovers; the sweep picks it up because nothing was ledgered.
    const second = await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)
    expect(second.stored).toBe(1)
    expect(await countSubmissions()).toBe(1)
  })

  it('stops at the archive horizon instead of resurrecting archived mail', async () => {
    // Older than MAX_AGE_DAYS: daily maintenance has already moved rows this
    // old into contact_submissions_archive. Re-ingesting them would push them
    // back into the active inbox on every poll, forever.
    const tooOld = new Date(
      Date.now() - (INBOUND_SYNC_CONFIG.MAX_AGE_DAYS + 5) * 24 * 60 * 60 * 1000
    ).toISOString()

    const { fetchImpl, calls } = makeResend([
      {
        id: 'em_recent',
        from: 'a@example.com',
        to: ['public@hadoku.me'],
        subject: 'Recent',
        created_at: recentIso(),
        text: 'body'
      },
      {
        id: 'em_ancient',
        from: 'b@example.com',
        to: ['public@hadoku.me'],
        subject: 'Ancient',
        created_at: tooOld,
        text: 'body'
      }
    ])

    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(result.scanned).toBe(1)
    expect(calls.retrieve).toEqual(['em_recent'])
    expect(await countSubmissions()).toBe(1)
  })

  it('caps ingests per run and drains the backlog over successive runs', async () => {
    // The regression this pins: the first production sweep ingested 26 emails,
    // each costing a sequential Resend retrieve, overran mgmt-api's 15s cron
    // dispatch, and paged "contact api unavailable" for work that had actually
    // completed. A reconciliation job that alerts on success is worse than none.
    const cap = INBOUND_SYNC_CONFIG.MAX_INGESTS_PER_RUN
    const emails: ListItem[] = Array.from({ length: cap + 5 }, (_, i) => ({
      id: `em_c${i}`,
      from: `sender${i}@example.com`,
      to: ['public@hadoku.me'],
      subject: `Mail ${i}`,
      created_at: recentIso(),
      text: 'body'
    }))

    const first = await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)
    expect(first.stored).toBe(cap)
    expect(first.truncated).toBe(true)
    expect(await countSubmissions()).toBe(cap)

    // Next run continues where it left off — no duplicates, no lost mail.
    const second = await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)
    expect(second.stored).toBe(5)
    expect(second.truncated).toBe(false)
    expect(await countSubmissions()).toBe(cap + 5)

    // And a third run has nothing left to do.
    const third = await syncInboundEmails(testEnv(), makeResend(emails).fetchImpl)
    expect(third.stored).toBe(0)
    expect(await countSubmissions()).toBe(cap + 5)
  })

  it('paginates until Resend reports no more pages', async () => {
    // Sized under the per-run ingest cap so this exercises PAGINATION only —
    // pages of already-seen mail cost no retrieves, so the cap never engages.
    const emails: ListItem[] = Array.from({ length: 150 }, (_, i) => ({
      id: `em_p${i}`,
      from: `sender${i}@example.com`,
      to: ['public@hadoku.me'],
      subject: `Mail ${i}`,
      created_at: recentIso(),
      text: 'body'
    }))

    for (const e of emails) {
      await recordInboundEmail(env.DB, {
        resendEmailId: e.id,
        source: 'webhook',
        outcome: 'stored'
      })
    }

    const { fetchImpl, calls } = makeResend(emails)
    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(calls.list).toBe(2)
    expect(result.scanned).toBe(150)
    expect(calls.retrieve).toHaveLength(0)
  })

  it('throws when RESEND_API_KEY is missing rather than reporting a clean sweep', async () => {
    const { fetchImpl } = makeResend([])
    await expect(
      syncInboundEmails({ ...env, RESEND_API_KEY: undefined } as ContactEnv, fetchImpl)
    ).rejects.toThrow('RESEND_API_KEY')
  })
})
