/**
 * Appointments endpoints
 */

import { Hono } from 'hono'
import { validateSlotFetchRequest } from '../validation'
import { getAppointmentConfig, getAppointmentsByDate } from '../storage'

interface Env {
  DB: D1Database
  RATE_LIMIT_KV: KVNamespace
}

export function createAppointmentsRoutes() {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/appointments/slots', async c => {
    const db = c.env.DB

    try {
      const date = c.req.query('date')
      const duration = c.req.query('duration')

      const validation = validateSlotFetchRequest(date, duration)
      if (!validation.valid) {
        return c.json(
          {
            message: validation.errors.join(', '),
            errors: validation.errors
          },
          400
        )
      }

      const requestDate = validation.parsedDate
      const requestDuration = validation.parsedDuration

      if (!requestDate || !requestDuration) {
        return c.json({ message: 'Invalid date or duration' }, 400)
      }

      const config = await getAppointmentConfig(db)
      if (!config) {
        return c.json({ message: 'Appointment system not configured' }, 500)
      }

      const availableDays = config.available_days.split(',').map(d => parseInt(d.trim()))
      const slotDurations = config.slot_duration_options.split(',').map(d => parseInt(d.trim()))

      if (!slotDurations.includes(requestDuration)) {
        return c.json(
          {
            message: `Duration ${requestDuration} not available. Available durations: ${slotDurations.join(', ')}`
          },
          400
        )
      }

      const now = new Date()
      const minAdvanceMs = config.min_advance_hours * 60 * 60 * 1000
      const minAllowedTime = new Date(now.getTime() + minAdvanceMs)

      const [startHour, startMinute] = config.business_hours_start.split(':').map(Number)
      const firstSlotTime = new Date(`${requestDate}T00:00:00.000Z`)
      firstSlotTime.setUTCHours(startHour, startMinute, 0, 0)

      if (firstSlotTime < minAllowedTime) {
        return c.json(
          {
            message: `Appointments must be booked at least ${config.min_advance_hours} hours in advance`
          },
          400
        )
      }

      const maxAdvanceMs = config.max_advance_days * 24 * 60 * 60 * 1000
      const maxAllowedTime = new Date(now.getTime() + maxAdvanceMs)

      if (firstSlotTime > maxAllowedTime) {
        return c.json(
          {
            message: `Appointments can only be booked up to ${config.max_advance_days} days in advance`
          },
          400
        )
      }

      const dayOfWeek = firstSlotTime.getUTCDay()
      if (!availableDays.includes(dayOfWeek)) {
        return c.json(
          {
            message: 'No appointments available on this day of the week'
          },
          400
        )
      }

      const slots = await generateTimeSlots(
        db,
        requestDate,
        requestDuration,
        config.business_hours_start,
        config.business_hours_end,
        config.timezone
      )

      return c.json({
        date: requestDate,
        duration: requestDuration,
        timezone: config.timezone,
        slots
      })
    } catch (error) {
      console.error('Error fetching appointment slots:', error)
      return c.json({ message: 'Failed to fetch available slots' }, 500)
    }
  })

  return app
}

async function generateTimeSlots(
  db: D1Database,
  date: string,
  duration: number,
  businessHoursStart: string,
  businessHoursEnd: string,
  _timezone: string
): Promise<{ id: string; startTime: string; endTime: string; available: boolean }[]> {
  const existingAppointments = await getAppointmentsByDate(db, date)
  const bookedSlotIds = new Set(existingAppointments.map(apt => apt.slot_id))

  const [startHour, startMinute] = businessHoursStart.split(':').map(Number)
  const [endHour, endMinute] = businessHoursEnd.split(':').map(Number)

  const dateObj = new Date(`${date}T00:00:00.000Z`)
  const slots = []

  let currentTime = new Date(dateObj)
  currentTime.setUTCHours(startHour, startMinute, 0, 0)

  const endTime = new Date(dateObj)
  endTime.setUTCHours(endHour, endMinute, 0, 0)

  while (currentTime < endTime) {
    const slotStart = new Date(currentTime)
    const slotEnd = new Date(currentTime.getTime() + duration * 60 * 1000)

    if (slotEnd > endTime) {
      break
    }

    const slotId = `slot-${date}-${slotStart.toISOString()}`
    const available = !bookedSlotIds.has(slotId)

    slots.push({
      id: slotId,
      startTime: slotStart.toISOString(),
      endTime: slotEnd.toISOString(),
      available
    })

    currentTime = slotEnd
  }

  const now = new Date()
  return slots.filter(slot => new Date(slot.startTime) > now)
}
