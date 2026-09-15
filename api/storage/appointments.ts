/**
 * Appointment storage operations
 */

import {
  PAGINATION_DEFAULTS,
  type AppointmentPlatform,
  type StoredAppointmentPlatform
} from '../constants'
import type { BookingWindow } from '../utils/booking-window'

export interface AppointmentConfig {
  id: number
  timezone: string
  business_hours_start: string
  business_hours_end: string
  available_days: string
  slot_duration_options: string
  max_advance_days: number
  min_advance_hours: number
  meeting_platforms: string
  last_updated: number
}

/**
 * The stored config narrowed to the booking window, with its comma-separated
 * columns parsed once. Both the slots endpoint and the public config endpoint
 * read the window through here so neither re-parses `available_days` its own way.
 */
export function toBookingWindow(config: AppointmentConfig): BookingWindow {
  return {
    timezone: config.timezone,
    businessHoursStart: config.business_hours_start,
    businessHoursEnd: config.business_hours_end,
    availableDays: parseIntList(config.available_days),
    minAdvanceHours: config.min_advance_hours,
    maxAdvanceDays: config.max_advance_days
  }
}

/** `'15,30,60'` -> `[15, 30, 60]`. */
export function parseIntList(csv: string): number[] {
  return csv
    .split(',')
    .map(v => parseInt(v.trim(), 10))
    .filter(v => Number.isFinite(v))
}

export interface StoredAppointment {
  id: string
  submission_id: string | null
  name: string
  email: string
  message: string | null
  slot_id: string
  date: string
  start_time: string
  end_time: string
  duration: number
  timezone: string
  /** NULL = no meeting platform (an admin-created calendar entry). */
  platform: StoredAppointmentPlatform | null
  meeting_link: string | null
  meeting_id: string | null
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show'
  created_at: number
  updated_at: number
  cancelled_at: number | null
  ip_address: string | null
  user_agent: string | null
  confirmation_sent: boolean
  reminder_sent: boolean
}

export interface CreateAppointmentParams {
  submission_id?: string
  name: string
  email: string
  message?: string
  slot_id: string
  date: string
  start_time: string
  end_time: string
  duration: number
  timezone: string
  /** Omit for an event with no meeting platform. Public bookings always set it. */
  platform?: AppointmentPlatform
  meeting_link?: string
  meeting_id?: string
  ip_address?: string
  user_agent?: string
}

