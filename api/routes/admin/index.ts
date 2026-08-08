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
import { createAppointmentAdminRoutes } from './appointments'
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

function requireAdmin() {
  return async (c: Context<AppContext>, next: Next) => {
    const auth = c.get('authContext')

    // Admin is the top tier, so the string compare admitted the right set
    // today — but it is the pattern that produced the /internal/run-daily bug
    // one file over, and it silently stops being correct the moment anything
    // is added above admin. Rank, not equality.
    if (!tierAtLeast(auth, 'admin')) {
      return c.json(
        {
          success: false,
          error: 'Forbidden',
          message: 'Admin access required'
        },
        403
      )
    }

    await next()
  }
}

export function createAdminRoutes() {
  const app = new Hono<AppContext>()

  app.use('*', requireAdmin())

  app.route('/', createSubmissionRoutes())
  app.route('/', createEmailRoutes())
  app.route('/', createAppointmentAdminRoutes())
  app.route('/', createTemplateRoutes())

  return app
}
