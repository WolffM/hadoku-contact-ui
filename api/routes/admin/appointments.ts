/**
 * Admin appointment management routes
 *
 * Configuration and appointment CRUD
 */

import { Hono } from 'hono'
import { badRequest, notFound, serverError } from '../../utils/responses'
import {
  getAppointmentConfig,
  updateAppointmentConfig,
  createAppointment,
  isSlotAvailable,
  getAllAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  type AppointmentConfig
} from '../../storage'
import { adminOk } from './index'
import {
  APPOINTMENT_CONFIG,
  VALIDATION_CONSTRAINTS,
  type AppointmentPlatform
} from '../../constants'
import type { AppContext } from '../../types'

interface AdminCreateAppointmentBody {
  name?: unknown
  email?: unknown
  date?: unknown
  start_time?: unknown
  end_time?: unknown
  duration?: unknown
  timezone?: unknown
  platform?: unknown
  meeting_link?: unknown
  meeting_id?: unknown
  message?: unknown
  slot_id?: unknown
}

function validateAdminAppointment(body: AdminCreateAppointmentBody) {
  const errors: string[] = []
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  if (!isStr(body.name)) errors.push('name is required')
  if (!isStr(body.email) || !VALIDATION_CONSTRAINTS.EMAIL_REGEX.test(body.email))
    errors.push('valid email is required')
  if (!isStr(body.date) || !VALIDATION_CONSTRAINTS.DATE_FORMAT_REGEX.test(body.date))
    errors.push('date (YYYY-MM-DD) is required')
  if (!isStr(body.start_time) || isNaN(Date.parse(body.start_time)))
    errors.push('start_time (ISO 8601) is required')
  if (!isStr(body.end_time) || isNaN(Date.parse(body.end_time)))
    errors.push('end_time (ISO 8601) is required')
  if (
    !isNum(body.duration) ||
    !APPOINTMENT_CONFIG.VALID_DURATIONS.includes(body.duration as 15 | 30 | 60)
  )
    errors.push(`duration must be one of: ${APPOINTMENT_CONFIG.VALID_DURATIONS.join(', ')}`)
  if (
    !isStr(body.platform) ||
    !APPOINTMENT_CONFIG.VALID_PLATFORMS.includes(body.platform as AppointmentPlatform)
  )
    errors.push(`platform must be one of: ${APPOINTMENT_CONFIG.VALID_PLATFORMS.join(', ')}`)
  if (!isStr(body.timezone)) errors.push('timezone is required')

  return errors
}

