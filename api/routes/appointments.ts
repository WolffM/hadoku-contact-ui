/**
 * Appointments endpoints
 */

import { Hono } from 'hono'
import { validateSlotFetchRequest } from '../validation'
import {
  getAppointmentConfig,
  getAppointmentsByDate,
  getBookedSlotIdsInRange,
  parseIntList,
  toBookingWindow
} from '../storage'
import {
  advanceBounds,
  datesBetween,
  rejectDate,
  slotId,
  slotStarts,
  type BookingWindow
} from '../utils/booking-window'

/** Guards the range so one request cannot ask the calendar to scan a decade. */
const MAX_AVAILABILITY_DAYS = 62
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

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

      const allSlots = await generateTimeSlots(db, requestDate, requestDuration, bookingWindow)

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

  /**
   * How many slots each date in a range still has free.
   *
   * This is what the calendar greys dates out with. The window alone is not
   * enough to answer "can I book that day": a date can clear every bound and
   * still be full, and a date the user can click but that has nothing behind it
   * is the same dead end as the one that started all this — the notice is
   * useless, the date should simply be unclickable.
   *
   * Only dates with at least one free slot appear in `dates`. Everything else —
   * weekends, days inside the notice window, days past the far bound, and days
   * booked solid — is absent, so the client greys out anything it does not find
   * here rather than having to re-derive why.
   */
  app.get('/appointments/availability', async c => {
    const db = c.env.DB

    try {
      const duration = parseInt(c.req.query('duration') ?? '', 10)
      const from = c.req.query('from') ?? ''
      const to = c.req.query('to') ?? ''

      if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to) || from > to) {
        return c.json({ message: 'from and to must be YYYY-MM-DD, with from <= to' }, 400)
      }

      const config = await getAppointmentConfig(db)
      if (!config) {
        return c.json({ message: 'Appointment system not configured' }, 500)
      }

      if (!parseIntList(config.slot_duration_options).includes(duration)) {
        return c.json({ message: `Duration ${c.req.query('duration')} not available` }, 400)
      }

      const dateList = datesBetween(from, to)
      if (dateList.length > MAX_AVAILABILITY_DAYS) {
        return c.json(
          { message: `Range too wide — ask for at most ${MAX_AVAILABILITY_DAYS} days` },
          400
        )
      }

      const bookingWindow = toBookingWindow(config)
      const now = new Date()
      const { earliest, latest } = advanceBounds(bookingWindow, now)
      const bookedSlotIds = await getBookedSlotIdsInRange(db, from, to)

      const dates: Record<string, number> = {}
      for (const date of dateList) {
        if (rejectDate(date, duration, bookingWindow, now)) continue

        const free = slotStarts(date, duration, bookingWindow).filter(
          start => start >= earliest && start <= latest && !bookedSlotIds.has(slotId(date, start))
        ).length

        if (free > 0) dates[date] = free
      }

      return c.json({ duration, from, to, timezone: config.timezone, dates })
    } catch (error) {
      console.error('Error fetching appointment availability:', error)
      return c.json({ message: 'Failed to fetch availability' }, 500)
    }
  })

  return app
}

/**
 * The day's slots, each marked with whether it is still free.
 *
 * Built on `slotStarts` so this and the availability endpoint count the same
 * grid — the two used to derive it separately, which is exactly the kind of
 * split that lets a calendar offer a date its own slot list then comes back
 * empty for.
 */
async function generateTimeSlots(
  db: D1Database,
  date: string,
  duration: number,
  window: BookingWindow
): Promise<{ id: string; startTime: string; endTime: string; available: boolean }[]> {
  const existingAppointments = await getAppointmentsByDate(db, date)
  const bookedSlotIds = new Set(existingAppointments.map(apt => apt.slot_id))
  const now = new Date()

  return slotStarts(date, duration, window)
    .filter(start => start > now)
    .map(start => ({
      id: slotId(date, start),
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + duration * 60 * 1000).toISOString(),
      available: !bookedSlotIds.has(slotId(date, start))
    }))
}
