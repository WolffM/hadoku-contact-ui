/**
 * Unit tests for the booking window — the rule the API enforces and the contact
 * form's calendar greys dates out with.
 *
 * The dates here are fixed rather than derived from "today" on purpose: the
 * reported bug was a specific clock reading (a Monday evening, a 24h notice, a
 * 09:00-17:00 day) and it only reproduces if the clock is pinned.
 */
import { describe, it, expect } from 'vitest'
import {
  advanceBounds,
  isDateBookable,
  rejectDate,
  slotStartRange,
  type BookingWindow
} from '../../utils/booking-window'

/** The D1 defaults from migration 0004. */
const WINDOW: BookingWindow = {
  timezone: 'America/Los_Angeles',
  businessHoursStart: '09:00',
  businessHoursEnd: '17:00',
  availableDays: [1, 2, 3, 4, 5],
  minAdvanceHours: 24,
  maxAdvanceDays: 30
}

// Monday 2026-08-24, 16:59 PDT — the moment in the bug report.
const MONDAY_EVENING = new Date('2026-08-24T23:59:00.000Z')
// Same Monday, 10:00 PDT — an hour after open, so the 24h cutoff lands an
// hour INTO Tuesday's business day rather than exactly on its first slot.
const MONDAY_MORNING = new Date('2026-08-24T17:00:00.000Z')

const TUESDAY = '2026-08-25'
const WEDNESDAY = '2026-08-26'
const SATURDAY = '2026-08-29'

describe('slotStartRange', () => {
  it('ends the day one duration before business close', () => {
    const { first, last } = slotStartRange(TUESDAY, 30, WINDOW)
    // 09:00 PDT = 16:00Z; 17:00 PDT = 00:00Z next day, minus 30 min.
    expect(first.toISOString()).toBe('2026-08-25T16:00:00.000Z')
    expect(last.toISOString()).toBe('2026-08-25T23:30:00.000Z')
  })

  it('moves the last start earlier for a longer meeting', () => {
    expect(slotStartRange(TUESDAY, 60, WINDOW).last.toISOString()).toBe('2026-08-25T23:00:00.000Z')
  })
})

describe('advanceBounds', () => {
  it('opens exactly minAdvanceHours out', () => {
    expect(advanceBounds(WINDOW, MONDAY_EVENING).earliest.toISOString()).toBe(
      '2026-08-25T23:59:00.000Z'
    )
  })
})

describe('rejectDate', () => {
  /**
   * The reported failure. Asked at 16:59 on Monday, a strict 24h notice does not
   * open until 16:59 Tuesday — one minute after the last slot that fits inside a
   * 17:00 close. Nothing on Tuesday is bookable, and the calendar must say so by
   * greying the date rather than by letting the user click it and answering with
   * an error they cannot act on.
   */
  it('refuses all of tomorrow when the notice window swallows the whole day', () => {
    expect(rejectDate(TUESDAY, 30, WINDOW, MONDAY_EVENING)).toBe('too_soon')
    expect(rejectDate(TUESDAY, 15, WINDOW, MONDAY_EVENING)).toBe('too_soon')
  })

  it('still offers the day after tomorrow from that same evening', () => {
    expect(rejectDate(WEDNESDAY, 30, WINDOW, MONDAY_EVENING)).toBeNull()
  })

  /**
   * The regression the per-slot rule exists to prevent: asked in the morning,
   * tomorrow's afternoon is well clear of the cutoff even though its 09:00 is
   * not, so the day must survive as a whole.
   */
  it('keeps a day whose late slots clear the cutoff but whose early ones do not', () => {
    expect(rejectDate(TUESDAY, 30, WINDOW, MONDAY_MORNING)).toBeNull()
    const { first } = slotStartRange(TUESDAY, 30, WINDOW)
    const { earliest } = advanceBounds(WINDOW, MONDAY_MORNING)
    expect(first.getTime()).toBeLessThan(earliest.getTime())
  })

  it('refuses a day the operator does not work', () => {
    expect(rejectDate(SATURDAY, 30, WINDOW, MONDAY_MORNING)).toBe('day_off')
  })

  it('refuses a date past the far bound', () => {
    expect(rejectDate('2026-10-30', 30, WINDOW, MONDAY_MORNING)).toBe('too_far')
  })

  it('opens the whole day once a shorter notice is configured', () => {
    const relaxed = { ...WINDOW, minAdvanceHours: 2 }
    expect(rejectDate(TUESDAY, 30, relaxed, MONDAY_EVENING)).toBeNull()
    expect(isDateBookable(TUESDAY, 30, relaxed, MONDAY_EVENING)).toBe(true)
  })
})
