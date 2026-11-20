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
  isOfferedStart,
  rejectDate,
  slotStarts,
  weeklyHoursFrom,
  type BookingWindow
} from '../../utils/booking-window'

/** The D1 defaults from migration 0004: 09:00-17:00, Monday to Friday. */
const WINDOW: BookingWindow = {
  timezone: 'America/Los_Angeles',
  weeklyHours: weeklyHoursFrom([1, 2, 3, 4, 5], 9, 17),
  minAdvanceHours: 24,
  maxAdvanceDays: 30
}

/** `grid` with one hour of one day switched to `on`. */
function paint(grid: string, day: number, hour: number, on: boolean): string {
  const i = day * 24 + hour
  return grid.slice(0, i) + (on ? '1' : '0') + grid.slice(i + 1)
}

const iso = (dates: Date[]) => dates.map(d => d.toISOString())

// Monday 2026-08-24, 16:59 PDT — the moment in the bug report.
const MONDAY_EVENING = new Date('2026-08-24T23:59:00.000Z')
// Same Monday, 10:00 PDT — an hour after open, so the 24h cutoff lands an
// hour INTO Tuesday's business day rather than exactly on its first slot.
const MONDAY_MORNING = new Date('2026-08-24T17:00:00.000Z')

const TUESDAY = '2026-08-25'
const WEDNESDAY = '2026-08-26'
const SATURDAY = '2026-08-29'

describe('slotStarts', () => {
  it('ends the day one duration before business close', () => {
    const starts = slotStarts(TUESDAY, 30, WINDOW)
    // 09:00 PDT = 16:00Z; 17:00 PDT = 00:00Z next day, minus 30 min.
    expect(starts[0].toISOString()).toBe('2026-08-25T16:00:00.000Z')
    expect(starts[starts.length - 1].toISOString()).toBe('2026-08-25T23:30:00.000Z')
    expect(starts).toHaveLength(16)
  })

  it('moves the last start earlier for a longer meeting', () => {
    const starts = slotStarts(TUESDAY, 60, WINDOW)
    expect(starts[starts.length - 1].toISOString()).toBe('2026-08-25T23:00:00.000Z')
  })

  it('offers one painted hour on its own, and nothing either side of it', () => {
    const grid = paint('0'.repeat(168), 6, 14, true) // Saturday 2pm only
    const window = { ...WINDOW, weeklyHours: grid }
    expect(iso(slotStarts(SATURDAY, 30, window))).toEqual([
      '2026-08-29T21:00:00.000Z',
      '2026-08-29T21:30:00.000Z'
    ])
    expect(slotStarts(TUESDAY, 30, window)).toEqual([])
  })

  it('never offers a slot across an unpainted hour', () => {
    const window = { ...WINDOW, weeklyHours: paint(WINDOW.weeklyHours, 2, 12, false) } // Tue noon off
    const starts = iso(slotStarts(TUESDAY, 60, window))
    expect(starts).toContain('2026-08-25T18:00:00.000Z') // 11:00 PDT
    expect(starts).not.toContain('2026-08-25T19:00:00.000Z') // 12:00 PDT
    expect(starts).toContain('2026-08-25T20:00:00.000Z') // 13:00 PDT
    expect(starts).toHaveLength(7)
  })

  /**
   * The visitor's day, not the operator's. A Tokyo visitor's Wednesday 26th
   * starts at 15:00Z on the 25th, so it holds the back half of the operator's
   * Tuesday (01:00-09:00 JST) and nothing of their Wednesday morning.
   */
  it("answers a date in the visitor's zone with the slots that land on it there", () => {
    const tokyo = slotStarts(WEDNESDAY, 60, WINDOW, 'Asia/Tokyo')
    expect(iso(tokyo)).toEqual(iso(slotStarts(TUESDAY, 60, WINDOW)))
    // The operator's Saturday is off, but Tokyo's Saturday holds their Friday.
    expect(slotStarts(SATURDAY, 60, WINDOW, 'Asia/Tokyo')).toHaveLength(8)
    expect(slotStarts('2026-08-30', 60, WINDOW, 'Asia/Tokyo')).toEqual([])
  })
})

describe('isOfferedStart', () => {
  it('accepts a start on the grid and refuses one off it or outside the hours', () => {
    expect(isOfferedStart(new Date('2026-08-26T16:30:00.000Z'), 30, WINDOW, MONDAY_EVENING)).toBe(
      true
    )
    expect(isOfferedStart(new Date('2026-08-26T16:10:00.000Z'), 30, WINDOW, MONDAY_EVENING)).toBe(
      false
    )
    expect(isOfferedStart(new Date('2026-08-26T03:00:00.000Z'), 30, WINDOW, MONDAY_EVENING)).toBe(
      false
    )
  })

  it('refuses a start inside the notice window', () => {
    expect(isOfferedStart(new Date('2026-08-25T16:00:00.000Z'), 30, WINDOW, MONDAY_EVENING)).toBe(
      false
    )
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
    const [first] = slotStarts(TUESDAY, 30, WINDOW)
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
