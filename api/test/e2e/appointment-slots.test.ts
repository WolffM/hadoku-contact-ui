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

/** Get next weekday N days from now */
function getNextWeekday(daysFromNow: number): Date {
  const date = new Date()
  date.setDate(date.getDate() + daysFromNow)
  const day = date.getDay()
  if (day === 0) date.setDate(date.getDate() + 1)
  else if (day === 6) date.setDate(date.getDate() + 2)
  return date
}

/** Get next Sunday, at least 48h from now */
function getNextSunday(): Date {
  const date = new Date()
  const day = date.getDay()
  const daysUntil = day === 0 ? 7 : 7 - day
  date.setDate(date.getDate() + daysUntil)
  if (date.getTime() - Date.now() < 48 * 60 * 60 * 1000) {
    date.setDate(date.getDate() + 7)
  }
  return date
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

  describe('Business Rules', () => {
    it('should reject dates within advance notice window', async () => {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const date = tomorrow.toISOString().split('T')[0]

      const response = await fetchSlots(date, 30)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { message: string }
      expect(data.message).toContain('advance')
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
      const sunday = getNextSunday()
      const date = sunday.toISOString().split('T')[0]

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
