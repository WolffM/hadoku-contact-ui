/**
 * The mailbox export: a second copy needs every row, in whatever state the
 * mail screen and the retention sweeps have left it.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

const ADMIN_HEADERS = {
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

interface ExportedRow {
  id: string
  status: string
  created_at: number
  recipient: string | null
  direction: string | null
  filtered_reason: string | null
  archived_at: number | null
  source: 'live' | 'archive'
  message: string
}

interface ExportBody {
  success: boolean
  data: { rows: ExportedRow[]; nextCursor: string | null }
}

async function exportPage(query = '', headers: Record<string, string> = ADMIN_HEADERS) {
  const res = await SELF.fetch(`https://test.com/contact/api/admin/export${query}`, { headers })
  return { status: res.status, json: (await res.json()) as ExportBody }
}

interface Row {
  id: string
  at: number
  status?: string
  direction?: string
  filtered_reason?: string | null
  recipient?: string | null
}

async function insertLive(row: Row) {
  await env.DB.prepare(
    `INSERT INTO contact_submissions
      (id, name, email, message, status, created_at, recipient, direction, filtered_reason, deleted_at, spammed_at)
     VALUES (?, 'Sender', 'sender@example.com', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      `Subject: ${row.id}\n\nbody of ${row.id}`,
      row.status ?? 'unread',
      row.at,
      row.recipient ?? 'me@hadoku.me',
      row.direction ?? 'inbound',
      row.filtered_reason ?? null,
      row.status === 'deleted' ? row.at + 1 : null,
      row.filtered_reason === 'blocked' ? row.at : null
    )
    .run()
}

async function insertArchived(id: string, at: number) {
  await env.DB.prepare(
    `INSERT INTO contact_submissions_archive
      (id, name, email, message, status, created_at, archived_at)
     VALUES (?, 'Sender', 'sender@example.com', ?, 'read', ?, ?)`
  )
    .bind(id, `Subject: ${id}\n\nbody of ${id}`, at, at + 5000)
    .run()
}

describe('GET /admin/export', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM contact_submissions_archive').run()

    await insertArchived('old-archived', 1000)
    await insertLive({ id: 'inbox', at: 2000 })
    await insertLive({ id: 'trashed', at: 3000, status: 'deleted' })
    await insertLive({ id: 'spam', at: 4000, filtered_reason: 'blocked' })
    await insertLive({ id: 'quarantined', at: 5000, filtered_reason: 'not_whitelisted' })
    await insertLive({ id: 'sent', at: 6000, direction: 'outbound', status: 'read' })
  })

  it('returns every row of both tables, oldest first, whatever its state', async () => {
    const { status, json } = await exportPage()
    expect(status).toBe(200)
    expect(json.data.rows.map(r => r.id)).toEqual([
      'old-archived',
      'inbox',
      'trashed',
      'spam',
      'quarantined',
      'sent'
    ])
    expect(json.data.nextCursor).toBeNull()
  })

  it('says which table a row came from and keeps the columns each one has', async () => {
    const { json } = await exportPage()
    const byId = new Map(json.data.rows.map(r => [r.id, r]))

    expect(byId.get('old-archived')).toMatchObject({
      source: 'archive',
      archived_at: 6000,
      recipient: null,
      direction: null
    })
    expect(byId.get('spam')).toMatchObject({
      source: 'live',
      archived_at: null,
      recipient: 'me@hadoku.me',
      direction: 'inbound',
      filtered_reason: 'blocked'
    })
    expect(byId.get('trashed')?.status).toBe('deleted')
    expect(byId.get('sent')?.message).toBe('Subject: sent\n\nbody of sent')
  })

  it('pages by cursor without repeating or skipping a row', async () => {
    const seen: string[] = []
    let query = '?limit=2'
    for (let page = 0; page < 5; page++) {
      const { json } = await exportPage(query)
      seen.push(...json.data.rows.map(r => r.id))
      if (!json.data.nextCursor) break
      query = `?limit=2&cursor=${encodeURIComponent(json.data.nextCursor)}`
    }
    expect(seen).toEqual(['old-archived', 'inbox', 'trashed', 'spam', 'quarantined', 'sent'])
  })

  it('pages across two rows stored in the same millisecond', async () => {
    await insertLive({ id: 'twin-a', at: 7000 })
    await insertLive({ id: 'twin-b', at: 7000 })

    const first = await exportPage('?since=7000&limit=1')
    expect(first.json.data.rows.map(r => r.id)).toEqual(['twin-a'])
    const second = await exportPage(
      `?since=7000&limit=1&cursor=${encodeURIComponent(first.json.data.nextCursor ?? '')}`
    )
    expect(second.json.data.rows.map(r => r.id)).toEqual(['twin-b'])
    expect(second.json.data.nextCursor).toBeNull()
  })

  it('`since` is an inclusive floor', async () => {
    const { json } = await exportPage('?since=5000')
    expect(json.data.rows.map(r => r.id)).toEqual(['quarantined', 'sent'])
  })

  it('refuses a floor, cursor or limit it cannot read', async () => {
    expect((await exportPage('?since=yesterday')).status).toBe(400)
    expect((await exportPage('?cursor=nonsense')).status).toBe(400)
    expect((await exportPage('?limit=0')).status).toBe(400)
    expect((await exportPage('?limit=201')).status).toBe(400)
  })

  it('is admin only', async () => {
    const { status } = await exportPage('', {
      'X-Edge-Auth': 'test-edge-secret',
      'X-Hadoku-Tier': 'service'
    })
    expect(status).toBe(403)
  })
})
