/**
 * Mail push: tells open command-station tabs that new mail arrived.
 *
 * The whole surface is one bit — "the mailbox changed" — and the design keeps
 * it that way, because the socket is opened by an ADMIN session and anything
 * it could be made to carry or do would be reachable with that session:
 *
 * - The frame is `{"type":"mail"}`, always. No id, sender, subject or count. A
 *   tab that hears it re-reads the list over the normal authenticated API, so a
 *   socket that leaks discloses only that some mail arrived.
 * - Receive-only. Any frame FROM the client closes the socket (1008). There is
 *   no command to send, so there is nothing to parse.
 * - Opening a socket needs a single-use ticket, 30s TTL, minted by an admin
 *   POST whose Origin must be exactly https://hadoku.me. The session cookie is
 *   SameSite=Strict, but SameSite is per SITE, so every *.hadoku.me subdomain
 *   sends it; the Origin check is what keeps those out, and the ticket is what
 *   a cross-origin page cannot read even if a check were wrong.
 * - The upgrade itself is admin tier at the edge and here, Origin-checked
 *   again, and forwarded by edge-router with an allowlist of headers — the
 *   session cookie and the admin key never reach this worker on that path.
 * - A socket lives at most SOCKET_MAX_AGE_MS. The tab then mints a fresh ticket
 *   through the edge, so a revoked session stops receiving within that window.
 * - At most MAX_SOCKETS open and MAX_TICKETS outstanding. One operator, a
 *   handful of tabs; anything past that is not a legitimate use.
 * - The Durable Object has no route of its own. Only this worker holds its
 *   binding: the upgrade below and the ingest path's `notify()`.
 *
 * Hibernating WebSockets (`ctx.acceptWebSocket`), so an idle tab costs no
 * Durable Object duration.
 */

import { DurableObject } from 'cloudflare:workers'
import type { ContactEnv } from '../types'

export const MAIL_PUSH_PROTOCOL = 'hadoku-mailpush.v1'
/** The only Origin a ticket is minted for or an upgrade accepted from. */
export const MAIL_PUSH_ORIGIN = 'https://hadoku.me'
export const MAIL_PUSH_FRAME = JSON.stringify({ type: 'mail' })

export const TICKET_TTL_MS = 30_000
export const MAX_TICKETS = 16
export const MAX_SOCKETS = 8
export const SOCKET_MAX_AGE_MS = 10 * 60_000
/** Close code a tab treats as "mint a new ticket and reconnect". */
export const CLOSE_REAUTH = 4001

const TICKET_PREFIX = 'ticket:'
/** 32 random bytes, base64url, unpadded. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/
const TICKET_HEADER = 'X-Mail-Push-Ticket'

interface SocketAttachment {
  openedAt: number
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Tickets are stored by hash, so storage never holds a usable one. */
async function ticketKey(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  return TICKET_PREFIX + base64url(new Uint8Array(digest))
}

export class MailPushHub extends DurableObject<ContactEnv> {
  /** A fresh ticket, or null when MAX_TICKETS are already outstanding. Null,
   *  not a throw: an error crossing the RPC boundary loses its class, so the
   *  caller could not tell "too many" from a real failure. */
  async mintTicket(): Promise<string | null> {
    const now = Date.now()
    const outstanding = await this.ctx.storage.list<number>({ prefix: TICKET_PREFIX })
    let live = 0
    for (const [key, expiresAt] of outstanding) {
      if (expiresAt <= now) await this.ctx.storage.delete(key)
      else live += 1
    }
    if (live >= MAX_TICKETS) return null

    const ticket = base64url(crypto.getRandomValues(new Uint8Array(32)))
    await this.ctx.storage.put(await ticketKey(ticket), now + TICKET_TTL_MS)
    return ticket
  }

