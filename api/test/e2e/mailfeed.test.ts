/**
 * The scoped mail feed, end to end.
 *
 * The property under test is an EXCLUSION, so most of this file seeds mail the
 * caller must never see and asserts it does not come back. A test that only
 * checks the in-scope mail arrives would pass just as happily against a route
 * that returns the entire mailbox.
 *
 * As with admin-tier-split.test.ts, these exercise the WORKER gate only.
 * Edge-router is not in the loop, so `X-User-Id` is set here by the test. In
 * production that header is stripped from the client and re-injected from the
 * key registry — the mount in ../hadoku_site/workers/edge-router/src/index.ts
 * is what makes it proof of identity, and a green run here does not prove that
 * mount exists.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { MAILFEED_INBOUND_USER_AGENT } from '../../constants'

const SCOPED = {
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'service',
  'X-User-Id': 'user-jobplatform'
}

interface SeedRow {
  id: string
  email: string
  subject?: string
  body?: string
  createdAt: number
  direction?: 'inbound' | 'outbound'
  userAgent?: string | null
  status?: string
  filteredReason?: string | null
  spammedAt?: number | null
  archived?: boolean
}

async function seed(row: SeedRow) {
  const message =
    row.subject === undefined
      ? (row.body ?? 'plain')
      : `Subject: ${row.subject}\n\n${row.body ?? 'body'}`

  if (row.archived) {
    await env.DB.prepare(
      `INSERT INTO contact_submissions_archive
         (id, name, email, message, status, created_at, archived_at, ip_address, user_agent, referrer)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
    )
      .bind(
        row.id,
        row.email.split('@')[0],
        row.email,
        message,
        row.status ?? 'read',
        row.createdAt,
        row.createdAt,
        row.userAgent === undefined ? MAILFEED_INBOUND_USER_AGENT : row.userAgent
      )
      .run()
    return
  }

  await env.DB.prepare(
    `INSERT INTO contact_submissions
       (id, name, email, message, status, created_at, ip_address, user_agent, referrer,
        recipient, direction, resend_email_id, filtered_reason, spammed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'matthaeus@hadoku.me', ?, NULL, ?, ?)`
  )
    .bind(
      row.id,
      row.email.split('@')[0],
      row.email,
      message,
      row.status ?? 'read',
      row.createdAt,
      row.userAgent === undefined ? MAILFEED_INBOUND_USER_AGENT : row.userAgent,
      row.direction ?? 'inbound',
      row.filteredReason ?? null,
      row.spammedAt ?? null
    )
    .run()
}

interface FeedMessage {
  id: string
  receivedAt: number
  from: string
  fromDomain: string
  subject: string | null
  body: string
  source: 'live' | 'archive'
}

/** The 200 shape. A denial carries `success: false` and no `data`, and no test here reads both. */
interface FeedResponse {
  success: boolean
  data: { messages: FeedMessage[]; nextCursor: string | null }
}

async function fetchMessages(query = '', headers: Record<string, string> = SCOPED) {
  const res = await SELF.fetch(`https://test.com/contact/api/mailfeed/messages${query}`, {
    headers
  })
  return { status: res.status, json: (await res.json()) as FeedResponse }
}

async function idsFrom(query = ''): Promise<string[]> {
  const { json } = await fetchMessages(query)
  return json.data.messages.map(m => m.id)
}

