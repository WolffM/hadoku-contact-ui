/**
 * Appointment Slots Integration Tests
 *
 * Tests GET /appointments/slots against real D1:
 * - Response schema matching contact-ui expectations
 * - Business hours enforcement
 * - Advance notice validation
 * - Day of week filtering
 * - Booked slots marked unavailable
 * - Full booking flow
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { isDateBookable, type BookingWindow } from '../../utils/booking-window'

interface Slot {
  id: string
  startTime: string
  endTime: string
  available: boolean
}

interface SlotsResponse {
  date: string
  duration: number
  timezone: string
  slots: Slot[]
}

/** Get a weekday N days from now using UTC math (deterministic regardless of host TZ) */
function getNextWeekday(daysFromNow: number): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + daysFromNow)
  const day = date.getUTCDay()
  if (day === 0) date.setUTCDate(date.getUTCDate() + 1)
  else if (day === 6) date.setUTCDate(date.getUTCDate() + 2)
  return date
}

/** Get the next occurrence of a UTC weekday at least minDaysOut days in the future. */
function nextUtcWeekday(targetDay: number, minDaysOut = 5): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + minDaysOut)
  const cur = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + ((targetDay - cur + 7) % 7))
  return d.toISOString().split('T')[0]
}

async function fetchSlots(date: string, duration: number) {
  return SELF.fetch(
    `https://test.com/contact/api/appointments/slots?date=${date}&duration=${duration}`
  )
}