export function createAppointmentAdminRoutes() {
  const app = new Hono<AppContext>()

  app.get('/appointments/config', async c => {
    try {
      const config = await getAppointmentConfig(c.env.DB)

      if (!config) {
        return notFound(c, 'Appointment configuration not found')
      }

      const startHour = parseInt(config.business_hours_start.split(':')[0], 10)
      const endHour = parseInt(config.business_hours_end.split(':')[0], 10)

      const platforms = config.meeting_platforms.split(',').map(p => p.trim())
      const availableDays = config.available_days.split(',').map(d => parseInt(d.trim()))
      const slotDurationOptions = config.slot_duration_options
        .split(',')
        .map(d => parseInt(d.trim()))

      return adminOk(c, {
        config: {
          timezone: config.timezone,
          start_hour: startHour,
          end_hour: endHour,
          available_days: availableDays,
          platforms,
          advance_notice_hours: config.min_advance_hours,
          slot_duration_options: slotDurationOptions,
          max_advance_days: config.max_advance_days
        }
      })
    } catch (error) {
      console.error('Error fetching appointment config:', error)
      return serverError(c, 'Failed to fetch appointment configuration')
    }
  })

  app.put('/appointments/config', async c => {
    try {
      const body = await c.req.json()

      const updates: Record<string, unknown> = {}

      if (body.timezone !== undefined) updates.timezone = body.timezone
      if (body.max_advance_days !== undefined) updates.max_advance_days = body.max_advance_days

      if (body.start_hour !== undefined) {
        const hour = parseInt(body.start_hour, 10)
        updates.business_hours_start = `${hour.toString().padStart(2, '0')}:00`
      } else if (body.business_hours_start !== undefined) {
        updates.business_hours_start = body.business_hours_start
      }

      if (body.end_hour !== undefined) {
        const hour = parseInt(body.end_hour, 10)
        updates.business_hours_end = `${hour.toString().padStart(2, '0')}:00`
      } else if (body.business_hours_end !== undefined) {
        updates.business_hours_end = body.business_hours_end
      }

      if (body.advance_notice_hours !== undefined) {
        updates.min_advance_hours = body.advance_notice_hours
      } else if (body.min_advance_hours !== undefined) {
        updates.min_advance_hours = body.min_advance_hours
      }

      if (Array.isArray(body.available_days)) {
        updates.available_days = body.available_days.join(',')
      }

      if (Array.isArray(body.slot_duration_options)) {
        updates.slot_duration_options = body.slot_duration_options.join(',')
      }

      if (Array.isArray(body.platforms)) {
        updates.meeting_platforms = body.platforms.join(',')
      } else if (Array.isArray(body.meeting_platforms)) {
        updates.meeting_platforms = body.meeting_platforms.join(',')
      }

      const success = await updateAppointmentConfig(
        c.env.DB,
        updates as Partial<Omit<AppointmentConfig, 'id' | 'last_updated'>>
      )

      if (!success) {
        return serverError(c, 'Failed to update configuration')
      }

      return adminOk(c, {
        success: true,
        message: 'Appointment configuration updated successfully'
      })
    } catch (error) {
      console.error('Error updating appointment config:', error)
      return serverError(c, 'Failed to update appointment configuration')
    }
  })

  // Admin-created event: bypasses public booking flow (no rate limit, no
  // whitelist, no submission row, no email confirmation). Used by command-station
  // to add events the user is tracking on their own calendar.
  app.post('/appointments', async c => {
    try {
      const body = (await c.req.json()) as AdminCreateAppointmentBody
      const errors = validateAdminAppointment(body)
      if (errors.length > 0) {
        return badRequest(c, errors.join('; '))
      }

      const slotId = (body.slot_id as string) || `admin-${body.date}-${body.start_time}`
      const available = await isSlotAvailable(c.env.DB, slotId)
      if (!available) {
        return c.json(
          { success: false, error: 'slot_taken', message: 'Slot is already booked' },
          409
        )
      }

      const appointment = await createAppointment(c.env.DB, {
        name: body.name as string,
        email: body.email as string,
        message: typeof body.message === 'string' ? body.message : undefined,
        slot_id: slotId,
        date: body.date as string,
        start_time: body.start_time as string,
        end_time: body.end_time as string,
        duration: body.duration as number,
        timezone: body.timezone as string,
        platform: body.platform as AppointmentPlatform,
        meeting_link: typeof body.meeting_link === 'string' ? body.meeting_link : undefined,
        meeting_id: typeof body.meeting_id === 'string' ? body.meeting_id : undefined
      })

      return adminOk(c, { appointment }, 201)
    } catch (error) {
      console.error('Error creating admin appointment:', error)
      return serverError(c, 'Failed to create appointment')
    }
  })

  app.get('/appointments', async c => {
    try {
      const limit = Number(c.req.query('limit')) || 100
      const offset = Number(c.req.query('offset')) || 0

      const appointments = await getAllAppointments(c.env.DB, limit, offset)

      return adminOk(c, {
        appointments,
        pagination: {
          limit,
          offset
        }
      })
    } catch (error) {
      console.error('Error fetching appointments:', error)
      return serverError(c, 'Failed to fetch appointments')
    }
  })

  app.get('/appointments/:id', async c => {
    try {
      const id = c.req.param('id')
      const appointment = await getAppointmentById(c.env.DB, id)

      if (!appointment) {
        return notFound(c, 'Appointment not found')
      }

      return adminOk(c, { appointment })
    } catch (error) {
      console.error('Error fetching appointment:', error)
      return serverError(c, 'Failed to fetch appointment')
    }
  })

  app.patch('/appointments/:id/status', async c => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()

      if (
        !body.status ||
        !['confirmed', 'cancelled', 'completed', 'no_show'].includes(body.status)
      ) {
        return badRequest(c, 'Invalid status. Must be: confirmed, cancelled, completed, or no_show')
      }

      const success = await updateAppointmentStatus(
        c.env.DB,
        id,
        body.status as 'confirmed' | 'cancelled' | 'completed' | 'no_show'
      )

      if (!success) {
        return notFound(c, 'Appointment not found')
      }

      return adminOk(c, { success: true, message: 'Appointment status updated successfully' })
    } catch (error) {
      console.error('Error updating appointment status:', error)
      return serverError(c, 'Failed to update appointment status')
    }
  })

  return app
}
