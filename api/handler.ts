/**
 * Contact API handler factory
 *
 * Creates a fully configured Hono app for the contact API.
 * Used as a subpath export from @wolffm/contact-ui/api.
 */

import { Hono } from 'hono'
import { createCorsMiddleware, DEFAULT_HADOKU_ORIGINS } from './utils/cors'
import { createEdgeAuth, tierAtLeast } from './utils/auth'
import { createErrorHandlers } from './utils/error-handlers'
import { createSubmitRoutes } from './routes/submit'
import { createAdminRoutes, createServiceRoutes } from './routes/admin'
import { createInboundRoutes } from './routes/inbound'
import { createAppointmentsRoutes } from './routes/appointments'
import {
  archiveOldSubmissions,
  getDatabaseSize,
  purgeOldDeletedSubmissions,
  purgeOldSpamSubmissions,
  releaseQuarantinedSubmissions
} from './storage'
import { syncInboundEmails } from './services/resend-sync'
import { checkCalendarCredential } from './services/google-meet'
import { isWhitelistEnforced } from './services/inbound-ingest'
import { RETENTION_CONFIG } from './constants'
import {
  logDbCapacity,
  logArchive,
  logTrashPurge,
  logSpamPurge,
  logMeetingLinkFailed
} from './telemetry'
import type { AppContext, ContactEnv, ContactHandlerOptions } from './types'

