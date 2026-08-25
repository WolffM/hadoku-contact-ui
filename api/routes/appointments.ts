/**
 * Appointments endpoints
 */

import { Hono } from 'hono'
import { validateSlotFetchRequest } from '../validation'
import {
  getAppointmentConfig,
  getAppointmentsByDate,
  parseIntList,
  toBookingWindow
} from '../storage'
import { zonedDateToUtc } from '../utils/timezone'
import { advanceBounds, rejectDate } from '../utils/booking-window'

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

      const slotDurations = parseIntList(config.slot_duration_options)
      const bookingWindow = toBookingWindow(config)

      if (!slotDurations.includes(requestDuration)) {
        return c.json(
          {
            message: `Duration ${requestDuration} not available. Available durations: ${slotDurations.join(', ')}`
          },
          400
        )
      }

      // The advance window is a property of each SLOT, not of the day.
      //
      // Both bounds used to be tested against the day's FIRST slot, so a day was
      // rejected whole the moment its 9am fell inside the notice window — even
      // when its afternoon was hours clear of the cutoff. With a 24h rule and a
      // 09:00-17:00 day, asking at noon rejected all of tomorrow, including the
      // 4:30pm slot a full 28h out.
      //
      // A day is now refused only when NOTHING on it can be booked, which keeps
      // the error messages meaning what they say. Partially-open days return
      // their bookable slots, filtered below. `rejectDate` is the same function
      // the contact form's calendar greys dates out with, so a date the user can
      // still click is a date this endpoint will answer with times.
      const now = new Date()
      const { earliest: minAllowedTime, latest: maxAllowedTime } = advanceBounds(bookingWindow, now)

      switch (rejectDate(requestDate, requestDuration, bookingWindow, now)) {
        case 'too_soon':
          return c.json(
            {
              message: `Appointments must be booked at least ${config.min_advance_hours} hours in advance`
            },
            400
          )
        case 'too_far':
          return c.json(
            {
              message: `Appointments can only be booked up to ${config.max_advance_days} days in advance`
            },
            400
          )
        case 'day_off':
          return c.json(
            {
              message: 'No appointments available on this day of the week'
            },
            400
          )
      }

      const allSlots = await generateTimeSlots(
        db,
        requestDate,
        requestDuration,
        config.business_hours_start,
        config.business_hours_end,
        config.timezone
      )

      // Drop the individual slots outside the window. Dropped rather than marked
      // unavailable: `available: false` means "someone already booked this", and
      // a slot that cannot be offered at all is not the same thing.
      const slots = allSlots.filter(slot => {
        const start = new Date(slot.startTime)
        return start >= minAllowedTime && start <= maxAllowedTime
      })

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

  /**
   * The booking window, public and unauthenticated.
   *
   * The contact form needs it to grey out dates nothing can be booked on. It
   * used to guess — "tomorrow at the browser's local midnight" — which offered
   * weekends, days past the far bound, and (the report that prompted this)
   * tomorrow when the notice window had already swallowed all of it. Guessing is
   * not fixable from the client: only the server knows the timezone, the
   * business hours and the operator's current notice setting.
   *
   * Nothing here is sensitive — it is the same shape the booking page renders —
   * and it deliberately omits every operational column the admin config returns.
   */
  app.get('/appointments/config', async c => {
    try {
      const config = await getAppointmentConfig(c.env.DB)
      if (!config) {
        return c.json({ message: 'Appointment system not configured' }, 500)
      }

      return c.json({
        ...toBookingWindow(config),
        slotDurations: parseIntList(config.slot_duration_options),
        platforms: config.meeting_platforms.split(',').map(p => p.trim())
      })
    } catch (error) {
      console.error('Error fetching appointment config:', error)
      return c.json({ message: 'Failed to fetch appointment configuration' }, 500)
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
  timezone: string
): Promise<{ id: string; startTime: string; endTime: string; available: boolean }[]> {
  const existingAppointments = await getAppointmentsByDate(db, date)
  const bookedSlotIds = new Set(existingAppointments.map(apt => apt.slot_id))

  const [startHour, startMinute] = businessHoursStart.split(':').map(Number)
  const [endHour, endMinute] = businessHoursEnd.split(':').map(Number)

  let currentTime = zonedDateToUtc(date, startHour, startMinute, timezone)
  const endTime = zonedDateToUtc(date, endHour, endMinute, timezone)
  const slots = []

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
