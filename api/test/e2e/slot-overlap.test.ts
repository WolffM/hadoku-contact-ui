/**
 * A booking blocks every slot it OVERLAPS, not just the one sharing its start.
 *
 * `slot_id` is `slot-<date>-<startISO>` and carries no duration, so a
 * 15-minute booking at 21:45 and a 60-minute slot at 21:00 have entirely
 * different ids. Availability matched on that id, so a confirmed 15-minute
 * meeting left BOTH the 30- and 60-minute slots straddling it on offer — and
 * the submit path used the same comparison, so it accepted the overlapping
 * booking too. Verified read-only against production on 2026-09-15: a live
 * 21:45-22:00 booking showed 21:30-22:00 and 21:00-22:00 as `available: true`.
 *
 * Times are taken FROM the returned grid rather than hardcoded, so the tests
 * do not encode business hours, the timezone, or the advance window — a
 * hardcoded date drifts past `max_advance_days` and turns every request into a
 * 400, which reads as an empty slot list and passes any assertion that only
 * loops over what came back.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

interface Slot {
  id: string
  startTime: string
  endTime: string
  available: boolean
}

const MINUTE = 60 * 1000

/** A weekday comfortably inside both the notice window and the far bound. */
function testDate(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + 7)
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
  else if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2)
  return d.toISOString().split('T')[0]
}

const DATE = testDate()

async function slots(duration: number): Promise<Slot[]> {
  const res = await SELF.fetch(
    `https://test.com/contact/api/appointments/slots?date=${DATE}&duration=${duration}`
  )
  expect(res.status, `slots?duration=${duration} must be offerable on ${DATE}`).toBe(200)
  const body = await res.json<{ slots: Slot[] }>()
  return body.slots
}

/** The slot of `duration` starting exactly at `startIso`, or a clear failure. */
function slotAt(list: Slot[], startIso: string): Slot {
  const found = list.find(s => s.startTime === startIso)
  expect(found, `expected a slot starting ${startIso}`).toBeDefined()
  return found as Slot
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

async function seedBooking(id: string, startMs: number, endMs: number) {
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, submission_id, name, email, message, slot_id, date, start_time, end_time,
        duration, timezone, platform, meeting_link, meeting_id, status, created_at, updated_at)
     VALUES (?, NULL, 'Seed', 'seed@example.com', NULL, ?, ?, ?, ?, ?,
             'America/New_York', 'jitsi', NULL, NULL, 'confirmed', ?, ?)`
  )
    .bind(
      id,
      `slot-${DATE}-${iso(startMs)}`,
      DATE,
      iso(startMs),
      iso(endMs),
      (endMs - startMs) / MINUTE,
      Date.now(),
      Date.now()
    )
    .run()
}

describe('a booking blocks every slot it overlaps', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
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

  // The exact production case: the short booking sits in the TAIL of the hour,
  // so it shares a start with neither the 30- nor the 60-minute slot over it.
  it('a 15-minute booking hides the 30- and 60-minute slots straddling it', async () => {
    const hour = (await slots(60))[0]
    const hourStart = Date.parse(hour.startTime)
    const bookingStart = hourStart + 45 * MINUTE

    await seedBooking('ov-1', bookingStart, bookingStart + 15 * MINUTE)

    expect(slotAt(await slots(60), iso(hourStart)).available).toBe(false)
    expect(slotAt(await slots(30), iso(hourStart + 30 * MINUTE)).available).toBe(false)
    expect(slotAt(await slots(15), iso(bookingStart)).available).toBe(false)
  })

  // The reverse direction: a long booking must hide the short slots inside it.
  it('a 60-minute booking hides every 15-minute slot inside it', async () => {
    const hour = (await slots(60))[0]
    const hourStart = Date.parse(hour.startTime)

    await seedBooking('ov-2', hourStart, hourStart + 60 * MINUTE)

    const quarters = await slots(15)
    for (const offset of [0, 15, 30, 45]) {
      const slot = slotAt(quarters, iso(hourStart + offset * MINUTE))
      expect(slot.available, `15min slot at +${offset}min sits inside a 60min booking`).toBe(false)
    }
  })

  // Half-open comparison: back-to-back meetings are not a conflict.
  it('leaves the abutting slots free', async () => {
    const quarters = await slots(15)
    // Not the first slot — this needs a neighbour on both sides.
    const target = quarters[1]
    const startMs = Date.parse(target.startTime)

    await seedBooking('ov-3', startMs, startMs + 15 * MINUTE)

    const after = await slots(15)
    expect(slotAt(after, iso(startMs)).available).toBe(false)
    expect(slotAt(after, iso(startMs - 15 * MINUTE)).available).toBe(true)
    expect(slotAt(after, iso(startMs + 15 * MINUTE)).available).toBe(true)
  })

  it('refuses a submit that overlaps a confirmed booking', async () => {
    const hour = (await slots(60))[0]
    const hourStart = Date.parse(hour.startTime)

    await seedBooking('ov-4', hourStart, hourStart + 60 * MINUTE)

    // A different slot id from the seed, but squarely inside its hour.
    const attemptStart = hourStart + 30 * MINUTE
    const res = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.77',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Overlapper',
        email: 'overlap@example.com',
        message: 'Trying to book over an existing meeting',
        recipient: 'matthaeus@hadoku.me',
        appointment: {
          slotId: `slot-${DATE}-${iso(attemptStart)}`,
          date: DATE,
          startTime: iso(attemptStart),
          endTime: iso(attemptStart + 15 * MINUTE),
          duration: 15,
          platform: 'jitsi'
        }
      })
    })

    expect(res.status).toBe(409)

    const rows = await env.DB.prepare(
      "SELECT id FROM appointments WHERE email = 'overlap@example.com'"
    ).all()
    expect(rows.results).toHaveLength(0)
  })

  it('still accepts a booking that only abuts an existing one', async () => {
    const quarters = await slots(15)
    const seedStart = Date.parse(quarters[0].startTime)
    const attemptStart = seedStart + 15 * MINUTE

    await seedBooking('ov-5', seedStart, attemptStart)

    const res = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.78',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Neighbour',
        email: 'neighbour@example.com',
        message: 'Booking the slot immediately after',
        recipient: 'matthaeus@hadoku.me',
        appointment: {
          slotId: `slot-${DATE}-${iso(attemptStart)}`,
          date: DATE,
          startTime: iso(attemptStart),
          endTime: iso(attemptStart + 15 * MINUTE),
          duration: 15,
          platform: 'jitsi'
        }
      })
    })

    expect(res.status).toBe(201)
  })
})
