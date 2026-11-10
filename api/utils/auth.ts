/**
 * Edge-auth middleware for the contact API.
 *
 * Part of the hadoku centralized auth channel: edge-router (hadoku.me)
 * resolves the caller's tier once and stamps every proxied request with
 * `X-Edge-Auth` (provenance) + `X-Hadoku-Tier`. This worker trusts that stamp
 * instead of resolving the caller's key itself.
 *
 * Was an inlined copy of `validateKeyAndGetType` + `createHadokuAuth` (the
 * duplicated key-validation that the auth-channel consolidation removes).
 * Mirrors @wolffm/worker-utils' `createEdgeAuth`; kept inlined to preserve
 * this package's no-worker-utils-dependency posture. If the edge-auth scheme
 * ever changes, update here AND in worker-utils/edgeAuth.ts.
 *
 * DEGRADE-TO-PUBLIC: a request without valid `X-Edge-Auth` (direct
 * *.workers.dev hit, e.g. the monitoring health probe) is treated as `public`
 * — the stamped tier is NOT trusted without provenance (blocks forgery). The
 * route guards (requireAdmin) 403 public callers on protected routes.
 */

import type { Context, Next, MiddlewareHandler } from 'hono'
import type { HadokuAuthContext } from '../types'

/**
 * The hadoku tier ladder, LOW to HIGH. MUST match TIER_RANK in
 * @wolffm/worker-utils; this package keeps its own copy to preserve the
 * no-worker-utils-dependency posture described above.
 *
 * A tier missing from this list is not rejected — `createEdgeAuth` rewrites it
 * to `public` (see `TIERS` below), so the caller authenticates at the edge and
 * then silently receives public data. `wife` (2026-08-04) was exactly that
 * case: it ranks above service, and this worker would have served it the
 * anonymous view with no 401, no 403 and no log line. `member` (added
 * 2026-11-06) was the same gap: every route here floors at `service` or
 * `admin`, so a member was refused either way, but it was refused as a
 * mislabeled `public` caller rather than as the member it actually is. Keep it
 * complete.
 */
export const TIER_RANK: Record<string, number> = {
  public: 0,
  member: 1,
  friend: 2,
  service: 3,
  wife: 4,
  admin: 5
}

const TIERS = new Set(Object.keys(TIER_RANK))

/**
 * Rank comparison — the ONLY way this worker should ask about tier.
 *
 * `auth.userType === 'admin'` is an exact match, so it locks every higher tier
 * out of a lower tier's branch. The handler gates here used to read
 * `userType !== 'admin' && userType !== 'service'`, an allowlist that excluded
 * `wife` the moment it existed even though wife outranks service.
 *
 * An unknown/absent tier has no rank and is admitted nowhere.
 */
export function tierAtLeast(
  auth: { userType?: string } | null | undefined,
  minTier: string
): boolean {
  const rank = auth?.userType === undefined ? -1 : (TIER_RANK[auth.userType] ?? -1)
  return rank >= (TIER_RANK[minTier] ?? Number.POSITIVE_INFINITY)
}

/** Constant-time compare; false on length mismatch (token is fixed-length hex). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * The edge-auth decision on its own, for the one path that is answered before
 * Hono routes (the mail-push WebSocket upgrade, see push/mail-push.ts).
 */
export function resolveEdgeAuth(
  env: { EDGE_AUTH_SECRET?: string },
  headers: Headers
): HadokuAuthContext {
  const secret = env.EDGE_AUTH_SECRET
  const provided = headers.get('X-Edge-Auth') ?? ''
  if (!secret || !timingSafeEqual(provided, secret)) {
    // No provenance → public. Never trust an unverified X-Hadoku-Tier.
    return { userType: 'public', credential: null }
  }
  const rawTier = headers.get('X-Hadoku-Tier') ?? 'public'
  const userType = (TIERS.has(rawTier) ? rawTier : 'public') as HadokuAuthContext['userType']
  return { userType, credential: headers.get('X-User-Key') ?? null }
}

export function createEdgeAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    c.set('authContext', resolveEdgeAuth(c.env as { EDGE_AUTH_SECRET?: string }, c.req.raw.headers))
    await next()
  }
}
