/**
 * Appointment storage operations
 */

import { PAGINATION_DEFAULTS, type AppointmentPlatform } from '../constants'

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
  platform: AppointmentPlatform
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
  platform: AppointmentPlatform
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
  const id = (globalThis.crypto as { randomUUID: () => string }).randomUUID()
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
      params.platform,
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
    platform: params.platform,
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

export async function isSlotAvailable(db: D1Database, slotId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT id FROM appointments
			WHERE slot_id = ? AND status = 'confirmed'
			LIMIT 1`
    )
    .bind(slotId)
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
