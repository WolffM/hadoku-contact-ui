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
 * Everything under /admin is admin-tier with ONE exception, and the exception
 * is mounted as its own sub-app rather than punched through the gate.
 *
 * `PATCH /appointments/:id/status` is service-tier. Cancelling a booking is an
 * operational act an automation should be able to perform — retiring a test
 * row, closing out a no-show — and it discloses nothing: it takes an id and a
 * status and returns a boolean. Everything else here is a different kind of
 * thing entirely. `createSubmissionRoutes` serves every message the contact
 * form has ever received, with names, addresses, IPs and user agents;
 * `createEmailRoutes` sends mail AS the operator; the blocklist and templates
 * are likewise operator state. Service tier is held by every worker key in the
 * ecosystem, so lowering the whole gate would put the operator's inbox behind
 * any one of them — or behind a bug in any one of them.
 *
 * The two sub-apps carry DISJOINT paths on purpose. A single router with a
 * path-exception in the middleware would work today and rot the moment a route
 * is added that happens to match the exception; two gates over two route sets
 * cannot develop that overlap silently, because a duplicate path would have to
 * be written into both files.
 */
export function createAdminRoutes() {
  const app = new Hono<AppContext>()

  // Scoped to the exact path, NOT '*'. A '*' here runs the service gate over
  // every /admin path on its way to the admin app — which still denies, because
  // the admin gate is behind it, but denies with the wrong reason: a public
  // caller asking for /submissions would be told "Service access required".
  const serviceApp = new Hono<AppContext>()
  serviceApp.use('/appointments/:id/status', requireTier('service', 'Service'))
  serviceApp.route('/', createAppointmentStatusRoutes())

  const adminApp = new Hono<AppContext>()
  adminApp.use('*', requireTier('admin', 'Admin'))
  adminApp.route('/', createSubmissionRoutes())
  adminApp.route('/', createEmailRoutes())
  adminApp.route('/', createBlocklistRoutes())
  adminApp.route('/', createAppointmentAdminRoutes())
  adminApp.route('/', createTemplateRoutes())

  app.route('/', serviceApp)
  app.route('/', adminApp)

  return app
}
