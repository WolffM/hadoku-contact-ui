/**
 * Mail push, end to end in workerd: ticket → upgrade → a signed webhook lands
 * mail → the socket hears one content-free frame.
 *
 * Most of this file is refusals. The channel is opened by an admin session, so
 * every way in that is not exactly the intended one must be closed: wrong or
 * missing Origin (a *.hadoku.me subdomain carries the session cookie), a
 * non-admin tier, a reused or expired ticket, a malformed subprotocol, too many
 * sockets, a client that talks back, and a socket that outlives its session.
 */
import { env, SELF, fetchMock, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  CLOSE_REAUTH,
  MAIL_PUSH_FRAME,
  MAIL_PUSH_ORIGIN,
  MAIL_PUSH_PROTOCOL,
  MAX_SOCKETS,
  MAX_TICKETS,
  SOCKET_MAX_AGE_MS,
  type MailPushHub
} from '../../push/mail-push'
import { postWebhook } from './webhook-helpers'
import { addToBlocklist } from '../../storage'

const EDGE = { 'X-Edge-Auth': 'test-edge-secret' }
const ADMIN = { ...EDGE, 'X-Hadoku-Tier': 'admin' }
const BASE = 'https://test.com/contact/api'

function hub() {
  return env.MAIL_PUSH.get(env.MAIL_PUSH.idFromName('admin'))
}

async function mintTicket(
  headers: Record<string, string> = { ...ADMIN, Origin: MAIL_PUSH_ORIGIN }
) {
  return SELF.fetch(`${BASE}/admin/push/ticket`, { method: 'POST', headers })
}

async function ticket(): Promise<string> {
  const res = await mintTicket()
  expect(res.status).toBe(200)
  const body = await res.json<{ data: { ticket: string } }>()
  return body.data.ticket
}

function upgrade(t: string, headers: Record<string, string> = {}, protocols?: string) {
  return SELF.fetch(`${BASE}/admin/push`, {
    headers: {
      ...ADMIN,
      Origin: MAIL_PUSH_ORIGIN,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': protocols ?? `${MAIL_PUSH_PROTOCOL}, t.${t}`,
      ...headers
    }
  })
}

interface Client {
  ws: WebSocket
  frames: string[]
  closed: Promise<{ code: number; reason: string }>
  next: () => Promise<string>
}

async function connect(): Promise<Client> {
  const res = await upgrade(await ticket())
  expect(res.status).toBe(101)
  expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(MAIL_PUSH_PROTOCOL)
  const ws = res.webSocket!
  ws.accept()
  const frames: string[] = []
  const waiters: Array<(f: string) => void> = []
  ws.addEventListener('message', e => {
    const f = String(e.data)
    const w = waiters.shift()
    if (w) w(f)
    else frames.push(f)
  })
  const closed = new Promise<{ code: number; reason: string }>(resolve =>
    ws.addEventListener('close', e => resolve({ code: e.code, reason: e.reason }))
  )
  const next = () =>
    frames.length > 0
      ? Promise.resolve(frames.shift()!)
      : new Promise<string>((resolve, reject) => {
          waiters.push(resolve)
          setTimeout(() => reject(new Error('no frame within 2s')), 2000)
        })
  return { ws, frames, closed, next }
}

async function closeAll() {
  await runInDurableObject(hub(), async (_instance: MailPushHub, state) => {
    for (const ws of state.getWebSockets()) ws.close(1000, 'test teardown')
    await state.storage.deleteAll()
  })
}

function mockRetrieve(emailId: string, text: string) {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: `/emails/receiving/${emailId}`, method: 'GET' })
    .reply(200, JSON.stringify({ id: emailId, text }))
}

/**
 * vitest-pool-workers reloads the entry module on first use, which invalidates
 * a Durable Object created against the old one and asks the caller to retry.
 * That is a harness artefact, so it is absorbed once here rather than in a test.
 */
async function warmHub() {
  try {
    await runInDurableObject(hub(), async () => undefined)
  } catch (err) {
    if (!String(err).includes('invalidating this Durable Object')) throw err
    await runInDurableObject(hub(), async () => undefined)
  }
}