  /** Reached only through the worker's stub, with the ticket already parsed out. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }
    const ticket = request.headers.get(TICKET_HEADER) ?? ''
    if (!TICKET_SHAPE.test(ticket)) return new Response('invalid ticket', { status: 401 })

    // Consumed whether or not it is still valid: a ticket is good for one try.
    const key = await ticketKey(ticket)
    const expiresAt = await this.ctx.storage.get<number>(key)
    await this.ctx.storage.delete(key)
    const now = Date.now()
    if (expiresAt === undefined || expiresAt <= now) {
      return new Response('invalid ticket', { status: 401 })
    }

    if (this.openSockets().length >= MAX_SOCKETS) {
      return new Response('too many open sockets', { status: 429 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ openedAt: now } satisfies SocketAttachment)
    await this.scheduleExpiry()

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': MAIL_PUSH_PROTOCOL }
    })
  }

  /** Sockets still open — a socket mid-close is not a tab that can hear us. */
  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)
  }

  /** Broadcast the one frame this channel carries. Returns how many sockets heard it. */
  async notify(): Promise<number> {
    let sent = 0
    for (const ws of this.openSockets()) {
      try {
        ws.send(MAIL_PUSH_FRAME)
        sent += 1
      } catch (err) {
        console.warn('[mail-push] send failed; closing socket:', err)
        ws.close(1011, 'send failed')
      }
    }
    return sent
  }

  async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.close(1008, 'receive-only')
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Complete the closing handshake. 1005/1006 are reserved and cannot be
    // sent back, so answer those with a plain normal closure.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const { openedAt } = ws.deserializeAttachment() as SocketAttachment
      if (openedAt + SOCKET_MAX_AGE_MS <= now) ws.close(CLOSE_REAUTH, 'reauth')
    }
    await this.scheduleExpiry()
  }

  /** Point the alarm at the oldest open socket's deadline, or clear it. */
  private async scheduleExpiry(): Promise<void> {
    let earliest = Number.POSITIVE_INFINITY
    for (const ws of this.openSockets()) {
      const { openedAt } = ws.deserializeAttachment() as SocketAttachment
      earliest = Math.min(earliest, openedAt + SOCKET_MAX_AGE_MS)
    }
    if (earliest === Number.POSITIVE_INFINITY) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(earliest)
  }
}

function hubFor(env: ContactEnv): DurableObjectStub<MailPushHub> | null {
  if (!env.MAIL_PUSH) return null
  return env.MAIL_PUSH.get(env.MAIL_PUSH.idFromName('admin'))
}

/** Is this request from the one page allowed to use the channel? */
export function fromMailPushOrigin(request: Request): boolean {
  return request.headers.get('Origin') === MAIL_PUSH_ORIGIN
}

export type MintOutcome = { ticket: string } | { refused: 'not-configured' | 'too-many' }

export async function mintMailPushTicket(env: ContactEnv): Promise<MintOutcome> {
  const hub = hubFor(env)
  if (!hub) return { refused: 'not-configured' }
  const ticket = await hub.mintTicket()
  return ticket ? { ticket } : { refused: 'too-many' }
}

/**
 * The path a tab opens. Checked before any routing so the 101 response the
 * Durable Object returns goes back untouched — middleware that rewrites
 * headers would rebuild the Response and drop its `webSocket`.
 */
export function isMailPushUpgrade(request: Request, basePath: string): boolean {
  return (
    new URL(request.url).pathname === `${basePath}/admin/push` &&
    request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  )
}

/**
 * The upgrade. `isAdmin` comes from the edge-auth check the caller already ran.
 * Sec-WebSocket-Protocol must be exactly `[MAIL_PUSH_PROTOCOL, "t.<ticket>"]` —
 * a browser cannot set other headers on a WebSocket, and a query string would
 * put the ticket in request logs.
 */
export async function handleMailPushUpgrade(
  request: Request,
  env: ContactEnv,
  isAdmin: boolean
): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!isAdmin) return new Response('forbidden', { status: 403 })
  if (!fromMailPushOrigin(request)) return new Response('forbidden origin', { status: 403 })

  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
  const ticketEntry = offered.find(p => p.startsWith('t.'))
  if (offered.length !== 2 || !offered.includes(MAIL_PUSH_PROTOCOL) || !ticketEntry) {
    return new Response('bad subprotocol', { status: 400 })
  }

  const hub = hubFor(env)
  if (!hub) return new Response('mail push not configured', { status: 503 })

  // A fresh request: nothing of the caller's travels past this point but the
  // ticket. No cookie, no key, no edge headers.
  return hub.fetch('https://mail-push.internal/connect', {
    headers: { Upgrade: 'websocket', [TICKET_HEADER]: ticketEntry.slice(2) }
  })
}

/**
 * Called by ingest after a row lands. Best effort: a push that fails costs a
 * tab its instant refresh, never the mail, so the failure is logged and ingest
 * carries on.
 */
export async function notifyMailPush(env: ContactEnv): Promise<void> {
  const hub = hubFor(env)
  if (!hub) return
  try {
    await hub.notify()
  } catch (err) {
    console.error('[mail-push] notify failed:', err)
  }
}
