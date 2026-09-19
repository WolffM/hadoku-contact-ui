/**
 * `/mailfeed` — a READ surface that discloses, deliberately, and is the one
 * exception to the rule in AGENTS.md that a service route may not.
 *
 * The rule's reason is that service tier is held by every worker key in the
 * fleet, so a disclosing route there is a route behind any of them. That reason
 * is answered here rather than waived: the gate is tier AND a per-identity
 * sender allowlist, so a service key that is not named in `MAILFEED_SCOPES`
 * gets a 403 exactly like a friend key does. The mail a caller can reach is a
 * subset chosen by the operator in a reviewable diff, not "whatever the
 * mailbox holds".
 *
 * Both halves are necessary and neither is sufficient:
 *
 *   tier   (X-Hadoku-Tier, edge-stamped)  — is the caller a service at all?
 *   scope  (X-User-Id, edge-injected)     — WHICH service, and allowed what?
 *
 * `X-User-Id` is trustworthy for the same reason the tier is: edge-router
 * strips any client-supplied value and re-injects it from the KV key registry,
 * under the same `X-Edge-Auth` seal. It requires `injectUserId: true` on the
 * /mailfeed mount in ../hadoku_site/workers/edge-router/src/index.ts — without
 * it the header never arrives and every request 403s as unidentified, which is
 * the correct way for that mistake to fail.
 */

import { Hono } from 'hono'
import { queryMailfeed } from '../storage/mailfeed'
import { resolveMailfeedScope, type ScopeDenial } from '../services/mailfeed-scope'
import type { AppContext, ContactEnv } from '../types'
import { tierAtLeast } from '../utils/auth'

/** Default page size, and the ceiling a caller may ask for. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Every denial is the same 403 body to the CALLER and a distinct line in the
 * log. A consumer cannot act on the difference between "you are not listed" and
 * "the binding is malformed" — both mean stop — but the operator very much can,
 * and only one of them means the feed is dark for everyone.
 */
const DENIAL_LOG: Record<ScopeDenial, string> = {
  not_configured: 'MAILFEED_SCOPES is unset or unparseable — the feed is closed to every caller',
  unidentified_caller: 'no X-User-Id on the request — is injectUserId set on the edge mount?',
  unconfigured_caller: 'caller holds a valid service key but is not named in MAILFEED_SCOPES',
  invalid_scope: 'the caller is named but its scope grants no sender domains'
}

export function createMailfeedRoutes() {
  const app = new Hono<AppContext>()

  app.use('*', async (c, next) => {
    const auth = c.get('authContext')
    if (!tierAtLeast(auth, 'service')) {
      return c.json({ success: false, error: 'Forbidden', message: 'Service access required' }, 403)
    }

    const userId = c.req.header('X-User-Id') ?? null
    const resolved = resolveMailfeedScope((c.env as ContactEnv).MAILFEED_SCOPES, userId)
    if (!resolved.allowed) {
      console.warn(`[mailfeed] denied ${userId ?? '(no id)'}: ${DENIAL_LOG[resolved.reason]}`)
      return c.json(
        { success: false, error: 'Forbidden', message: 'No mail feed scope for this caller' },
        403
      )
    }

    c.set('mailfeedScope', resolved.scope)
    await next()
  })

  /**
   * What am I allowed to see?
   *
   * Exists so a consumer can ASSERT its grant instead of inferring it from what
   * happens to come back. An empty page is ambiguous — a scope that lost a
   * domain and a week with no mail from it look identical — and a consumer
   * whose job is detecting silence must be able to tell those apart.
   */
  app.get('/scope', c => {
    const scope = c.get('mailfeedScope')
    return c.json({
      success: true,
      data: { label: scope.label, senderDomains: scope.senderDomains }
    })
  })

  /**
   * A page of in-scope mail, oldest first.
   *
   * `?since=` (epoch millis) and `?cursor=` compose: `since` is a floor the
   * caller sets once, `cursor` is where it got to. A consumer with no state
   * calls this with neither and walks the whole history; the same loop, run
   * again tomorrow from its last cursor, is the incremental poll. There is no
   * separate import path, because a separate import path is a second
   * implementation of the same matching rules.
   */
  app.get('/messages', async c => {
    const scope = c.get('mailfeedScope')

    const rawLimit = Number(c.req.query('limit') ?? DEFAULT_LIMIT)
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT

    const rawSince = c.req.query('since')
    let since: number | null = null
    if (rawSince !== undefined) {
      // Accept epoch millis or an ISO 8601 timestamp. A value that is neither
      // is REJECTED rather than ignored: silently dropping an unparseable
      // `since` would serve the whole history to a caller that asked for a
      // week of it, and it would look like it worked.
      const asNumber = Number(rawSince)
      const parsed =
        Number.isFinite(asNumber) && rawSince.trim() !== '' ? asNumber : Date.parse(rawSince)
      if (!Number.isFinite(parsed)) {
        return c.json(
          {
            success: false,
            error: 'Bad Request',
            message: '`since` must be epoch millis or ISO 8601'
          },
          400
        )
      }
      since = parsed
    }

    try {
      const page = await queryMailfeed(c.env.DB, {
        scope,
        since,
        cursor: c.req.query('cursor') ?? null,
        limit
      })
      return c.json({ success: true, data: page })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[mailfeed] query failed for ${scope.label}: ${message}`)
      return c.json({ success: false, error: 'Internal Server Error' }, 500)
    }
  })

  return app
}