describe('/mailfeed', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM contact_submissions_archive').run()
  })

  describe('the gate', () => {
    it('refuses a caller below service tier, scoped or not', async () => {
      const { status } = await fetchMessages('', {
        'X-Edge-Auth': 'test-edge-secret',
        'X-Hadoku-Tier': 'friend',
        'X-User-Id': 'user-jobplatform'
      })
      expect(status).toBe(403)
    })

    /**
     * The exception this feed makes to "a service route may not disclose" is
     * the per-identity scope, so a service key WITHOUT one must be refused —
     * otherwise the rule is simply waived and every worker key in the fleet
     * reads the mailbox.
     */
    it('refuses a service key that is not named in the grant table', async () => {
      const { status, json } = await fetchMessages('', {
        'X-Edge-Auth': 'test-edge-secret',
        'X-Hadoku-Tier': 'service',
        'X-User-Id': 'user-someone-else'
      })
      expect(status).toBe(403)
      expect(json.success).toBe(false)
    })

    it('refuses a service key carrying no identity at all', async () => {
      const { status } = await fetchMessages('', {
        'X-Edge-Auth': 'test-edge-secret',
        'X-Hadoku-Tier': 'service'
      })
      expect(status).toBe(403)
    })

    /**
     * Without X-Edge-Auth the tier stamp is not trusted and the caller degrades
     * to public — so a forged X-User-Id cannot reach the feed on its own.
     */
    it('refuses a request with no edge provenance', async () => {
      const { status } = await fetchMessages('', { 'X-User-Id': 'user-jobplatform' })
      expect(status).toBe(403)
    })

    it('publishes the caller its own scope', async () => {
      const res = await SELF.fetch('https://test.com/contact/api/mailfeed/scope', {
        headers: SCOPED
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { data: unknown }
      expect(json.data).toEqual({
        label: 'jobplatform',
        senderDomains: ['greenhouse.io', 'ashbyhq.com']
      })
    })
  })

  describe('what a scoped caller may see', () => {
    it('returns in-scope mail with subject and body split apart', async () => {
      await seed({
        id: 'm1',
        email: 'no-reply@greenhouse.io',
        subject: 'Thanks for applying to Datadog',
        body: 'We received your application.',
        createdAt: 1_700_000_000_000
      })

      const { json } = await fetchMessages()
      expect(json.data.messages).toHaveLength(1)
      expect(json.data.messages[0]).toMatchObject({
        id: 'm1',
        from: 'no-reply@greenhouse.io',
        fromDomain: 'greenhouse.io',
        subject: 'Thanks for applying to Datadog',
        body: 'We received your application.',
        source: 'live'
      })
    })

    it('matches a subdomain of a granted domain', async () => {
      await seed({ id: 'sub', email: 'bot@us.mail.greenhouse.io', createdAt: 1 })
      expect(await idsFrom()).toEqual(['sub'])
    })

    it('matches case-insensitively', async () => {
      await seed({ id: 'caps', email: 'Bot@GreenHouse.IO', createdAt: 1 })
      expect(await idsFrom()).toEqual(['caps'])
    })

    /**
     * The archive is half the mailbox. `archiveOldSubmissions` moves anything
     * past 30 days into it, so a feed that read only the live table would show
     * a consumer one month and call it the history.
     */
    it('reads the archive as well as the live table', async () => {
      await seed({ id: 'old', email: 'no-reply@greenhouse.io', createdAt: 1, archived: true })
      await seed({ id: 'new', email: 'no-reply@greenhouse.io', createdAt: 2 })
      const { json } = await fetchMessages()
      expect(json.data.messages.map(m => [m.id, m.source])).toEqual([
        ['old', 'archive'],
        ['new', 'live']
      ])
    })
  })

  describe('what it must never leak', () => {
    it('excludes a sender outside the grant', async () => {
      await seed({ id: 'private', email: 'friend@example.com', createdAt: 1 })
      await seed({ id: 'ats', email: 'no-reply@greenhouse.io', createdAt: 2 })
      expect(await idsFrom()).toEqual(['ats'])
    })

    /**
     * A near-miss domain, which is what a naive `LIKE '%greenhouse.io'` would
     * have handed over.
     */
    it('excludes a domain that merely ENDS with a granted one', async () => {
      await seed({ id: 'lookalike', email: 'x@notgreenhouse.io', createdAt: 1 })
      await seed({ id: 'suffixed', email: 'x@greenhouse.io.example.com', createdAt: 2 })
      expect(await idsFrom()).toEqual([])
    })

    /**
     * An outbound row's `email` column is the RECIPIENT, not the sender. So
     * without the direction filter, a reply the operator once sent to a
     * recruiter would come back as if the recruiter had written it — and its
     * body is the operator's own words.
     */
    it('excludes outbound mail addressed TO a granted domain', async () => {
      await seed({
        id: 'sent',
        email: 'recruiter@greenhouse.io',
        createdAt: 1,
        direction: 'outbound',
        userAgent: null
      })
      expect(await idsFrom()).toEqual([])
    })

    /**
     * The live half carries TWO independent exclusions — `direction` and the
     * inbound `user_agent` — and in ordinary data either one alone would do the
     * job, because nothing writes an outbound row with the inbound marker. Each
     * is pinned separately anyway: a filter whose only proof is that another
     * filter also catches the case is a filter nobody will notice losing.
     */
    it('excludes an outbound row even if it carries the inbound marker', async () => {
      await seed({
        id: 'sent-marked',
        email: 'recruiter@greenhouse.io',
        createdAt: 1,
        direction: 'outbound'
      })
      expect(await idsFrom()).toEqual([])
    })

    /**
     * The archive is where this actually bites. `contact_submissions_archive`
     * was created by migration 0001 and never gained a `direction` column, so
     * the inbound `user_agent` is the ONLY discriminator there — and a reply the
     * operator sent to a recruiter 40 days ago is exactly the row that ends up
     * in it.
     */
    it('excludes an archived row that is not inbound mail', async () => {
      await seed({
        id: 'sent-archived',
        email: 'recruiter@greenhouse.io',
        createdAt: 1,
        archived: true,
        userAgent: null
      })
      await seed({
        id: 'webform-archived',
        email: 'impostor@ashbyhq.com',
        createdAt: 2,
        archived: true,
        userAgent: 'Mozilla/5.0'
      })
      expect(await idsFrom()).toEqual([])
    })

    it('excludes a web-form submission that happens to claim a granted domain', async () => {
      await seed({
        id: 'webform',
        email: 'impostor@greenhouse.io',
        createdAt: 1,
        userAgent: 'Mozilla/5.0'
      })
      expect(await idsFrom()).toEqual([])
    })

    /**
     * Quarantined mail has not passed the inbound gate. Serving `blocked` mail
     * would let a sender the operator explicitly refused reach a consumer just
     * by forging a From domain.
     */
    it('excludes quarantined and blocked mail', async () => {
      await seed({
        id: 'filtered',
        email: 'x@greenhouse.io',
        createdAt: 1,
        filteredReason: 'not_whitelisted'
      })
      await seed({
        id: 'blocked',
        email: 'y@greenhouse.io',
        createdAt: 2,
        filteredReason: 'blocked',
        spammedAt: 2
      })
      expect(await idsFrom()).toEqual([])
    })

    it('excludes mail the operator deleted, live or archived', async () => {
      await seed({ id: 'trashed', email: 'x@greenhouse.io', createdAt: 1, status: 'deleted' })
      await seed({
        id: 'trashed-archived',
        email: 'y@greenhouse.io',
        createdAt: 2,
        status: 'deleted',
        archived: true
      })
      expect(await idsFrom()).toEqual([])
    })
  })

  describe('paging', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 5; i++) {
        await seed({ id: `p${i}`, email: 'no-reply@ashbyhq.com', createdAt: i })
      }
    })

    it('walks oldest-first and terminates', async () => {
      const seen: string[] = []
      let query = '?limit=2'
      for (let guard = 0; guard < 10; guard++) {
        const { json } = await fetchMessages(query)
        seen.push(...json.data.messages.map(m => m.id))
        if (!json.data.nextCursor) break
        query = `?limit=2&cursor=${encodeURIComponent(json.data.nextCursor)}`
      }
      expect(seen).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    })

    /**
     * Two mails in the same millisecond. A cursor carrying only the timestamp
     * must either re-serve one or skip one, and both are wrong for a consumer
     * deciding what it has already ingested.
     */
    it('does not repeat or skip rows sharing a timestamp', async () => {
      await env.DB.prepare('DELETE FROM contact_submissions').run()
      for (const id of ['t-a', 't-b', 't-c']) {
        await seed({ id, email: 'no-reply@ashbyhq.com', createdAt: 999 })
      }
      const first = await fetchMessages('?limit=2')
      const firstIds = first.json.data.messages.map(m => m.id)
      const second = await fetchMessages(
        `?limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor ?? '')}`
      )
      const secondIds = second.json.data.messages.map(m => m.id)
      expect([...firstIds, ...secondIds].sort()).toEqual(['t-a', 't-b', 't-c'])
      expect(second.json.data.nextCursor).toBeNull()
    })

    it('honours `since` as an inclusive floor', async () => {
      expect(await idsFrom('?since=3')).toEqual(['p3', 'p4', 'p5'])
    })

    it('accepts an ISO 8601 `since`', async () => {
      await seed({ id: 'iso', email: 'no-reply@ashbyhq.com', createdAt: Date.parse('2026-01-01') })
      expect(await idsFrom('?since=2025-06-01T00:00:00Z')).toEqual(['iso'])
    })

    /**
     * Rejected, not ignored. Dropping an unparseable floor would serve the
     * whole history to a caller that asked for a week of it, and look fine.
     */
    it('rejects an unparseable `since`', async () => {
      const { status } = await fetchMessages('?since=last-tuesday')
      expect(status).toBe(400)
    })

    it('caps an oversized limit instead of honouring it', async () => {
      const { status, json } = await fetchMessages('?limit=99999')
      expect(status).toBe(200)
      expect(json.data.messages.length).toBeLessThanOrEqual(200)
    })
  })
})