function buildUpdateQuery<T extends Record<string, unknown>>(
  tableName: string,
  updates: Partial<T>,
  whereClause: string
): { query: string; values: unknown[] } {
  const fields: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`)
      values.push(value)
    }
  }

  fields.push('last_updated = ?')
  values.push(Date.now())

  const query = `UPDATE ${tableName} SET ${fields.join(', ')} ${whereClause}`
  return { query, values }
}

export async function getAppointmentConfig(db: D1Database): Promise<AppointmentConfig | null> {
  const result = await db
    .prepare(`SELECT * FROM appointment_config WHERE id = 1`)
    .first<AppointmentConfig>()

  return result
}

export async function updateAppointmentConfig(
  db: D1Database,
  config: Partial<Omit<AppointmentConfig, 'id' | 'last_updated'>>
): Promise<boolean> {
  const { query, values } = buildUpdateQuery('appointment_config', config, 'WHERE id = 1')

  if (values.length === 1) {
    return true
  }

  const result = await db
    .prepare(query)
    .bind(...values)
    .run()
  return result.success
}

export async function createAppointment(
  db: D1Database,
  params: CreateAppointmentParams
): Promise<StoredAppointment> {
  // `crypto` is a bare global in the Workers runtime, declared by
  // @cloudflare/workers-types as `declare const` — which TypeScript does NOT
  // expose as a property of `globalThis`. Reaching through globalThis was the
  // reason the cast existed, and the cast is what hid that it did not typecheck.
  const id = crypto.randomUUID()
  const now = Date.now()

  // Remove any cancelled appointment occupying this slot so the UNIQUE constraint
  // on slot_id doesn't block rebooking a previously-cancelled slot.
  await db
    .prepare(`DELETE FROM appointments WHERE slot_id = ? AND status != 'confirmed'`)
    .bind(params.slot_id)
    .run()

  await db
    .prepare(
      `INSERT INTO appointments
			(id, submission_id, name, email, message, slot_id, date, start_time, end_time,
			 duration, timezone, platform, meeting_link, meeting_id, status,
			 created_at, updated_at, ip_address, user_agent, confirmation_sent, reminder_sent)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, 0, 0)`
    )
    .bind(
      id,
      params.submission_id ?? null,
      params.name,
      params.email,
      params.message ?? null,
      params.slot_id,
      params.date,
      params.start_time,
      params.end_time,
      params.duration,
      params.timezone,
      params.platform ?? null,
      params.meeting_link ?? null,
      params.meeting_id ?? null,
      now,
      now,
      params.ip_address ?? null,
      params.user_agent ?? null
    )
    .run()

  const result: StoredAppointment = {
    id,
    submission_id: params.submission_id ?? null,
    name: params.name,
    email: params.email,
    message: params.message ?? null,
    slot_id: params.slot_id,
    date: params.date,
    start_time: params.start_time,
    end_time: params.end_time,
    duration: params.duration,
    timezone: params.timezone,
    platform: params.platform ?? null,
    meeting_link: params.meeting_link ?? null,
    meeting_id: params.meeting_id ?? null,
    status: 'confirmed',
    created_at: now,
    updated_at: now,
    cancelled_at: null,
    ip_address: params.ip_address ?? null,
    user_agent: params.user_agent ?? null,
    confirmation_sent: false,
    reminder_sent: false
  }

  return result
}

/**
 * Is this time RANGE free?
 *
 * Overlap, not slot-id equality. `slot_id` is `slot-<date>-<startISO>` and
 * carries no duration, so a 60-minute booking at 14:00 and a 15-minute booking
 * at 14:00 share an id while 14:15 gets a different one entirely. Matching on
 * the id therefore blocked only an exact same-start rebooking: a confirmed
 * 15-minute meeting at 21:45 left BOTH the 21:30-22:00 and 21:00-22:00 slots
 * offered, and the submit path agreed, so a stranger could book straight over
 * it. Verified against production on 2026-09-15 before this was changed.
 *
 * Half-open comparison (`start < existingEnd AND end > existingStart`) so
 * back-to-back meetings do not count as overlapping — 14:00-14:15 and
 * 14:15-14:30 are adjacent, not a conflict.
 */
export async function isRangeAvailable(
  db: D1Database,
  startIso: string,
  endIso: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT id FROM appointments
			WHERE status = 'confirmed'
			  AND start_time < ?
			  AND end_time > ?
			LIMIT 1`
    )
    .bind(endIso, startIso)
    .first()

  return result === null
}

export async function getAppointmentsByDate(
  db: D1Database,
  date: string,
  includeNonConfirmed = false
): Promise<StoredAppointment[]> {
  const whereClause = includeNonConfirmed
    ? 'WHERE date = ?'
    : `WHERE date = ? AND status = 'confirmed'`

  const result = await db
    .prepare(
      `SELECT * FROM appointments
			${whereClause}
			ORDER BY start_time ASC`
    )
    .bind(date)
    .all<StoredAppointment>()

  return result.results ?? []
}

/**
 * The appointments booked by each of `submissionIds`, keyed by submission.
 *
 * The Inbox renders a booking and its message as one item, but they live in two
 * tables — a form submission that booked a meeting stored the meeting in
 * `appointments` and left no trace of it on the `contact_submissions` row. The
 * mail therefore arrived with no time on it, and the only way to find out when
 * the meeting was, was to go read the Appointments tab and match by name.
 *
 * Cancelled bookings are included: "this meeting was cancelled" is information
 * the message still needs to carry.
 */
