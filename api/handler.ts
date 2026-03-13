/**
 * Contact API handler factory
 *
 * Creates a fully configured Hono app for the contact API.
 * Used as a subpath export from @wolffm/contact-ui/api.
 */

import { Hono } from 'hono'
import { createCorsMiddleware, DEFAULT_HADOKU_ORIGINS } from './utils/cors'
import { createHadokuAuth } from './utils/auth'
import { createErrorHandlers } from './utils/error-handlers'
import { createSubmitRoutes } from './routes/submit'
import { createAdminRoutes } from './routes/admin'
import { createInboundRoutes } from './routes/inbound'
import { createAppointmentsRoutes } from './routes/appointments'
import { archiveOldSubmissions, getDatabaseSize, purgeOldDeletedSubmissions } from './storage'
import { RETENTION_CONFIG } from './constants'
import { logDbCapacity, logArchive, logTrashPurge, logScheduledRun } from './telemetry'
import type { AppContext, ContactEnv, ContactHandlerOptions } from './types'

async function handleScheduled(env: ContactEnv): Promise<void> {
  console.log('Running scheduled tasks...')
  let success = true

  try {
    const archivedCount = await archiveOldSubmissions(env.DB, RETENTION_CONFIG.ARCHIVE_AFTER_DAYS)
    console.log(
      `Archived ${archivedCount} submission(s) older than ${RETENTION_CONFIG.ARCHIVE_AFTER_DAYS} days`
    )
    logArchive(env, archivedCount, RETENTION_CONFIG.ARCHIVE_AFTER_DAYS)

    const purgedCount = await purgeOldDeletedSubmissions(env.DB)
    console.log(
      `Purged ${purgedCount} deleted submission(s) older than ${RETENTION_CONFIG.TRASH_RETENTION_DAYS} days`
    )
    logTrashPurge(env, purgedCount, RETENTION_CONFIG.TRASH_RETENTION_DAYS)

    const dbSize = await getDatabaseSize(env.DB)
    console.log(
      `Database capacity: ${dbSize.percentUsed.toFixed(1)}% (${(dbSize.sizeBytes / 1024 / 1024).toFixed(2)} MB)`
    )
    logDbCapacity(env, dbSize.percentUsed, dbSize.sizeBytes)

    if (dbSize.warning) {
      console.warn('WARNING: Database capacity threshold exceeded!')
      console.warn('Consider archiving more aggressively or cleaning up old data')
    }

    console.log('Scheduled tasks completed successfully')
  } catch (error) {
    console.error('Error running scheduled tasks:', error)
    success = false
  }

  logScheduledRun(env, 'daily_maintenance', success)
}

export function createContactHandler(basePath = '/contact/api', options?: ContactHandlerOptions) {
  const app = new Hono<AppContext>().basePath(basePath)

  // CORS Middleware
  app.use(
    '*',
    createCorsMiddleware({
      origins: [...DEFAULT_HADOKU_ORIGINS, ...(options?.additionalOrigins ?? [])],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-User-Key', 'X-Session-Id'],
      exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
      credentials: true,
      maxAge: 86400
    })
  )

  // Authentication Middleware
  app.use('*', createHadokuAuth())

  // Health check
  app.get('/health', c => {
    return c.json({
      status: 'healthy',
      timestamp: Date.now(),
      service: 'contact-api'
    })
  })

  // Public routes
  app.route('/', createSubmitRoutes(options?.rateLimit))
  app.route('/', createAppointmentsRoutes())
  app.route('/', createInboundRoutes())

  // Admin routes
  app.route('/admin', createAdminRoutes())

  // Internal endpoint: daily maintenance
  app.post('/internal/run-daily', async c => {
    const auth = c.get('authContext')
    if (auth.userType !== 'admin') {
      return c.json({ error: 'Unauthorized' }, 403)
    }

    const startTime = Date.now()
    try {
      await handleScheduled(c.env)
      return c.json({ success: true, duration_ms: Date.now() - startTime })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: msg, duration_ms: Date.now() - startTime }, 500)
    }
  })

  const { notFoundHandler, errorHandler } = createErrorHandlers()
  app.notFound(notFoundHandler)
  app.onError(errorHandler)

  return app
}