describe('mail push', () => {
  beforeAll(warmHub)

  beforeEach(async () => {
    await closeAll()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(async () => {
    fetchMock.deactivate()
    await closeAll()
  })

  describe('ticket', () => {
    it('is minted for an admin on the exact origin, uncacheable', async () => {
      const res = await mintTicket()
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      const { data } = await res.json<{ data: { ticket: string } }>()
      expect(data.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it.each([
      ['a subdomain (same-site, so it carries the cookie)', 'https://task-api.hadoku.me'],
      ['a lookalike host', 'https://hadoku.me.evil.example'],
      ['http on the same host', 'http://hadoku.me'],
      ['localhost', 'http://localhost:4321']
    ])('is refused from %s', async (_label, origin) => {
      expect((await mintTicket({ ...ADMIN, Origin: origin })).status).toBe(403)
    })

    it('is refused with no Origin at all', async () => {
      expect((await mintTicket({ ...ADMIN })).status).toBe(403)
    })

    it.each(['friend', 'service', 'wife'])('is refused to the %s tier', async tier => {
      const res = await mintTicket({ ...EDGE, 'X-Hadoku-Tier': tier, Origin: MAIL_PUSH_ORIGIN })
      expect(res.status).toBe(403)
    })

    it('is refused when the tier is not edge-sealed', async () => {
      const res = await mintTicket({ 'X-Hadoku-Tier': 'admin', Origin: MAIL_PUSH_ORIGIN })
      expect(res.status).toBe(403)
    })

    it(`caps outstanding tickets at ${MAX_TICKETS}`, async () => {
      for (let i = 0; i < MAX_TICKETS; i++) await ticket()
      expect((await mintTicket()).status).toBe(429)
    })

    it('is stored only as a hash', async () => {
      const t = await ticket()
      const keys = await runInDurableObject(hub(), async (_i: MailPushHub, state) => [
        ...(await state.storage.list()).keys()
      ])
      expect(keys).toHaveLength(1)
      expect(keys[0]).not.toContain(t)
    })
  })

  describe('upgrade', () => {
    it('opens, and a stored inbound mail pushes exactly the one content-free frame', async () => {
      const client = await connect()
      mockRetrieve('em_push', 'hello')
      const res = await postWebhook({
        email_id: 'em_push',
        from: 'Someone <someone@example.com>',
        to: ['matthaeus@hadoku.me'],
        subject: 'A private subject'
      })
      expect(res.status).toBe(200)
      const frame = await client.next()
      expect(frame).toBe(MAIL_PUSH_FRAME)
      expect(JSON.parse(frame)).toEqual({ type: 'mail' })
      expect(frame).not.toContain('someone')
      expect(frame).not.toContain('private')
    })

    it('stays quiet for mail from a blocked sender', async () => {
      await addToBlocklist(env.DB, {
        pattern: 'spam@example.com',
        kind: 'address',
        blockedBy: 'test'
      })
      const client = await connect()
      mockRetrieve('em_blocked', 'buy now')
      await postWebhook({
        email_id: 'em_blocked',
        from: 'spam@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'x'
      })
      // A later notify proves the socket is live and nothing came before it.
      await hub().notify()
      expect(await client.next()).toBe(MAIL_PUSH_FRAME)
      expect(client.frames).toHaveLength(0)
    })

    it('a ticket opens one socket, once', async () => {
      const t = await ticket()
      expect((await upgrade(t)).status).toBe(101)
      expect((await upgrade(t)).status).toBe(401)
    })

    it('refuses an expired ticket', async () => {
      const t = await ticket()
      await runInDurableObject(hub(), async (_i: MailPushHub, state) => {
        for (const key of (await state.storage.list()).keys()) await state.storage.put(key, 0)
      })
      expect((await upgrade(t)).status).toBe(401)
    })

    it('refuses a ticket it never minted', async () => {
      expect((await upgrade('A'.repeat(43))).status).toBe(401)
    })

    it.each([
      ['no Origin', { Origin: '' }],
      ['a subdomain Origin', { Origin: 'https://task-api.hadoku.me' }]
    ])('refuses %s', async (_label, headers) => {
      expect((await upgrade(await ticket(), headers)).status).toBe(403)
    })

    it('refuses a non-admin tier', async () => {
      const res = await upgrade(await ticket(), { 'X-Hadoku-Tier': 'friend' })
      expect(res.status).toBe(403)
    })

    it('refuses an unsealed admin claim', async () => {
      const res = await upgrade(await ticket(), { 'X-Edge-Auth': 'wrong' })
      expect(res.status).toBe(403)
    })

    it.each([
      ['no ticket entry', () => MAIL_PUSH_PROTOCOL],
      ['no protocol entry', (t: string) => `t.${t}`],
      ['an extra entry', (t: string) => `${MAIL_PUSH_PROTOCOL}, t.${t}, chat`],
      ['the wrong protocol version', (t: string) => `hadoku-mailpush.v0, t.${t}`]
    ])('refuses a subprotocol with %s', async (_label, protocols) => {
      const t = await ticket()
      expect((await upgrade(t, {}, protocols(t))).status).toBe(400)
    })

    it('a non-upgrade GET on the path is not the channel', async () => {
      const res = await SELF.fetch(`${BASE}/admin/push`, {
        headers: { ...ADMIN, Origin: MAIL_PUSH_ORIGIN }
      })
      expect(res.status).toBe(404)
    })

    it(`caps open sockets at ${MAX_SOCKETS}`, async () => {
      for (let i = 0; i < MAX_SOCKETS; i++) await connect()
      expect((await upgrade(await ticket())).status).toBe(429)
    })
  })

  describe('socket', () => {
    it('is receive-only: any client frame closes it with 1008', async () => {
      const client = await connect()
      client.ws.send('{"type":"anything"}')
      expect((await client.closed).code).toBe(1008)
    })

    it(`is closed for re-auth once older than ${SOCKET_MAX_AGE_MS / 60000} minutes`, async () => {
      const client = await connect()
      await runInDurableObject(hub(), async (_i: MailPushHub, state) => {
        for (const ws of state.getWebSockets()) ws.serializeAttachment({ openedAt: 0 })
      })
      expect(await runDurableObjectAlarm(hub())).toBe(true)
      expect((await client.closed).code).toBe(CLOSE_REAUTH)
    })

    it('a young socket survives the alarm', async () => {
      const client = await connect()
      await runDurableObjectAlarm(hub())
      await hub().notify()
      expect(await client.next()).toBe(MAIL_PUSH_FRAME)
    })
  })
})