describe('Appointment Slots Integration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()

    // Reset config
    await env.DB.prepare(
      `UPDATE appointment_config SET
				timezone = 'America/New_York',
				business_hours_start = '09:00',
				business_hours_end = '17:00',
				available_days = '1,2,3,4,5',
				slot_duration_options = '15,30,60',
				max_advance_days = 30,
				min_advance_hours = 24,
				meeting_platforms = 'discord,google,teams,jitsi'
			WHERE id = 1`
    ).run()
  })

  describe('Schema Validation', () => {
    it('should return response matching contact-ui schema', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const response = await fetchSlots(date, 30)

      expect(response.status).toBe(200)
      const data = (await response.json()) as SlotsResponse

      expect(data.date).toBe(date)
      expect(data.duration).toBe(30)
      expect(data.timezone).toBe('America/New_York')
      expect(Array.isArray(data.slots)).toBe(true)

      if (data.slots.length > 0) {
        const slot = data.slots[0]
        expect(typeof slot.id).toBe('string')
        expect(slot.id).toMatch(/^slot-/)
        expect(typeof slot.startTime).toBe('string')
        expect(typeof slot.endTime).toBe('string')
        expect(typeof slot.available).toBe('boolean')

        // Validate duration
        const start = new Date(slot.startTime)
        const end = new Date(slot.endTime)
        expect((end.getTime() - start.getTime()) / 60000).toBe(30)
      }
    })

    it('should return all slots as available when no bookings exist', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const response = await fetchSlots(date, 30)

      expect(response.status).toBe(200)
      const data = (await response.json()) as SlotsResponse
      expect(data.slots.every(s => s.available)).toBe(true)
    })

    it('should mark booked slots as unavailable', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const bookedStart = new Date(`${date}T10:00:00.000Z`)
      const bookedSlotId = `slot-${date}-${bookedStart.toISOString()}`

      // Insert a confirmed appointment directly in D1
      await env.DB.prepare(
        `INSERT INTO appointments (id, name, email, slot_id, date, start_time, end_time, duration, timezone, platform, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          'apt-booked',
          'Booked User',
          'booked@example.com',
          bookedSlotId,
          date,
          bookedStart.toISOString(),
          new Date(bookedStart.getTime() + 30 * 60000).toISOString(),
          30,
          'America/New_York',
          'discord',
          'confirmed',
          Date.now(),
          Date.now()
        )
        .run()

      const response = await fetchSlots(date, 30)
      expect(response.status).toBe(200)
      const data = (await response.json()) as SlotsResponse

      const bookedSlot = data.slots.find(s => s.id === bookedSlotId)
      if (bookedSlot) {
        expect(bookedSlot.available).toBe(false)
      }

      expect(data.slots.filter(s => s.available).length).toBeGreaterThan(0)
    })
  })

  describe('Parameter Validation', () => {
    it('should require date parameter', async () => {
      const response = await SELF.fetch(
        'https://test.com/contact/api/appointments/slots?duration=30'
      )
      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: string[] }
      expect(data.errors).toContain('Date parameter is required')
    })

    it('should require duration parameter', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const response = await SELF.fetch(
        `https://test.com/contact/api/appointments/slots?date=${date}`
      )
      expect(response.status).toBe(400)
      const data = (await response.json()) as { errors: string[] }
      expect(data.errors).toContain('Duration parameter is required')
    })

    it('should reject invalid duration', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const response = await fetchSlots(date, 45)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message: string }
      expect(data.message).toContain('Duration')
    })

    it('should accept valid durations (15, 30, 60)', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      for (const duration of [15, 30, 60]) {
        const response = await fetchSlots(date, duration)
        expect(response.status).toBe(200)
        const data = (await response.json()) as SlotsResponse
        expect(data.duration).toBe(duration)
      }
    })
  })

  /**
   * The window the contact form's calendar reads to decide which dates to grey
   * out. Before this endpoint existed the form guessed ("tomorrow at the
   * browser's local midnight"), offered weekends and days the notice window had
   * already closed, and got a 400 back for the whole day when the user clicked
   * one.
   */
  describe('GET /appointments/config', () => {
    it('publishes the booking window the slots endpoint enforces', async () => {
      const response = await SELF.fetch('https://test.com/contact/api/appointments/config')
      expect(response.status).toBe(200)

      const config = (await response.json()) as Record<string, unknown>
      expect(config).toMatchObject({
        timezone: 'America/New_York',
        businessHoursStart: '09:00',
        businessHoursEnd: '17:00',
        availableDays: [1, 2, 3, 4, 5],
        minAdvanceHours: 24,
        maxAdvanceDays: 30,
        slotDurations: [15, 30, 60]
      })
      expect(config.platforms).toEqual(['discord', 'google', 'teams', 'jitsi'])
    })

    it('needs no admin credentials — the booking page is public', async () => {
      const response = await SELF.fetch('https://test.com/contact/api/appointments/config')
      expect(response.status).toBe(200)
    })

    /**
     * The calendar must never grey a date the slots endpoint would have answered,
     * nor offer one it would refuse. Both now read the same `rejectDate`, so this
     * walks the next month and asserts they agree on every single day.
     */
    it('agrees with the slots endpoint on every date in the window', async () => {
      const response = await SELF.fetch('https://test.com/contact/api/appointments/config')
      const config = (await response.json()) as BookingWindow & { slotDurations: number[] }

      for (let offset = 0; offset <= 35; offset++) {
        const day = new Date()
        day.setUTCDate(day.getUTCDate() + offset)
        const date = day.toISOString().split('T')[0]

        const calendarSaysBookable = isDateBookable(date, 30, config)
        const slots = await fetchSlots(date, 30)

        expect(
          { date, bookable: calendarSaysBookable },
          `calendar and slots endpoint disagree about ${date}`
        ).toEqual({ date, bookable: slots.status === 200 })
      }
    })
  })

  /**
   * What the calendar greys dates out with. A date the user can click must have
   * something behind it — the whole complaint that produced this endpoint was a
   * clickable date answering with a rule instead of times.
   */
  describe('GET /appointments/availability', () => {
    async function fetchAvailability(duration: number, from: string, to: string) {
      return SELF.fetch(
        `https://test.com/contact/api/appointments/availability?duration=${duration}&from=${from}&to=${to}`
      )
    }

    /** The first and last date of the next 40 days, as YYYY-MM-DD. */
    function nextDays(count: number): { from: string; to: string } {
      const start = new Date()
      const end = new Date()
      end.setUTCDate(end.getUTCDate() + count)
      return {
        from: start.toISOString().split('T')[0],
        to: end.toISOString().split('T')[0]
      }
    }

    it('names only dates that have a slot left on them', async () => {
      const { from, to } = nextDays(40)
      const response = await fetchAvailability(30, from, to)
      expect(response.status).toBe(200)

      const { dates } = (await response.json()) as { dates: Record<string, number> }
      expect(Object.keys(dates).length).toBeGreaterThan(0)
      for (const count of Object.values(dates)) {
        expect(count).toBeGreaterThan(0)
      }
    })

    it('omits weekends and everything past the far bound', async () => {
      const { from, to } = nextDays(40)
      const { dates } = (await (await fetchAvailability(30, from, to)).json()) as {
        dates: Record<string, number>
      }

      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() + 30)

      for (const date of Object.keys(dates)) {
        const day = new Date(`${date}T12:00:00.000Z`).getUTCDay()
        expect(day).not.toBe(0)
        expect(day).not.toBe(6)
        expect(date <= cutoff.toISOString().split('T')[0]).toBe(true)
      }
    })

    /**
     * The case the window rules cannot answer, and the reason this endpoint
     * exists rather than the config alone: a day that clears every bound but has
     * been booked solid must be greyed exactly like a weekend.
     */
    it('drops a day once every slot on it is booked', async () => {
      const date = nextUtcWeekday(3)
      const { from, to } = nextDays(40)

      const before = (await (await fetchAvailability(60, from, to)).json()) as {
        dates: Record<string, number>
      }
      expect(before.dates[date]).toBeGreaterThan(0)

      const slots = ((await (await fetchSlots(date, 60)).json()) as SlotsResponse).slots
      for (const slot of slots) {
        await env.DB.prepare(
          `INSERT INTO appointments
             (id, name, email, slot_id, date, start_time, end_time, duration, timezone,
              platform, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`
        )
          .bind(
            `booked-${slot.id}`,
            'Fully Booked',
            'booked@example.com',
            slot.id,
            date,
            slot.startTime,
            slot.endTime,
            60,
            'America/New_York',
            'jitsi',
            Date.now(),
            Date.now()
          )
          .run()
      }

      const after = (await (await fetchAvailability(60, from, to)).json()) as {
        dates: Record<string, number>
      }
      expect(after.dates[date]).toBeUndefined()
      // Its neighbours are untouched — only the solid day drops out.
      expect(Object.keys(after.dates).length).toBe(Object.keys(before.dates).length - 1)
    })

    it('rejects a malformed or inverted range', async () => {
      expect((await fetchAvailability(30, 'not-a-date', '2026-09-01')).status).toBe(400)
      expect((await fetchAvailability(30, '2026-09-30', '2026-09-01')).status).toBe(400)
    })

    it('refuses a range too wide to be one calendar screen', async () => {
      expect((await fetchAvailability(30, '2026-01-01', '2026-12-31')).status).toBe(400)
    })

    it('rejects a duration the operator does not offer', async () => {
      const { from, to } = nextDays(10)
      expect((await fetchAvailability(45, from, to)).status).toBe(400)
    })

    /**
     * Every date the availability map names must actually return bookable slots,
     * and every weekday it omits must have none. This is the invariant the whole
     * change rests on: no clickable date without times behind it.
     */
    it('never names a date whose slot list comes back empty', async () => {
      const { from, to } = nextDays(35)
      const { dates } = (await (await fetchAvailability(30, from, to)).json()) as {
        dates: Record<string, number>
      }

      for (const date of Object.keys(dates)) {
        const response = await fetchSlots(date, 30)
        expect(response.status, `${date} was offered but slots refused it`).toBe(200)
        const slots = ((await response.json()) as SlotsResponse).slots.filter(s => s.available)
        expect(slots.length, `${date} was offered but has no free slots`).toBeGreaterThan(0)
      }
    })
  })

  describe('Business Rules', () => {
    it('should reject dates within advance notice window', async () => {
      // Use today's UTC date — its 9 AM NY (= 13:00 or 14:00 UTC) is at most ~24h
      // out and may already be in the past, so the 24h advance check rejects it.
      const today = new Date().toISOString().split('T')[0]

      const response = await fetchSlots(today, 30)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message: string }
      expect(data.message).toContain('advance')
    })

    /**
     * Regression: the notice window is per-slot, not per-day.
     *
     * Both bounds used to be tested against the day's FIRST slot, so a day was
     * rejected whole as soon as its 09:00 fell inside the window — even when its
     * afternoon was well clear. The contact form's calendar enables any date with
     * a bookable part, so it offered such a date and then got a 400 for all of it.
     *
     * Rather than do timezone arithmetic here, this reads a real slot instant back
     * from the API and sets the notice window to land on it — deterministic no
     * matter when or where the suite runs.
     */
    it('returns the later slots on a day whose early slots are inside the window', async () => {
      const date = getNextWeekday(5).toISOString().split('T')[0]

      const before = await fetchSlots(date, 30)
      expect(before.status).toBe(200)
      const all = ((await before.json()) as SlotsResponse).slots
      expect(all.length).toBeGreaterThan(4)

      // Put the cutoff exactly on a mid-morning slot: everything before it is now
      // inside the notice window, everything from it on is still bookable.
      const cutoff = all[Math.floor(all.length / 2)]
      const hoursUntilCutoff = Math.ceil(
        (new Date(cutoff.startTime).getTime() - Date.now()) / (60 * 60 * 1000)
      )
      await env.DB.prepare('UPDATE appointment_config SET min_advance_hours = ? WHERE id = 1')
        .bind(hoursUntilCutoff)
        .run()

      const after = await fetchSlots(date, 30)
      // The bug returned 400 here, discarding a day that was still partly open.
      expect(after.status).toBe(200)
      const remaining = ((await after.json()) as SlotsResponse).slots

      expect(remaining.length).toBeGreaterThan(0)
      expect(remaining.length).toBeLessThan(all.length)
      // Nothing survives that the window should have excluded.
      const minAllowed = Date.now() + hoursUntilCutoff * 60 * 60 * 1000
      for (const slot of remaining) {
        expect(new Date(slot.startTime).getTime()).toBeGreaterThanOrEqual(minAllowed)
      }
      expect(remaining.some(s => s.startTime === all[0].startTime)).toBe(false)
    })

    it('still rejects the whole day when even its last slot is inside the window', async () => {
      const date = getNextWeekday(5).toISOString().split('T')[0]

      const before = await fetchSlots(date, 30)
      expect(before.status).toBe(200)
      const all = ((await before.json()) as SlotsResponse).slots

      // Push the cutoff past the day's final slot — nothing on it is bookable.
      const last = all[all.length - 1]
      const hoursPastLast =
        Math.ceil((new Date(last.startTime).getTime() - Date.now()) / (60 * 60 * 1000)) + 1
      await env.DB.prepare('UPDATE appointment_config SET min_advance_hours = ? WHERE id = 1')
        .bind(hoursPastLast)
        .run()

      const after = await fetchSlots(date, 30)
      expect(after.status).toBe(400)
      expect(((await after.json()) as { message: string }).message).toContain('advance')
    })

    it('should reject dates too far in the future', async () => {
      const farFuture = new Date()
      farFuture.setDate(farFuture.getDate() + 60)
      const date = farFuture.toISOString().split('T')[0]

      const response = await fetchSlots(date, 30)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message: string }
      expect(data.message).toContain('30 days')
    })

    it('should reject unavailable day of week (weekend)', async () => {
      // Pick the next Sunday at least 5 days out using UTC math (avoids local-TZ flake).
      const date = nextUtcWeekday(0, 5)

      const response = await fetchSlots(date, 30)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message: string }
      expect(data.message).toContain('day of the week')
    })

    it('should generate slots within business hours only (in configured timezone)', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]
      const response = await fetchSlots(date, 30)

      expect(response.status).toBe(200)
      const data = (await response.json()) as SlotsResponse

      // Config in beforeEach is America/New_York 09:00–17:00 — assert slots
      // fall in that range as wall-clock New York time, not UTC.
      const fmtHour = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'America/New_York'
      })
      const fmtMin = new Intl.DateTimeFormat('en-US', {
        minute: 'numeric',
        timeZone: 'America/New_York'
      })

      for (const slot of data.slots) {
        const startHour = parseInt(fmtHour.format(new Date(slot.startTime)))
        const endHour = parseInt(fmtHour.format(new Date(slot.endTime)))
        expect(startHour).toBeGreaterThanOrEqual(9)
        expect(endHour).toBeLessThanOrEqual(17)
        if (endHour === 17) {
          expect(parseInt(fmtMin.format(new Date(slot.endTime)))).toBe(0)
        }
      }
    })
  })

  describe('Full Booking Flow', () => {
    it('should: fetch slots -> book -> verify unavailable', async () => {
      const date = getNextWeekday(3).toISOString().split('T')[0]

      // Step 1: Fetch slots
      const r1 = await fetchSlots(date, 30)
      expect(r1.status).toBe(200)
      const slots1 = (await r1.json()) as SlotsResponse
      expect(slots1.slots.length).toBeGreaterThan(0)

      const selectedSlot = slots1.slots.find(s => s.available)
      expect(selectedSlot).toBeDefined()

      // Step 2: Book the slot
      const bookResponse = await SELF.fetch('https://test.com/contact/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.1',
          Referer: 'https://hadoku.me/contact'
        },
        body: JSON.stringify({
          name: 'Test User',
          email: 'test@example.com',
          message: 'Test booking',
          recipient: 'matthaeus@hadoku.me',
          appointment: {
            slotId: selectedSlot!.id,
            date,
            startTime: selectedSlot!.startTime,
            endTime: selectedSlot!.endTime,
            duration: 30,
            platform: 'discord'
          }
        })
      })
      expect(bookResponse.status).toBe(201)

      // Step 3: Verify slot now unavailable
      const r2 = await fetchSlots(date, 30)
      expect(r2.status).toBe(200)
      const slots2 = (await r2.json()) as SlotsResponse

      const bookedSlot = slots2.slots.find(s => s.id === selectedSlot!.id)
      expect(bookedSlot).toBeDefined()
      expect(bookedSlot!.available).toBe(false)
    })
  })
})
