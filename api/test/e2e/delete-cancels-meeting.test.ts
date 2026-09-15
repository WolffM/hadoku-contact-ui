/**
 * Deleting a submission tears down the meeting it booked.
 *
 * The command station's delete button calls `DELETE /admin/submissions/:id`.
 * It used to soft-delete the message and stop, leaving three things running
 * behind a row the operator had told the system to get rid of: the appointment
 * stayed `confirmed` so its slot stayed blocked, the mirrored calendar event
 * stayed, and a Discord booking's private space kept a live invite until the
 * 8-day sweep happened to reach it.
 *
 * The slot is the part that is asserted hardest. A blocked slot behind a
 * deleted message is invisible — nothing in the Inbox shows it, and the only
 * symptom is a time the public booking page quietly refuses to offer.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

const SUB_ID = 'sub-with-booking'
const APPT_ID = 'appt-for-deletion'

/**
 * A weekday inside the booking window, and a slot taken FROM the live grid.
 *
 * A hardcoded date drifts past `max_advance_days` as the calendar moves, and
 * the slots endpoint then answers 400 for the whole day — which arrives as an
 * empty list and quietly satisfies any assertion that only loops over what came
 * back. The "frees the slot" test below is exactly that shape, so the time it
 * asserts on has to be one the endpoint actually offers.
 */
function testDate(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + 7)
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
  else if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2)
  return d.toISOString().split('T')[0]
}

const DATE = testDate()

interface Slot {
  startTime: string
  endTime: string
  available: boolean
}

async function fetchSlots(): Promise<Slot[]> {
  const res = await SELF.fetch(
    `https://test.com/contact/api/appointments/slots?date=${DATE}&duration=15`
  )
  expect(res.status, `${DATE} must be offerable`).toBe(200)
  return (await res.json<{ slots: Slot[] }>()).slots
}

/** Body shape: adminOk nests the handler's payload under `data`. */
async function adminBody<T>(res: Response): Promise<T> {
  const envelope = await res.json<{ success: boolean; data: T }>()
  expect(envelope.success).toBe(true)
  return envelope.data
}

async function seedSubmission(id: string) {
  await env.DB.prepare(
    `INSERT INTO contact_submissions
       (id, name, email, message, recipient, status, created_at)
     VALUES (?, 'Booker', 'booker@example.com', 'see you then',
             'matthaeus@hadoku.me', 'unread', 1788000000000)`
  )
    .bind(id)
    .run()
}

/** Books the day's first offered slot, and returns the time it took. */
async function seedAppointment(opts: {
  meetingId: string | null
  platform: string
}): Promise<string> {
  const [slot] = await fetchSlots()
  expect(slot, `${DATE} must have at least one slot`).toBeDefined()

  await env.DB.prepare(
    `INSERT INTO appointments
       (id, submission_id, name, email, message, slot_id, date, start_time, end_time,
        duration, timezone, platform, meeting_link, meeting_id, status, created_at, updated_at)
     VALUES (?, ?, 'Booker', 'booker@example.com', NULL, ?, ?, ?, ?, 15,
             'America/Los_Angeles', ?, 'https://example.test/join', ?, 'confirmed',
             1788000000000, 1788000000000)`
  )
    .bind(
      APPT_ID,
      SUB_ID,
      `slot-${DATE}-${slot.startTime}`,
      DATE,
      slot.startTime,
      slot.endTime,
      opts.platform,
      opts.meetingId
    )
    .run()

  return slot.startTime
}

async function statusOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT status FROM appointments WHERE id = ?')
    .bind(id)
    .first<{ status: string }>()
  return row?.status ?? null
}

function deleteSubmission(id: string) {
  return SELF.fetch(`https://test.com/contact/api/admin/submissions/${id}`, {
    method: 'DELETE',
    headers: ADMIN_HEADERS
  })
}

describe('DELETE /admin/submissions/:id', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
  })

  it('cancels the appointment the submission booked', async () => {
    await seedSubmission(SUB_ID)
    await seedAppointment({ platform: 'jitsi', meetingId: 'jitsi-room' })

    const res = await deleteSubmission(SUB_ID)
    expect(res.status).toBe(200)

    const body = await adminBody<{ cancelledAppointment?: string | null }>(res)
    expect(body.cancelledAppointment).toBe(APPT_ID)
    expect(await statusOf(APPT_ID)).toBe('cancelled')
  })

  // The symptom an operator would actually hit: they cleared the meeting off
  // their calendar and the time never came back.
  it('frees the slot, so the time is bookable again', async () => {
    await seedSubmission(SUB_ID)
    const booked = await seedAppointment({ platform: 'jitsi', meetingId: 'jitsi-room' })

    const before = (await fetchSlots()).find(s => s.startTime === booked)
    expect(before?.available).toBe(false)

    await deleteSubmission(SUB_ID)

    const after = (await fetchSlots()).find(s => s.startTime === booked)
    expect(after?.available).toBe(true)
  })

  it('still trashes the message itself', async () => {
    await seedSubmission(SUB_ID)
    await seedAppointment({ platform: 'jitsi', meetingId: 'jitsi-room' })

    await deleteSubmission(SUB_ID)

    const row = await env.DB.prepare('SELECT status FROM contact_submissions WHERE id = ?')
      .bind(SUB_ID)
      .first<{ status: string }>()
    expect(row?.status).toBe('deleted')
  })

  // Most mail books nothing. The delete must not become conditional on a
  // lookup that finds nothing.
  it('is unchanged for a submission that booked nothing', async () => {
    await seedSubmission('plain-mail')

    const res = await deleteSubmission('plain-mail')
    expect(res.status).toBe(200)

    const body = await adminBody<{ success: boolean; cancelledAppointment?: string | null }>(res)
    expect(body.success).toBe(true)
    expect(body.cancelledAppointment).toBeNull()
  })

  // A second delete must not fire a second revoke at a space already gone.
  it('does not re-cancel an appointment that is already cancelled', async () => {
    await seedSubmission(SUB_ID)
    await seedAppointment({ platform: 'jitsi', meetingId: 'jitsi-room' })

    await deleteSubmission(SUB_ID)
    const second = await deleteSubmission(SUB_ID)

    const body = await adminBody<{ cancelledAppointment?: string | null }>(second)
    expect(body.cancelledAppointment).toBeNull()
    expect(await statusOf(APPT_ID)).toBe('cancelled')
  })

  // Restoring brings back the MAIL, not the meeting. A single-use Discord
  // invite cannot be un-revoked and a torn-down category cannot be rebuilt, so
  // a restored row pointing at a live booking would be a lie.
  it('leaves the meeting cancelled when the message is restored', async () => {
    await seedSubmission(SUB_ID)
    await seedAppointment({ platform: 'jitsi', meetingId: 'jitsi-room' })

    await deleteSubmission(SUB_ID)
    const restored = await SELF.fetch(
      `https://test.com/contact/api/admin/submissions/${SUB_ID}/restore`,
      { method: 'POST', headers: ADMIN_HEADERS }
    )
    expect(restored.status).toBe(200)

    expect(await statusOf(APPT_ID)).toBe('cancelled')
  })

  // The space revoke is an outbound call to ArchiveBot. It is best-effort by
  // design: the row that frees the slot has to land regardless.
  it('still deletes when the Discord space cannot be revoked', async () => {
    await seedSubmission(SUB_ID)
    await seedAppointment({ platform: 'discord', meetingId: 'space-unreachable00' })

    const res = await deleteSubmission(SUB_ID)

    expect(res.status).toBe(200)
    expect(await statusOf(APPT_ID)).toBe('cancelled')
  })
})
