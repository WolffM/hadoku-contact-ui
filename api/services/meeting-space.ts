/**
 * Private Discord meeting spaces, via ArchiveBot.
 *
 * A Discord booking used to hand every guest the same static server invite.
 * They landed in the main guild and saw whatever `@everyone` sees. A space is
 * the isolated alternative: ArchiveBot carves out a category holding a `chat`
 * text channel and a `Meeting Room` voice channel, visible only to a role it
 * mints for that one guest, and returns a single-use invite that assigns the
 * role on join. After a TTL the whole thing is deleted and the guest kicked.
 *
 * ## Auth
 *
 * HMAC-SHA256 over the RAW request body as `X-Hadoku-Signature: sha256=<hex>`.
 * The body is stringified ONCE by the caller and sent byte-for-byte as signed —
 * re-serializing would risk a key-order change breaking the signature. There is
 * no nonce, so every body carries a `timestamp` ArchiveBot rejects outside ten
 * minutes, and writes add an idempotency key on top.
 *
 * Mirrors hadoku-meet's `worker/src/lib/archivebot.ts`, which is the same
 * scheme against the same server. It is not imported: that lives in
 * @wolffm/worker-utils' orbit and this package deliberately carries no
 * worker-utils dependency (see api/utils/auth.ts). If the signing scheme
 * changes, it changes in both.
 *
 * ## Failure is NOT a fallback to the static invite
 *
 * If provisioning fails, this reports failure and the booking stores no
 * meeting link — it does not quietly hand out the general server invite. The
 * whole point of a space is that a stranger does not land in the main guild,
 * so silently degrading to the thing we are replacing would turn an outage
 * into a privacy regression. A linkless booking is honest: the confirmation
 * email already says the link could not be generated and asks them to reply.
 */

import type { ContactEnv } from '../types'

/** ArchiveBot's own bound; a request older than this is refused there. */
const TIMESTAMP_WINDOW_NOTE = '10 minutes — see lib/meetingSpace.js'

/** Local PM2 service behind a tunnel: slow is likelier than wrong. */
const DEFAULT_TIMEOUT_MS = 15_000

export interface MeetingSpaceResult {
  ok: boolean
  spaceId?: string
  inviteUrl?: string
  expiresAt?: string
  error?: string
}

interface SpaceProvisionResponse {
  success?: boolean
  spaceId?: string
  inviteUrl?: string
  expiresAt?: string
  deduped?: boolean
  error?: string
}

/**
 * Is this deployment configured to provision spaces at all? A deployment
 * without the secret offers plain Discord invites, and must not start failing
 * bookings over a feature it never enabled.
 */
export function spacesConfigured(env: ContactEnv): boolean {
  return Boolean(env.ARCHIVEBOT_SPACES_WEBHOOK_SECRET && env.ARCHIVEBOT_BASE_URL)
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function signedPost(
  url: string,
  secret: string,
  body: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hadoku-Signature': `sha256=${await hmacHex(secret, body)}`
    },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  })
}

export interface ProvisionInput {
  /** Stable per-appointment key. A retry must not burn a second space. */
  idempotencyKey: string
  /** Operator-facing description. NEVER used as a Discord name — ArchiveBot
   *  generates opaque names precisely so a role list cannot leak who booked. */
  label: string
  ttlMs?: number
}

/**
 * Ask ArchiveBot for a space. Resolves with `ok: false` rather than throwing:
 * every caller here treats a missing space as a degraded booking, not a failed
 * one, and an exception crossing into the submit path would fail the booking.
 */
