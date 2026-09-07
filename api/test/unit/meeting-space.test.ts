/**
 * The ArchiveBot meeting-space client.
 *
 * The behaviour worth pinning is what happens when ArchiveBot is UNAVAILABLE.
 * It is a local PM2 service behind a Cloudflare tunnel, so an outage is
 * ordinary rather than exceptional, and the wrong response to one is a privacy
 * regression: handing the guest the shared server invite would drop a stranger
 * into the main guild, which is precisely what a private space exists to
 * prevent. A failed provision must therefore produce NO link, not a fallback.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  provisionMeetingSpace,
  revokeMeetingSpace,
  spacesConfigured,
  isSpaceId
} from '../../services/meeting-space'
import { generateMeetingLink } from '../../services/meeting-links'
import type { ContactEnv } from '../../types'

const BASE = 'https://archivebot.test'
const CONFIGURED = {
  ARCHIVEBOT_BASE_URL: BASE,
  ARCHIVEBOT_SPACES_WEBHOOK_SECRET: 'spaces-secret',
  ARCHIVEBOT_SPACE_GUILD_ID: '1442248915599753339'
} as unknown as ContactEnv

const APPOINTMENT = {
  slotId: 'slot-2026-10-01-2026-10-01T17:00:00.000Z',
  name: 'Jane',
  email: 'jane@example.com',
  startTime: '2026-10-01T17:00:00.000Z',
  endTime: '2026-10-01T17:30:00.000Z'
}

describe('spacesConfigured', () => {
  it.each([
    ['both set', CONFIGURED, true],
    ['no secret', { ARCHIVEBOT_BASE_URL: BASE }, false],
    ['no base url', { ARCHIVEBOT_SPACES_WEBHOOK_SECRET: 's' }, false],
    ['neither', {}, false]
  ])('%s -> %s', (_n, env, expected) => {
    expect(spacesConfigured(env as ContactEnv)).toBe(expected)
  })
})

describe('isSpaceId', () => {
  it('accepts an opaque space token', () => {
    expect(isSpaceId('0a1b2c3d4e5f6071')).toBe(true)
  })

  // Bookings made before spaces shipped carry `discord-<slotId>` here. Sending
  // one to the revoke route would be a guaranteed 404 on every cancel.
  it('rejects a legacy discord- meeting id', () => {
    expect(isSpaceId('discord-slot-2026-10-01-2026-10-01T17:00:00.000Z')).toBe(false)
  })

  it.each([[null], [undefined], ['']])('rejects %s', v => {
    expect(isSpaceId(v as string | null)).toBe(false)
  })
})

describe('provisionMeetingSpace', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => fetchMock.deactivate())

  it('returns the invite and space id on success', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          success: true,
          spaceId: 'abc123def456',
          inviteUrl: 'https://discord.gg/xyz',
          expiresAt: '2026-10-09T17:00:00.000Z'
        })
      )

    const r = await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, CONFIGURED)
    expect(r).toMatchObject({
      ok: true,
      spaceId: 'abc123def456',
      inviteUrl: 'https://discord.gg/xyz'
    })
  })

  it('signs the body with an HMAC header', async () => {
    let seenSig: string | undefined
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(200, (opts: { headers?: Record<string, string> }) => {
        seenSig = opts.headers?.['x-hadoku-signature'] ?? opts.headers?.['X-Hadoku-Signature']
        return JSON.stringify({ success: true, spaceId: 'abc123def456', inviteUrl: 'u' })
      })

    await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, CONFIGURED)
    expect(seenSig).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('reports failure when ArchiveBot errors', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(507, JSON.stringify({ success: false, error: 'guild_at_capacity' }))

    const r = await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, CONFIGURED)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('guild_at_capacity')
  })

  it('reports failure when ArchiveBot is unreachable rather than throwing', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .replyWithError(new Error('connect ECONNREFUSED'))

    const r = await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, CONFIGURED)
    expect(r.ok).toBe(false)
  })

  // A 200 without the fields the booking needs is a contract break. Storing an
  // empty link would look like success everywhere downstream.
  it('treats a 200 with no spaceId as failure', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(200, JSON.stringify({ success: true }))

    const r = await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, CONFIGURED)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no spaceId')
  })

  it('makes no outbound call when spaces are unconfigured', async () => {
    // No interceptor registered: a call would fail under disableNetConnect.
    const r = await provisionMeetingSpace({ idempotencyKey: 'k', label: 'l' }, {} as ContactEnv)
    expect(r).toEqual({ ok: false, error: 'spaces_not_configured' })
  })
})

describe('generateMeetingLink — discord with spaces', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => fetchMock.deactivate())

  it('returns the space invite and stores the spaceId as meetingId', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          success: true,
          spaceId: 'aabbccddeeff',
          inviteUrl: 'https://discord.gg/private1'
        })
      )

    const r = await generateMeetingLink('discord', APPOINTMENT, CONFIGURED)
    expect(r.success).toBe(true)
    expect(r.meetingLink).toBe('https://discord.gg/private1')
    // The cancel path revokes by this value.
    expect(r.meetingId).toBe('aabbccddeeff')
  })

  // The assertion this whole module exists for.
  it('does NOT fall back to the shared invite when provisioning fails', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/provision', method: 'POST' })
      .reply(500, JSON.stringify({ success: false, error: 'missing_permissions' }))

    const r = await generateMeetingLink('discord', APPOINTMENT, {
      ...CONFIGURED,
      DISCORD_INVITE_URL: 'https://discord.gg/PublicServer'
    } as ContactEnv)

    expect(r.success).toBe(false)
    expect(r.meetingLink).toBeUndefined()
    // Dropping a stranger into the main guild is worse than no link at all.
    expect(JSON.stringify(r)).not.toContain('PublicServer')
  })

  it('still uses the shared invite when spaces are not configured at all', async () => {
    const r = await generateMeetingLink('discord', APPOINTMENT, {
      DISCORD_INVITE_URL: 'https://discord.gg/PublicServer'
    } as ContactEnv)

    expect(r.success).toBe(true)
    expect(r.meetingLink).toBe('https://discord.gg/PublicServer')
    expect(r.meetingId).toContain('discord-')
  })
})

describe('revokeMeetingSpace', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => fetchMock.deactivate())

  it('succeeds on a 200', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/revoke', method: 'POST' })
      .reply(200, JSON.stringify({ success: true, spaceId: 'abc123def456' }))

    expect(await revokeMeetingSpace('abc123def456', CONFIGURED)).toMatchObject({ ok: true })
  })

  it('reports failure without throwing — the cancel is already committed', async () => {
    fetchMock
      .get(BASE)
      .intercept({ path: '/api/spaces/revoke', method: 'POST' })
      .replyWithError(new Error('tunnel down'))

    const r = await revokeMeetingSpace('abc123def456', CONFIGURED)
    expect(r.ok).toBe(false)
  })
})
