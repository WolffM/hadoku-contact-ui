/**
 * Telemetry Module for Contact API
 *
 * Every event goes two places: the worker's console (Workers Logs) and
 * monitoring-api's `service_events` table, posted through edge-router as this
 * worker's own service identity (`HADOKU_SERVICE_KEY`). Only the second is
 * readable by a session with a repo key, which is why it exists: until
 * 2026-11-22 these events reached console alone, so "was the confirmation for
 * the 11-21 booking sent?" had no answer anywhere we could read.
 *
 * Read them back with `GET /health/api/service-events?service=contact`.
 *
 * The post is best-effort and deferred with waitUntil, so it never delays or
 * fails the request that produced it. A failed post is logged to console, the
 * place the event was going anyway.
 *
 * No event carries a full email address or a message body: service_events is
 * readable at service tier. A recipient is reported as its domain.
 */

import { edgeFetch, EDGE_ORIGIN, type EdgeFetchEnv } from './utils/edge-fetch'
import { runInBackground, type BackgroundContext } from './utils/background'

export const EventType = {
  RATE_LIMIT_HIT: 'rate_limit_hit',
  RATE_LIMIT_WARNING: 'rate_limit_warn',
  DB_CAPACITY_OK: 'db_capacity_ok',
  DB_CAPACITY_WARNING: 'db_capacity_warn',
  DB_CAPACITY_CRITICAL: 'db_capacity_crit',
  SUBMISSIONS_ARCHIVED: 'submissions_arch',
  TRASH_PURGED: 'trash_purged',
  SPAM_PURGED: 'spam_purged',
  EMAIL_SENT: 'email_sent',
  EMAIL_FAILED: 'email_failed',
  APPOINTMENT_BOOKED: 'appt_booked',
  APPOINTMENT_CONFLICT: 'appt_conflict',
  // A booking that stored no meeting link. Nothing reported this, which is how
  // Google Meet stayed broken unnoticed: the booking 201s, the confirmation
  // sends, the admin row looks complete, and only the `meeting_link` column —
  // which no view surfaces — says anything went wrong.
  MEETING_LINK_FAILED: 'meeting_link_failed',
  SUBMISSION_CREATED: 'submit_created',
  // A Resend delivery webhook for a booking confirmation. Bounced, complained
  // and failed are the ones that mean the guest never got their meeting link.
  EMAIL_DELIVERY: 'email_delivery',
  // A form submission refused because its email domain does not exist or
  // publishes no mail server. 2026-11-21's `foreet-ai.org` booking is the case.
  EMAIL_DOMAIN_REJECTED: 'email_domain_rejected',
  // The domain lookup itself failed, so the submission went through unchecked.
  EMAIL_DOMAIN_UNVERIFIED: 'email_domain_unverified'
} as const

export type EventTypeValue = (typeof EventType)[keyof typeof EventType]

export const Severity = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
} as const

export type SeverityValue = (typeof Severity)[keyof typeof Severity]

interface TelemetryEvent {
  eventType: EventTypeValue
  severity: SeverityValue
  value?: number
  value2?: number
  context?: string
  detail?: string
}

/** The `service` column of every row this module writes. The app's id. */
export const TELEMETRY_SERVICE = 'contact'
const TELEMETRY_URL = `${EDGE_ORIGIN}/health/api/telemetry`

export interface TelemetryEnv extends EdgeFetchEnv {
  HADOKU_SERVICE_KEY?: string
}

/**
 * Where an event goes: the env holding the key and binding, and a way to keep
 * the post alive past the response. Build one per request with telemetryFor.
 */
export interface Telemetry {
  env: TelemetryEnv
  defer(work: Promise<unknown>): void
}

export function telemetryFor(c: BackgroundContext & { env: TelemetryEnv }): Telemetry {
  return { env: c.env, defer: work => runInBackground(c, work) }
}

async function postEvent(env: TelemetryEnv, key: string, event: TelemetryEvent): Promise<void> {
  const summary = [event.context, event.detail].filter(Boolean).join(' ')
  try {
    const res = await edgeFetch(env, TELEMETRY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Key': key,
        'User-Agent': 'hadoku-contact-api'
      },
      body: JSON.stringify({
        source: 'worker',
        level: event.severity,
        type: 'log',
        message: `event=contact.${event.eventType}${summary ? ` ${summary}` : ''}`,
        context: {
          service: TELEMETRY_SERVICE,
          value: event.value,
          value2: event.value2,
          context: event.context,
          detail: event.detail
        }
      })
    })
    if (!res.ok) {
      console.error(`[telemetry] post of ${event.eventType} refused: HTTP ${res.status}`)
    }
  } catch (err) {
    console.error(`[telemetry] post of ${event.eventType} failed:`, err)
  }
}

export function logEvent(t: Telemetry, event: TelemetryEvent): void {
  const logFn =
    event.severity === Severity.ERROR
      ? console.error
      : event.severity === Severity.WARN
        ? console.warn
        : console.log

  logFn(`[${event.eventType}] ${event.context || ''} ${event.detail || ''}`, {
    severity: event.severity,
    value: event.value,
    value2: event.value2
  })

  const key = t.env.HADOKU_SERVICE_KEY
  if (key) t.defer(postEvent(t.env, key, event))
}

