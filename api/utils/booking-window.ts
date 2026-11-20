/**
 * The booking window: which slot start instants can hold an appointment.
 *
 * This module is imported by BOTH halves of the package — the API's
 * `/appointments/slots` route and the contact form's calendar. That is the whole
 * point of it. The form used to carry its own hardcoded copy of the rule
 * ("tomorrow at local midnight, weekends included") while the server enforced
 * the real one, so the calendar happily offered dates the server then refused.
 * One definition, imported by both, is the only thing that keeps them agreeing.
 * It carries no Workers or DOM types so it bundles into either build.
 *
 * Availability is a weekly grid of hours (`weeklyHours`), painted by the
 * operator in their own zone. A visitor reads it in THEIR zone: every function
 * that takes a date takes the zone that date is a calendar day in, so "Monday"
 * means the visitor's Monday, which in Tokyo is mostly the operator's Sunday.
 */

import { zonedDateToUtc, dayOfWeekInZone, localDateOf } from './timezone'

/** Hours in a week: the length of `weeklyHours`. */
export const WEEK_HOURS = 168

/** The parts of `appointment_config` that bound when a booking may land. */
export interface BookingWindow {
  /** The operator's IANA zone: the zone `weeklyHours` is painted in. */
  timezone: string
  /**
   * One '0'/'1' per hour of the week, index `day * 24 + hour`, 0 = Sunday,
   * wall-clock in `timezone`. A slot is offerable when every hour it touches is '1'.
   */
  weeklyHours: string
  minAdvanceHours: number
  maxAdvanceDays: number
}

export function isWeeklyHours(value: unknown): value is string {
  return typeof value === 'string' && /^[01]{168}$/.test(value)
}

/** The grid with each day on for `[startHour, endHour)`. */
export function weeklyHoursFrom(days: number[], startHour: number, endHour: number): string {
  let out = ''
  for (let i = 0; i < WEEK_HOURS; i++) {
    const hour = i % 24
    out += days.includes(Math.floor(i / 24)) && hour >= startHour && hour < endHour ? '1' : '0'
  }
  return out
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

/** `'2026-08-31'`, 1 -> `'2026-09-01'`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The day's painted hours as `[start, end)` runs. */
function hourRuns(weeklyHours: string, day: number): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = -1
  for (let hour = 0; hour <= 24; hour++) {
    const on = hour < 24 && weeklyHours[day * 24 + hour] === '1'
    if (on && start < 0) start = hour
    if (!on && start >= 0) {
      runs.push([start, hour])
      start = -1
    }
  }
  return runs
}

/** Slot starts on the operator's own calendar date `date`. */
function operatorDayStarts(date: string, duration: number, window: BookingWindow): Date[] {
  const tz = window.timezone
  const step = duration * 60 * 1000
  const starts: Date[] = []
  for (const [startHour, endHour] of hourRuns(window.weeklyHours, dayOfWeekInZone(date, tz))) {
    const first = zonedDateToUtc(date, startHour, 0, tz).getTime()
    const end = (
      endHour === 24
        ? zonedDateToUtc(addDays(date, 1), 0, 0, tz)
        : zonedDateToUtc(date, endHour, 0, tz)
    ).getTime()
    for (let t = first; t + step <= end; t += step) starts.push(new Date(t))
  }
  return starts
}

/**
 * Every slot START on `date` as a calendar day in `zone` (the operator's own
 * by default), in order — the raw grid, before the advance window or bookings
 * are subtracted from it.
 */
export function slotStarts(
  date: string,
  duration: number,
  window: BookingWindow,
  zone: string = window.timezone
): Date[] {
  if (zone === window.timezone) return operatorDayStarts(date, duration, window)
  // A day in any zone overlaps at most the operator's day before, of, and after.
  return [-1, 0, 1]
    .flatMap(offset => operatorDayStarts(addDays(date, offset), duration, window))
    .filter(start => localDateOf(start, zone) === date)
}

export type DateRejection = 'too_soon' | 'too_far' | 'day_off'

/**
 * Why nothing on `date` (a day in `zone`) can be booked, or null when at least
 * one slot on it can.
 */
export function rejectDate(
  date: string,
  duration: number,
  window: BookingWindow,
  now: Date = new Date(),
  zone: string = window.timezone
): DateRejection | null {
  const starts = slotStarts(date, duration, window, zone)
  if (starts.length === 0) return 'day_off'
  const { earliest, latest } = advanceBounds(window, now)
  if (starts.some(s => s >= earliest && s <= latest)) return null
  return starts[starts.length - 1] < earliest ? 'too_soon' : 'too_far'
}

/** True when at least one slot of `duration` on `date` is offerable. */
export function isDateBookable(
  date: string,
  duration: number,
  window: BookingWindow,
  now: Date = new Date(),
  zone: string = window.timezone
): boolean {
  return rejectDate(date, duration, window, now, zone) === null
}

/**
 * True when `start` is a slot start the window offers right now: on the grid
 * for `duration`, every hour painted, and inside the advance window. The submit
 * route asks this so a booking cannot land outside the hours on the calendar.
 */
export function isOfferedStart(
  start: Date,
  duration: number,
  window: BookingWindow,
  now: Date = new Date()
): boolean {
  const { earliest, latest } = advanceBounds(window, now)
  if (start < earliest || start > latest) return false
  const day = localDateOf(start, window.timezone)
  return slotStarts(day, duration, window).some(s => s.getTime() === start.getTime())
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
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d)
  return dates
}
