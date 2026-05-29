/**
 * Edge-auth middleware for the contact API.
 *
 * Part of the hadoku centralized auth channel: edge-router (hadoku.me)
 * resolves the caller's tier once and stamps every proxied request with
 * `X-Edge-Auth` (provenance) + `X-Hadoku-Tier`. This worker trusts that stamp
 * instead of re-validating ADMIN_KEYS/FRIEND_KEYS.
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

const TIERS = new Set(['public', 'friend', 'service', 'admin'])

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