export function logRateLimitHit(
  t: Telemetry,
  ipHash: string,
  remaining: number,
  endpoint: string
): void {
  logEvent(t, {
    eventType: EventType.RATE_LIMIT_HIT,
    severity: Severity.WARN,
    value: remaining,
    context: `IP:${ipHash.substring(0, 8)}`,
    detail: endpoint
  })
}

export function logRateLimitWarning(
  t: Telemetry,
  ipHash: string,
  remaining: number,
  endpoint: string
): void {
  logEvent(t, {
    eventType: EventType.RATE_LIMIT_WARNING,
    severity: Severity.INFO,
    value: remaining,
    context: `IP:${ipHash.substring(0, 8)}`,
    detail: endpoint
  })
}

export function logDbCapacity(t: Telemetry, percentUsed: number, sizeBytes: number): void {
  let eventType: EventTypeValue
  let severity: SeverityValue

  if (percentUsed >= 80) {
    eventType = EventType.DB_CAPACITY_CRITICAL
    severity = Severity.ERROR
  } else if (percentUsed >= 70) {
    eventType = EventType.DB_CAPACITY_WARNING
    severity = Severity.WARN
  } else {
    eventType = EventType.DB_CAPACITY_OK
    severity = Severity.INFO
  }

  logEvent(t, {
    eventType,
    severity,
    value: percentUsed,
    value2: sizeBytes,
    context: `${percentUsed.toFixed(1)}% used`,
    detail: `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
  })
}

export function logArchive(t: Telemetry, archivedCount: number, daysOld: number): void {
  logEvent(t, {
    eventType: EventType.SUBMISSIONS_ARCHIVED,
    severity: Severity.INFO,
    value: archivedCount,
    value2: daysOld,
    context: `Archived ${archivedCount} submissions`,
    detail: `older than ${daysOld} days`
  })
}

export function logTrashPurge(t: Telemetry, purgedCount: number, daysOld: number): void {
  logEvent(t, {
    eventType: EventType.TRASH_PURGED,
    severity: Severity.INFO,
    value: purgedCount,
    value2: daysOld,
    context: `Purged ${purgedCount} deleted items`,
    detail: `older than ${daysOld} days`
  })
}

export function logSpamPurge(t: Telemetry, purgedCount: number, daysOld: number): void {
  logEvent(t, {
    eventType: EventType.SPAM_PURGED,
    severity: Severity.INFO,
    value: purgedCount,
    value2: daysOld,
    context: `Purged ${purgedCount} spam messages`,
    detail: `blocked more than ${daysOld} days ago`
  })
}

export function logEmailSent(t: Telemetry, templateName: string, recipientDomain: string): void {
  logEvent(t, {
    eventType: EventType.EMAIL_SENT,
    severity: Severity.INFO,
    value: 1,
    context: templateName,
    detail: recipientDomain
  })
}

export function logEmailFailed(t: Telemetry, templateName: string, errorMessage: string): void {
  logEvent(t, {
    eventType: EventType.EMAIL_FAILED,
    severity: Severity.ERROR,
    value: 1,
    context: templateName,
    detail: errorMessage.substring(0, 100)
  })
}

export function logAppointmentBooked(t: Telemetry, platform: string, duration: number): void {
  logEvent(t, {
    eventType: EventType.APPOINTMENT_BOOKED,
    severity: Severity.INFO,
    value: duration,
    context: platform
  })
}

export function logMeetingLinkFailed(t: Telemetry, platform: string, errorMessage: string): void {
  logEvent(t, {
    eventType: EventType.MEETING_LINK_FAILED,
    severity: Severity.ERROR,
    value: 1,
    context: platform,
    detail: errorMessage.substring(0, 100)
  })
}

export function logAppointmentConflict(t: Telemetry, slotId: string): void {
  logEvent(t, {
    eventType: EventType.APPOINTMENT_CONFLICT,
    severity: Severity.WARN,
    value: 1,
    context: 'Slot already taken',
    detail: slotId.substring(0, 50)
  })
}

export function logSubmissionCreated(t: Telemetry, recipient: string): void {
  logEvent(t, {
    eventType: EventType.SUBMISSION_CREATED,
    severity: Severity.INFO,
    value: 1,
    context: recipient
  })
}

export function logEmailDelivery(
  t: Telemetry,
  status: string,
  recipientDomain: string,
  appointmentId: string
): void {
  const failed = status === 'bounced' || status === 'complained' || status === 'failed'
  logEvent(t, {
    eventType: EventType.EMAIL_DELIVERY,
    severity: failed ? Severity.ERROR : Severity.INFO,
    value: failed ? 1 : 0,
    context: status,
    detail: `${recipientDomain} appointment:${appointmentId}`
  })
}

export function logEmailDomainRejected(t: Telemetry, domain: string, reason: string): void {
  logEvent(t, {
    eventType: EventType.EMAIL_DOMAIN_REJECTED,
    severity: Severity.WARN,
    value: 1,
    context: reason,
    detail: domain.substring(0, 100)
  })
}

export function logEmailDomainUnverified(t: Telemetry, domain: string, error: string): void {
  logEvent(t, {
    eventType: EventType.EMAIL_DOMAIN_UNVERIFIED,
    severity: Severity.WARN,
    value: 1,
    context: domain.substring(0, 100),
    detail: error.substring(0, 100)
  })
}
