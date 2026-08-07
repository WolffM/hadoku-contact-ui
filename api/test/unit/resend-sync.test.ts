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
import { INBOUND_SYNC_CONFIG } from '../../constants'
import type { ContactEnv } from '../../types'

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
        to: ['matthaeus@hadoku.me'],
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
    // Neither sender is whitelisted and matthaeus@ is not a public recipient,
    // so both land quarantined — but they LAND, which is the whole point.
    expect(result.filtered).toBe(2)
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

  it('paginates until Resend reports no more pages', async () => {
    const emails: ListItem[] = Array.from({ length: 150 }, (_, i) => ({
      id: `em_p${i}`,
      from: `sender${i}@example.com`,
      to: ['public@hadoku.me'],
      subject: `Mail ${i}`,
      created_at: recentIso(),
      text: 'body'
    }))

    const { fetchImpl, calls } = makeResend(emails)
    const result = await syncInboundEmails(testEnv(), fetchImpl)

    expect(calls.list).toBe(2)
    expect(result.scanned).toBe(150)
    expect(await countSubmissions()).toBe(150)
  })

  it('throws when RESEND_API_KEY is missing rather than reporting a clean sweep', async () => {
    const { fetchImpl } = makeResend([])
    await expect(
      syncInboundEmails({ ...env, RESEND_API_KEY: undefined } as ContactEnv, fetchImpl)
    ).rejects.toThrow('RESEND_API_KEY')
  })
})
