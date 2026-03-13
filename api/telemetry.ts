/**
 * Telemetry Module for Contact API
 *
 * Logs critical events to Cloudflare Workers Logs for queryable metrics.
 */

export const EventType = {
  RATE_LIMIT_HIT: 'rate_limit_hit',
  RATE_LIMIT_WARNING: 'rate_limit_warn',
  DB_CAPACITY_OK: 'db_capacity_ok',
  DB_CAPACITY_WARNING: 'db_capacity_warn',
  DB_CAPACITY_CRITICAL: 'db_capacity_crit',
  SUBMISSIONS_ARCHIVED: 'submissions_arch',
  TRASH_PURGED: 'trash_purged',
  EMAIL_SENT: 'email_sent',
  EMAIL_FAILED: 'email_failed',
  APPOINTMENT_BOOKED: 'appt_booked',
  APPOINTMENT_CONFLICT: 'appt_conflict',
  SUBMISSION_CREATED: 'submit_created',
  SCHEDULED_RUN: 'scheduled_run'
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

// Intentionally broad — any env object is accepted
interface TelemetryEnv {}

export function logEvent(_env: TelemetryEnv, event: TelemetryEvent): void {
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
}

export function logRateLimitHit(
  env: TelemetryEnv,
  ipHash: string,
  remaining: number,
  endpoint: string
): void {
  logEvent(env, {
    eventType: EventType.RATE_LIMIT_HIT,
    severity: Severity.WARN,
    value: remaining,
    context: `IP:${ipHash.substring(0, 8)}`,
    detail: endpoint
  })
}

export function logRateLimitWarning(
  env: TelemetryEnv,
  ipHash: string,
  remaining: number,
  endpoint: string
): void {
  logEvent(env, {
    eventType: EventType.RATE_LIMIT_WARNING,
    severity: Severity.INFO,
    value: remaining,
    context: `IP:${ipHash.substring(0, 8)}`,
    detail: endpoint
  })
}

export function logDbCapacity(env: TelemetryEnv, percentUsed: number, sizeBytes: number): void {
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

  logEvent(env, {
    eventType,
    severity,
    value: percentUsed,
    value2: sizeBytes,
    context: `${percentUsed.toFixed(1)}% used`,
    detail: `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
  })
}

export function logArchive(env: TelemetryEnv, archivedCount: number, daysOld: number): void {
  logEvent(env, {
    eventType: EventType.SUBMISSIONS_ARCHIVED,
    severity: Severity.INFO,
    value: archivedCount,
    value2: daysOld,
    context: `Archived ${archivedCount} submissions`,
    detail: `older than ${daysOld} days`
  })
}

export function logTrashPurge(env: TelemetryEnv, purgedCount: number, daysOld: number): void {
  logEvent(env, {
    eventType: EventType.TRASH_PURGED,
    severity: Severity.INFO,
    value: purgedCount,
    value2: daysOld,
    context: `Purged ${purgedCount} deleted items`,
    detail: `older than ${daysOld} days`
  })
}

export function logEmailSent(
  env: TelemetryEnv,
  templateName: string,
  recipientDomain: string
): void {
  logEvent(env, {
    eventType: EventType.EMAIL_SENT,
    severity: Severity.INFO,
    value: 1,
    context: templateName,
    detail: recipientDomain
  })
}

export function logEmailFailed(
  env: TelemetryEnv,
  templateName: string,
  errorMessage: string
): void {
  logEvent(env, {
    eventType: EventType.EMAIL_FAILED,
    severity: Severity.ERROR,
    value: 1,
    context: templateName,
    detail: errorMessage.substring(0, 100)
  })
}

export function logAppointmentBooked(env: TelemetryEnv, platform: string, duration: number): void {
  logEvent(env, {
    eventType: EventType.APPOINTMENT_BOOKED,
    severity: Severity.INFO,
    value: duration,
    context: platform
  })
}

export function logAppointmentConflict(env: TelemetryEnv, slotId: string): void {
  logEvent(env, {
    eventType: EventType.APPOINTMENT_CONFLICT,
    severity: Severity.WARN,
    value: 1,
    context: 'Slot already taken',
    detail: slotId.substring(0, 50)
  })
}

export function logSubmissionCreated(env: TelemetryEnv, recipient: string): void {
  logEvent(env, {
    eventType: EventType.SUBMISSION_CREATED,
    severity: Severity.INFO,
    value: 1,
    context: recipient
  })
}

export function logScheduledRun(env: TelemetryEnv, taskName: string, success: boolean): void {
  logEvent(env, {
    eventType: EventType.SCHEDULED_RUN,
    severity: success ? Severity.INFO : Severity.ERROR,
    value: success ? 1 : 0,
    context: taskName
  })
}