/**
 * The `slot_id`s taken by confirmed bookings between two dates, inclusive.
 *
 * One query for a whole month rather than one per day: the calendar asks whether
 * each of ~31 dates has anything left on it, and doing that a day at a time
 * would be 31 round-trips to answer one screen.
 */
export interface BookedInterval {
  startMs: number
  endMs: number
}

/**
 * Confirmed bookings in a date range, as INTERVALS.
 *
 * Returned as times rather than slot ids because availability is an overlap
 * question — see isRangeAvailable. A set of ids can only answer "is this exact
 * start taken", which silently offers every longer slot that straddles a
 * shorter booking.
 */
export async function getBookedIntervalsInRange(
  db: D1Database,
  from: string,
  to: string
): Promise<BookedInterval[]> {
  const result = await db
    .prepare(
      `SELECT start_time, end_time FROM appointments
			 WHERE date BETWEEN ? AND ? AND status = 'confirmed'`
    )
    .bind(from, to)
    .all<{ start_time: string; end_time: string }>()

  return (result.results ?? [])
    .map(row => ({ startMs: Date.parse(row.start_time), endMs: Date.parse(row.end_time) }))
    .filter(iv => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs))
}

/** Does [startMs, endMs) overlap any booked interval? Half-open, so adjacent is free. */
export function overlapsBooked(
  startMs: number,
  endMs: number,
  booked: BookedInterval[]
): boolean {
  return booked.some(iv => startMs < iv.endMs && endMs > iv.startMs)
}

export async function getAppointmentsBySubmissionIds(
  db: D1Database,
  submissionIds: string[]
): Promise<Map<string, StoredAppointment>> {
  const bySubmission = new Map<string, StoredAppointment>()
  if (submissionIds.length === 0) return bySubmission

  const placeholders = submissionIds.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT * FROM appointments
			 WHERE submission_id IN (${placeholders})
			 ORDER BY created_at ASC`
    )
    .bind(...submissionIds)
    .all<StoredAppointment>()

  for (const appointment of result.results ?? []) {
    // A submission books at most one meeting, but the column carries no UNIQUE
    // constraint — keep the first so repeated calls agree with each other.
    if (appointment.submission_id && !bySubmission.has(appointment.submission_id)) {
      bySubmission.set(appointment.submission_id, appointment)
    }
  }

  return bySubmission
}

export async function getAllAppointments(
  db: D1Database,
  limit: number = PAGINATION_DEFAULTS.LIMIT,
  offset: number = PAGINATION_DEFAULTS.OFFSET
): Promise<StoredAppointment[]> {
  const result = await db
    .prepare(
      `SELECT * FROM appointments
			ORDER BY start_time DESC
			LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<StoredAppointment>()

  return result.results ?? []
}

export async function getAppointmentById(
  db: D1Database,
  id: string
): Promise<StoredAppointment | null> {
  const result = await db
    .prepare(`SELECT * FROM appointments WHERE id = ?`)
    .bind(id)
    .first<StoredAppointment>()

  return result
}

export async function updateAppointmentStatus(
  db: D1Database,
  id: string,
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show'
): Promise<boolean> {
  const now = Date.now()
  const cancelledAt = status === 'cancelled' ? now : null

  const result = await db
    .prepare(
      `UPDATE appointments
			SET status = ?, updated_at = ?, cancelled_at = ?
			WHERE id = ?`
    )
    .bind(status, now, cancelledAt, id)
    .run()

  return result.success
}

export async function markConfirmationSent(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE appointments SET confirmation_sent = 1 WHERE id = ?`)
    .bind(id)
    .run()

  return result.success
}

export async function markReminderSent(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE appointments SET reminder_sent = 1 WHERE id = ?`)
    .bind(id)
    .run()

  return result.success
}
