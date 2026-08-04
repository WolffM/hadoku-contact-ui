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
 * A tier missing from this list is not rejected — `resolveTier` rewrites it to
 * `public`, so the caller authenticates at the edge and then silently receives
 * public data. `wife` (2026-08-04) was exactly that case: it ranks above
 * service, and this worker would have served it the anonymous view with no 401,
 * no 403 and no log line. Keep it complete.
 */
const TIER_RANK: Record<string, number> = {
  public: 0,
  friend: 1,
  service: 2,
  wife: 3,
  admin: 4
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

export function createEdgeAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const secret = (c.env as { EDGE_AUTH_SECRET?: string }).EDGE_AUTH_SECRET
    const provided = c.req.header('X-Edge-Auth') ?? ''
    const trusted = !!secret && timingSafeEqual(provided, secret)

    let authContext: HadokuAuthContext
    if (trusted) {
      const rawTier = c.req.header('X-Hadoku-Tier') ?? 'public'
      const userType = (TIERS.has(rawTier) ? rawTier : 'public') as HadokuAuthContext['userType']
      authContext = { userType, credential: c.req.header('X-User-Key') ?? null }
    } else {
      // No provenance → public. Never trust an unverified X-Hadoku-Tier.
      authContext = { userType: 'public', credential: null }
    }

    c.set('authContext', authContext)
    await next()
  }
}