export async function provisionMeetingSpace(
  input: ProvisionInput,
  env: ContactEnv
): Promise<MeetingSpaceResult> {
  if (!spacesConfigured(env)) {
    return { ok: false, error: 'spaces_not_configured' }
  }

  const body = JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    // Freshly stamped: ArchiveBot refuses a body older than its window.
    timestamp: Date.now(),
    label: input.label,
    ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    ...(env.ARCHIVEBOT_SPACE_GUILD_ID ? { guild_id: env.ARCHIVEBOT_SPACE_GUILD_ID } : {}),
    source: 'contact-api'
  })

  try {
    const res = await signedPost(
      `${env.ARCHIVEBOT_BASE_URL}/api/spaces/provision`,
      env.ARCHIVEBOT_SPACES_WEBHOOK_SECRET as string,
      body
    )
    const data = (await res.json().catch(() => null)) as SpaceProvisionResponse | null

    if (!res.ok || !data?.success) {
      return {
        ok: false,
        error: `archivebot ${res.status}: ${data?.error ?? 'unreadable response'}`
      }
    }
    if (!data.spaceId || !data.inviteUrl) {
      // A 200 without the two fields the booking needs is a contract break,
      // not a success — treat it as failure rather than storing an empty link.
      return { ok: false, error: 'archivebot returned no spaceId/inviteUrl' }
    }

    return {
      ok: true,
      spaceId: data.spaceId,
      inviteUrl: data.inviteUrl,
      expiresAt: data.expiresAt
    }
  } catch (error) {
    // ArchiveBot is a local PM2 service behind a Cloudflare tunnel; a timeout
    // or connection refusal is an ordinary outage, not an exceptional one.
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown error reaching archivebot'
    }
  }
}

/**
 * Tear a space down early, when its booking is cancelled. Best-effort and
 * never throwing: the cancel itself has already been committed by the time
 * this runs, and failing it would leave the caller thinking the cancel failed.
 *
 * A space that survives this is not lost — it still expires on its TTL and the
 * nightly sweep collects it. This just returns the channels sooner.
 */
export async function revokeMeetingSpace(
  spaceId: string,
  env: ContactEnv
): Promise<MeetingSpaceResult> {
  if (!spacesConfigured(env)) {
    return { ok: false, error: 'spaces_not_configured' }
  }

  const body = JSON.stringify({
    idempotencyKey: `revoke-${spaceId}`,
    timestamp: Date.now(),
    spaceId,
    ...(env.ARCHIVEBOT_SPACE_GUILD_ID ? { guild_id: env.ARCHIVEBOT_SPACE_GUILD_ID } : {}),
    source: 'contact-api'
  })

  try {
    const res = await signedPost(
      `${env.ARCHIVEBOT_BASE_URL}/api/spaces/revoke`,
      env.ARCHIVEBOT_SPACES_WEBHOOK_SECRET as string,
      body
    )
    const data = (await res.json().catch(() => null)) as SpaceProvisionResponse | null
    if (!res.ok || !data?.success) {
      return { ok: false, error: `archivebot ${res.status}: ${data?.error ?? 'unreadable'}` }
    }
    return { ok: true, spaceId }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown error reaching archivebot'
    }
  }
}

/**
 * Does this appointment's meeting_id name a space? Spaces are stored there
 * (opaque base36 token); the pre-space Discord bookings stored
 * `discord-<slotId>`, which must not be sent to the revoke route.
 */
export function isSpaceId(meetingId: string | null | undefined): boolean {
  return typeof meetingId === 'string' && /^[0-9a-z]{12,}$/.test(meetingId)
}

export { TIMESTAMP_WINDOW_NOTE }

/**
 * A link the OPERATOR can click, which is not the guest's invite.
 *
 * `meeting_link` on a Discord booking is a `maxUses: 1` invite minted for one
 * guest. The command station rendered it as "Join Meeting", so the operator's
 * own admin UI offered them the one link they must not use — at best it is
 * useless to someone already in the guild, and it is the guest's only way in.
 *
 * This routes to the guild instead, which Discord opens in the viewer's own
 * session. It is derived, not stored: no column, no migration, and nothing to
 * fall out of sync with the space it points at.
 *
 * Returns null for anything that is not a Discord booking with a real space —
 * a Jitsi or Meet link is already the right link for everyone, and a pre-space
 * Discord booking has only the shared invite, which the operator can click
 * harmlessly.
 */
export function operatorLinkFor(
  // platform is NULLABLE on a stored appointment — migration 0009 made it
  // optional for admin-created events that name no platform at all.
  appointment: { platform: string | null; meeting_id?: string | null },
  env: ContactEnv
): string | null {
  if (appointment.platform !== 'discord') return null
  if (!isSpaceId(appointment.meeting_id)) return null
  const guildId = env.ARCHIVEBOT_SPACE_GUILD_ID
  return guildId ? `https://discord.com/channels/${guildId}` : null
}
