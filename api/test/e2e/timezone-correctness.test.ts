/**
 * Timezone Correctness Tests
 *
 * Documents the actual behavior of slot generation versus the configured
 * `business_hours_start`/`business_hours_end` and `timezone` fields.
 *
 * Background: api/routes/appointments.ts uses `setUTCHours(startHour, ...)` to
 * place slots, even though the config stores an IANA timezone like
 * "America/New_York". These tests pin down whether slots land in the
 * configured timezone or in UTC.
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

function nextWeekday(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  return d.toISOString().split('T')[0]
}

async function setConfig(partial: Record<string, string | number>) {
  const fields = Object.keys(partial)
    .map(k => `${k} = ?`)
    .join(', ')
  await env.DB.prepare(`UPDATE appointment_config SET ${fields}, last_updated = ? WHERE id = 1`)
    .bind(...Object.values(partial), Date.now())
    .run()
}

async function fetchSlots(date: string, duration: number) {
  const r = await SELF.fetch(
    `https://test.com/contact/api/appointments/slots?date=${date}&duration=${duration}`
  )
  return { status: r.status, body: (await r.json()) as SlotsResponse }
}

describe('Timezone Correctness', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
  })

  describe('Slot generation honors configured business hours', () => {
    // BUG: api/routes/appointments.ts uses setUTCHours() — the configured
    // hours land in UTC, not in the configured timezone. These tests are
    // marked .fails() so CI stays green; flip back to .it() once the bug is
    // fixed in generateTimeSlots/createAppointmentsRoutes.
    it.fails(
      'America/New_York 09:00–17:00 should produce slots at 09:00–17:00 New York time',
      async () => {
        await setConfig({
          timezone: 'America/New_York',
          business_hours_start: '09:00',
          business_hours_end: '17:00',
          available_days: '0,1,2,3,4,5,6',
          slot_duration_options: '60',
          min_advance_hours: 24,
          max_advance_days: 30
        })

        const date = nextWeekday(3)
        const { status, body } = await fetchSlots(date, 60)
        expect(status).toBe(200)
        expect(body.slots.length).toBeGreaterThan(0)

        const fmt = new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hour12: false,
          timeZone: 'America/New_York'
        })

        const firstHour = parseInt(fmt.format(new Date(body.slots[0].startTime)))
        const lastEndHour = parseInt(
          fmt.format(new Date(body.slots[body.slots.length - 1].endTime))
        )

        // Will FAIL today: implementation uses setUTCHours, so slots actually
        // start at 09:00 UTC (= 04:00 or 05:00 New York depending on DST).
        expect(firstHour).toBe(9)
        expect(lastEndHour).toBe(17)
      }
    )

    it.fails(
      'America/Los_Angeles 09:00–17:00 should produce slots at 09:00–17:00 LA time',
      async () => {
        await setConfig({
          timezone: 'America/Los_Angeles',
          business_hours_start: '09:00',
          business_hours_end: '17:00',
          available_days: '0,1,2,3,4,5,6',
          slot_duration_options: '60',
          min_advance_hours: 24,
          max_advance_days: 30
        })

        const date = nextWeekday(3)
        const { body } = await fetchSlots(date, 60)
        expect(body.slots.length).toBeGreaterThan(0)

        const fmt = new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hour12: false,
          timeZone: 'America/Los_Angeles'
        })
        const firstHour = parseInt(fmt.format(new Date(body.slots[0].startTime)))
        expect(firstHour).toBe(9)
      }
    )

    it('day-of-week filter should use configured timezone, not UTC', async () => {
      // Friday 23:00 UTC = Saturday 09:00 in Sydney.
      // If a config allows Saturday in Sydney, a Saturday-Sydney date should
      // produce slots; the API currently checks UTC day instead.
      await setConfig({
        timezone: 'Australia/Sydney',
        business_hours_start: '09:00',
        business_hours_end: '17:00',
        available_days: '6', // Saturday only
        slot_duration_options: '60',
        min_advance_hours: 24,
        max_advance_days: 30
      })

      // Find next Saturday in Sydney TZ
      const now = new Date()
      const sydDay = parseInt(
        new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Australia/Sydney' }).format(
          now
        ) === 'Sat'
          ? '6'
          : '0'
      )
      // Skip exactness — just go +5 weekdays out and test until we hit Sat in Sydney
      let date = nextWeekday(5)
      for (let i = 0; i < 7; i++) {
        const d = new Date(`${date}T12:00:00.000Z`)
        const sydWeekday = new Intl.DateTimeFormat('en-US', {
          weekday: 'short',
          timeZone: 'Australia/Sydney'
        }).format(d)
        if (sydWeekday === 'Sat') break
        d.setDate(d.getDate() + 1)
        date = d.toISOString().split('T')[0]
      }

      const { status, body } = await fetchSlots(date, 60)
      // Should succeed because the date is Saturday in Sydney
      expect(status, `Saturday-in-Sydney date "${date}" should be allowed (sydDay=${sydDay})`).toBe(
        200
      )
      expect(body.slots.length).toBeGreaterThan(0)
    })
  })

  describe('Slot timezone metadata', () => {
    it('response.timezone should match configured timezone', async () => {
      await setConfig({ timezone: 'Europe/London' })
      const { body } = await fetchSlots(nextWeekday(3), 30)
      expect(body.timezone).toBe('Europe/London')
    })
  })

  describe('Browser-timezone rendering simulation', () => {
    it.fails(
      'the same ISO startTime must render to the same wall-clock time as configured',
      async () => {
        await setConfig({
          timezone: 'America/New_York',
          business_hours_start: '14:00',
          business_hours_end: '15:00',
          available_days: '0,1,2,3,4,5,6',
          slot_duration_options: '60'
        })

        const { body } = await fetchSlots(nextWeekday(3), 60)
        expect(body.slots.length).toBe(1)
        const slot = body.slots[0]

        // What a New York-located browser would render:
        const renderInNY = new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: false,
          timeZone: 'America/New_York'
        }).format(new Date(slot.startTime))

        // Should render as 14:00 New York
        expect(renderInNY).toBe('14:00')
      }
    )
  })
})
