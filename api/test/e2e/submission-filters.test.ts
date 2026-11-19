/**
 * The mail list's folder filters.
 *
 * One noisy mailbox must not be able to bury the rest: a caller names the
 * mailboxes it wants (or does not want) and pages over that slice alone.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

interface Listed {
  submissions: { id: string; recipient: string | null; status: string }[]
  mailboxes: { recipient: string; total: number }[]
}

async function list(query: string): Promise<{ status: number; data: Listed }> {
  const response = await SELF.fetch(`https://test.com/contact/api/admin/submissions${query}`, {
    headers: ADMIN_HEADERS
  })
  const body = (await response.json()) as { data: Listed }
  return { status: response.status, data: body.data }
}

interface Row {
  id: string
  recipient: string | null
  age: number
  status?: string
  direction?: string
  filtered_reason?: string | null
}

async function insert(row: Row) {
  await env.DB.prepare(
    `INSERT INTO contact_submissions
      (id, name, email, message, status, created_at, recipient, direction, filtered_reason)
     VALUES (?, 'Sender', 'sender@example.com', 'Subject: hi\n\nbody', ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.status ?? 'unread',
      Date.now() - row.age,
      row.recipient,
      row.direction ?? 'inbound',
      row.filtered_reason ?? null
    )
    .run()
}

describe('submission list filters', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()

    // The shape that broke the mail screen: a personal message underneath a
    // pile of newer notifications to one alias.
    await insert({ id: 'personal', recipient: 'matthaeus@hadoku.me', age: 900_000 })
    await insert({ id: 'form', recipient: null, age: 800_000 })
    for (let i = 0; i < 5; i++) {
      await insert({ id: `npm-${i}`, recipient: 'npm@hadoku.me', age: i * 1000 })
    }
  })

  it('unfiltered is the whole live mailbox, newest first', async () => {
    const { status, data } = await list('?limit=100')
    expect(status).toBe(200)
    expect(data.submissions.map(s => s.id)).toEqual([
      'npm-0',
      'npm-1',
      'npm-2',
      'npm-3',
      'npm-4',
      'form',
      'personal'
    ])
  })

  it('exclude_mailbox pages past the noisy mailbox entirely', async () => {
    // A page of 2 holds nothing but notifications unfiltered...
    const buried = await list('?limit=2')
    expect(buried.data.submissions.map(s => s.id)).toEqual(['npm-0', 'npm-1'])

    // ...and holds the mail that was underneath them once they are excluded.
    const { data } = await list('?limit=2&exclude_mailbox=npm@hadoku.me')
    expect(data.submissions.map(s => s.id)).toEqual(['form', 'personal'])
  })

  it('exclude_mailbox keeps mail with no recipient', async () => {
    const { data } = await list('?exclude_mailbox=npm@hadoku.me,matthaeus@hadoku.me')
    expect(data.submissions.map(s => s.id)).toEqual(['form'])
  })

  it('mailbox returns only the named mailboxes, and pages within them', async () => {
    const first = await list('?mailbox=npm@hadoku.me&limit=3')
    expect(first.data.submissions.map(s => s.id)).toEqual(['npm-0', 'npm-1', 'npm-2'])

    const second = await list('?mailbox=npm@hadoku.me&limit=3&offset=3')
    expect(second.data.submissions.map(s => s.id)).toEqual(['npm-3', 'npm-4'])

    const both = await list('?mailbox=matthaeus@hadoku.me,%20NPM@hadoku.me&limit=100')
    expect(both.data.submissions).toHaveLength(6)
  })

  it('deleted=only is the trash, and the default never includes it', async () => {
    await insert({ id: 'binned', recipient: 'matthaeus@hadoku.me', age: 500, status: 'deleted' })

    const live = await list('?limit=100')
    expect(live.data.submissions.map(s => s.id)).not.toContain('binned')

    const trash = await list('?deleted=only')
    expect(trash.data.submissions.map(s => s.id)).toEqual(['binned'])

    const refused = await list('?deleted=yes')
    expect(refused.status).toBe(400)
  })

  it('mailboxes counts every folder whatever the filter, as the folder would show it', async () => {
    await insert({ id: 'binned', recipient: 'npm@hadoku.me', age: 500, status: 'deleted' })
    await insert({ id: 'sent', recipient: 'matthaeus@hadoku.me', age: 400, direction: 'outbound' })
    await insert({
      id: 'spam',
      recipient: 'matthaeus@hadoku.me',
      age: 300,
      filtered_reason: 'blocked'
    })

    const { data } = await list('?exclude_mailbox=npm@hadoku.me')
    expect(data.mailboxes).toEqual([
      { recipient: 'npm@hadoku.me', total: 5 },
      { recipient: 'matthaeus@hadoku.me', total: 1 }
    ])
  })

  it('refuses a filter naming more mailboxes than one statement can bind', async () => {
    const many = Array.from({ length: 41 }, (_, i) => `box${i}@hadoku.me`).join(',')
    const { status } = await list(`?mailbox=${many}`)
    expect(status).toBe(400)
  })

  it('a page past 100 rows answers instead of failing on the appointment lookup', async () => {
    for (let i = 0; i < 120; i++) {
      await insert({ id: `bulk-${i}`, recipient: 'pypi@hadoku.me', age: 2_000_000 + i })
    }
    const { status, data } = await list('?limit=250')
    expect(status).toBe(200)
    expect(data.submissions).toHaveLength(127)
  })
})
