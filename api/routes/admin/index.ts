/**
 * Admin routes for managing contact submissions
 *
 * All routes require admin authentication.
 * Split into domain-specific modules.
 */

import { Hono, type Context, type ContentfulStatusCode, type Next } from 'hono'
import { createSubmissionRoutes } from './submissions'
import { createEmailRoutes } from './email'
import { createAppointmentAdminRoutes } from './appointments'
import { createTemplateRoutes } from './templates'
import type { AppContext } from '../../types'

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

    if (!auth?.userType || auth.userType !== 'admin') {
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
