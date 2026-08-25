/**
 * The booking window: the rules that decide whether a calendar date can hold an
 * appointment at all, and which slot start times on it are offerable.
 *
 * This module is imported by BOTH halves of the package — the API's
 * `/appointments/slots` route and the contact form's calendar. That is the whole
 * point of it. The form used to carry its own hardcoded copy of the rule
 * ("tomorrow at local midnight, weekends included") while the server enforced
 * the real one, so the calendar happily offered dates the server then refused:
 * click tomorrow at 5pm and you got `Appointments must be booked at least 24
 * hours in advance` instead of a list of times. A user cannot act on that error
 * — the date was never bookable, and the UI is what offered it.
 *
 * One definition, imported by both, is the only thing that keeps them agreeing.
 * It carries no Workers or DOM types so it bundles into either build.
 */

import { zonedDateToUtc, dayOfWeekInZone } from './timezone'

/** The parts of `appointment_config` that bound when a booking may land. */
export interface BookingWindow {
  timezone: string
  /** 'HH:MM' wall-clock in `timezone`. */
  businessHoursStart: string
  businessHoursEnd: string
  /** 0=Sun .. 6=Sat */
  availableDays: number[]
  minAdvanceHours: number
  maxAdvanceDays: number
}

/** The earliest and latest instants at which a slot may START. */
export function advanceBounds(
  window: Pick<BookingWindow, 'minAdvanceHours' | 'maxAdvanceDays'>,
  now: Date = new Date()
): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() + window.minAdvanceHours * 60 * 60 * 1000),
    latest: new Date(now.getTime() + window.maxAdvanceDays * 24 * 60 * 60 * 1000)
  }
}

/**
 * The first and last slot START instants that fit inside a date's business
 * hours for a given duration.
 *
 * `last` is the day's best case against the minimum-notice bound and `first` is
 * its best case against the far bound — which is why a day is only refused when
 * even its best case fails.
 */
export function slotStartRange(
  date: string,
  duration: number,
  window: Pick<BookingWindow, 'timezone' | 'businessHoursStart' | 'businessHoursEnd'>
): { first: Date; last: Date } {
  const [startHour, startMinute] = window.businessHoursStart.split(':').map(Number)
  const [endHour, endMinute] = window.businessHoursEnd.split(':').map(Number)
  const first = zonedDateToUtc(date, startHour, startMinute, window.timezone)
  const businessEnd = zonedDateToUtc(date, endHour, endMinute, window.timezone)
  return { first, last: new Date(businessEnd.getTime() - duration * 60 * 1000) }
}

export type DateRejection = 'too_soon' | 'too_far' | 'day_off'

/**
 * Why nothing on `date` can be booked, or null when at least one slot on it can.
 *
 * The three checks run in the order the API reports them, so the calendar and
 * the endpoint never disagree about which rule a date fell foul of.
 */
export function rejectDate(
  date: string,
  duration: number,
  window: BookingWindow,
  now: Date = new Date()
): DateRejection | null {
  const { earliest, latest } = advanceBounds(window, now)
  const { first, last } = slotStartRange(date, duration, window)

  if (last < earliest) return 'too_soon'
  if (first > latest) return 'too_far'
  if (!window.availableDays.includes(dayOfWeekInZone(date, window.timezone))) return 'day_off'
  return null
}

/** True when at least one slot of `duration` on `date` is offerable. */
export function isDateBookable(
  date: string,
  duration: number,
  window: BookingWindow,
  now: Date = new Date()
): boolean {
  return rejectDate(date, duration, window, now) === null
}

/**
 * Every slot START instant on `date`, in order — the raw grid, before anything
 * is subtracted from it.
 *
 * Pure on purpose: the slots endpoint and the availability endpoint both need
 * this grid, and only one of them needs to go to the database to find out what
 * has been booked out of it.
 */
export function slotStarts(
  date: string,
  duration: number,
  window: Pick<BookingWindow, 'timezone' | 'businessHoursStart' | 'businessHoursEnd'>
): Date[] {
  const { first, last } = slotStartRange(date, duration, window)
  const starts: Date[] = []
  for (let t = first.getTime(); t <= last.getTime(); t += duration * 60 * 1000) {
    starts.push(new Date(t))
  }
  return starts
}

/** The id `generateTimeSlots` and `appointments.slot_id` both use for a slot. */
export function slotId(date: string, start: Date): string {
  return `slot-${date}-${start.toISOString()}`
}

/**
 * Every date from `from` to `to` inclusive, as YYYY-MM-DD.
 *
 * Stepped in UTC and formatted from the UTC fields, so it never skips or repeats
 * a date the way local-midnight arithmetic does across a DST boundary.
 */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const cursor = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().split('T')[0])
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}
