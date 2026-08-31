/**
 * Admin routes for managing contact submissions
 *
 * All routes require admin authentication.
 * Split into domain-specific modules.
 */

import { Hono, type Context, type Next } from 'hono'
// Not re-exported from the package root — hono keeps its status-code types in
// this subpath. The root import compiled only because nothing ever typechecked
// this tree.
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createSubmissionRoutes } from './submissions'
import { createEmailRoutes } from './email'
import { createBlocklistRoutes } from './blocklist'
import { createAppointmentAdminRoutes, createAppointmentStatusRoutes } from './appointments'
import { createTemplateRoutes } from './templates'
import type { AppContext } from '../../types'
import { tierAtLeast } from '../../utils/auth'

/**
 * Admin API response helper - matches contact-admin client expectations
 * Returns { success: true, data: T } instead of { data: T, timestamp: string }
 */
export function adminOk<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ success: true, data }, status)
}

function requireTier(minTier: 'service' | 'admin', label: string) {
  return async (c: Context<AppContext>, next: Next) => {
    const auth = c.get('authContext')

    // Admin is the top tier, so the string compare admitted the right set
    // today — but it is the pattern that produced the /internal/run-daily bug
    // one file over, and it silently stops being correct the moment anything
    // is added above admin. Rank, not equality.
    if (!tierAtLeast(auth, minTier)) {
      return c.json(
        {
          success: false,
          error: 'Forbidden',
          message: `${label} access required`
        },
        403
      )
    }

    await next()
  }
}

/**
 * The admin surface. Uniformly admin-tier — no exceptions, no path carve-outs.
 *
 * The service-tier half of the API lives at a different PREFIX entirely
 * (`createServiceRoutes`, mounted at /service), not as a hole in this gate.
 * See "Admin and service surfaces" in CLAUDE.md for why, and for the rule
 * governing what is allowed to live there.
 */
export function createAdminRoutes() {
  const app = new Hono<AppContext>()

  const adminApp = new Hono<AppContext>()
  adminApp.use('*', requireTier('admin', 'Admin'))
  adminApp.route('/', createSubmissionRoutes())
  adminApp.route('/', createEmailRoutes())
  adminApp.route('/', createBlocklistRoutes())
  adminApp.route('/', createAppointmentAdminRoutes())
  adminApp.route('/', createTemplateRoutes())
  // Also reachable here, at admin tier: the command-station UI calls
  // /admin/appointments/:id/status and predates the /service prefix.
  adminApp.route('/', createAppointmentStatusRoutes())

  app.route('/', adminApp)

  return app
}

/**
 * The service surface, mounted at /service. Everything here is service-tier
 * and must satisfy the admission rule in CLAUDE.md ("Admin and service
 * surfaces"): it may act, it may not disclose.
 *
 * `PATCH /appointments/:id/status` is the only member. The same handler is also
 * reachable at the admin path — one factory, two mounts, two gates — so the
 * command-station UI keeps the URL it already calls.
 */
export function createServiceRoutes() {
  const app = new Hono<AppContext>()

  app.use('*', requireTier('service', 'Service'))
  app.route('/', createAppointmentStatusRoutes())

  return app
}