async function handleScheduled(env: ContactEnv): Promise<void> {
  console.log('Running scheduled tasks...')

  // Steps throw on failure — the /internal/run-daily route's catch turns that
  // into a 500 { success: false }, so mgmt-api's dispatch records the
  // daily-maintenance JobExecution as failed. (Previously this swallowed errors
  // and logged a local `scheduled_run` breadcrumb, so the route always returned
  // success and the central record lied.) The execution-log record in
  // monitoring-api is now the single source of truth — no local breadcrumb.
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

  // Spam's own clock. It runs after the archive step by necessity rather than
  // taste: archiveOldSubmissions skips `spammed_at IS NOT NULL` rows entirely, so
  // this is the ONLY thing that ever removes blocked mail from the table. If it
  // stops running, spam accumulates forever instead of failing loudly.
  const spamPurgedCount = await purgeOldSpamSubmissions(env.DB)
  console.log(
    `Purged ${spamPurgedCount} spam submission(s) blocked more than ${RETENTION_CONFIG.SPAM_RETENTION_DAYS} days ago`
  )
  logSpamPurge(env, spamPurgedCount, RETENTION_CONFIG.SPAM_RETENTION_DAYS)

  // Policy convergence, not retention. With the whitelist tier switched off
  // nothing produces `not_whitelisted` any more, so a row still carrying it is
  // quarantined by a rule that no longer exists — and would stay in Filtered
  // for the life of the row, because turning a gate off says nothing about mail
  // already behind it. This is the only step here that can be a permanent
  // no-op: on an enforcing deployment it never runs at all, and on a switched
  // one it clears the backlog once and reports 0 forever after.
  //
  // No telemetry counter, deliberately. The others measure a recurring rate
  // worth graphing; this measures a one-time migration whose only interesting
  // value is its first.
  if (!isWhitelistEnforced(env)) {
    const releasedCount = await releaseQuarantinedSubmissions(env.DB)
    if (releasedCount > 0) {
      console.log(
        `Released ${releasedCount} quarantined submission(s) — INBOUND_WHITELIST_MODE=accept-all`
      )
    }
  }

  // An unreadable size is NOT zero. Reporting it as `0.0% (0.00 MB)` is what
  // let a broken capacity check look healthy for months: the PRAGMA it used was
  // refused by D1 on every call, the error was swallowed, and the alarm could
  // never fire. Say "unknown", and never feed the placeholder to telemetry
  // where it becomes a flat, reassuring line on a graph.
  const dbSize = await getDatabaseSize(env.DB)
  if (!dbSize.available) {
    console.error('Database capacity: UNKNOWN — size read failed; the capacity alarm is blind')
  } else {
    console.log(
      `Database capacity: ${dbSize.percentUsed.toFixed(1)}% (${(dbSize.sizeBytes / 1024 / 1024).toFixed(2)} MB)`
    )
    logDbCapacity(env, dbSize.percentUsed, dbSize.sizeBytes)

    if (dbSize.warning) {
      console.warn('WARNING: Database capacity threshold exceeded!')
      console.warn('Consider archiving more aggressively or cleaning up old data')
    }
  }

  // The Google Calendar credential canary. Deliberately LAST: every retention
  // step above has already run and committed by the time this can throw, so a
  // dead meeting credential never costs a night of archiving or purging.
  //
  // It throws rather than logging because throwing is the only thing here that
  // reaches a human. logEvent() writes to console, and console goes to Workers
  // Logs, which nobody is watching at 3am; a failed job, by contrast, is posted
  // to /health/api/jobs and monitoring-api's job-alerts pages Discord off the
  // `failed` state with no per-job wiring. The message therefore has to say
  // plainly that this is the meeting credential and not the purge, because the
  // alert it produces is titled with the job, not the step.
  const credential = await checkCalendarCredential(env)
  if (credential.configured && !credential.alive) {
    logMeetingLinkFailed(env, 'google', credential.error)
    throw new Error(
      `Google Calendar credential is dead — retention steps all succeeded, this is ONLY the meeting-link credential. ` +
        `Google Meet bookings are still succeeding but storing meeting_link = null. ` +
        `Re-mint per docs/operations/google-meet-setup.md. Underlying error: ${credential.error}`
    )
  }
  if (credential.configured) {
    console.log('Google Calendar credential OK (refresh token exchanged)')
  }

  console.log('Scheduled tasks completed successfully')
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

  // Authentication: trust the edge-stamped tier (centralized auth channel).
  // Public submit routes pass through; admin routes gate via requireAdmin.
  app.use('*', createEdgeAuth())

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
  // The service-tier surface. A SEPARATE prefix, not a carve-out inside
  // /admin — edge-router gates by prefix and cannot express a path pattern, so
  // a service-tier route living under /admin could only be reached by lowering
  // the edge rule for the whole admin prefix. See "Admin and service surfaces"
  // in CLAUDE.md.
  app.route('/service', createServiceRoutes())

  // Internal endpoint: daily maintenance.
  // Dispatched by mgmt-api's cron orchestrator with MGMT_CRON_KEY (service
  // tier) — same caller and rationale as the monitoring-api carve-outs for
  // POST /health/api/jobs and POST /health/api/cleanup/run.
  app.post('/internal/run-daily', async c => {
    const auth = c.get('authContext')
    // service AND UP. The enumerated form (`!== 'admin' && !== 'service'`) was
    // an exact-match allowlist: it excluded `wife` even though wife outranks
    // service, so the tier that is meant to reach everything a service reaches
    // would have been refused here.
    if (!tierAtLeast(auth, 'service')) {
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

  // Internal endpoint: inbound mail reconciliation.
  //
  // Separate from run-daily because the cadences are genuinely different — the
  // archive/purge sweep is a nightly housekeeping job, whereas this is what
  // makes the mailbox trustworthy and wants to run every few minutes. Folding
  // it into daily maintenance would mean a webhook miss stays invisible for up
  // to 24 hours, which is the failure this whole change exists to remove.
  app.post('/internal/sync-inbound', async c => {
    const auth = c.get('authContext')
    if (!tierAtLeast(auth, 'service')) {
      return c.json({ error: 'Unauthorized' }, 403)
    }

    const startTime = Date.now()
    try {
      const result = await syncInboundEmails(c.env)
      return c.json({ success: true, ...result, duration_ms: Date.now() - startTime })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[inbound-sync] failed:', msg)
      return c.json({ success: false, error: msg, duration_ms: Date.now() - startTime }, 500)
    }
  })

  const { notFoundHandler, errorHandler } = createErrorHandlers()
  app.notFound(notFoundHandler)
  app.onError(errorHandler)

  return app
}
