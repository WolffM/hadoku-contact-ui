/**
 * A booking's confirmation email is tracked from the send to its last delivery
 * webhook, so a bounce off a mistyped address shows on the appointment.
 *
 * Before this, the Resend id was discarded and every delivery webhook was
 * acknowledged and dropped: the 2026-11-21 booking's event arrived one second
 * after the booking and left no trace.
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { postSigned } from './webhook-helpers'

function nextUtcWeekday(targetDay: number, minDaysOut = 5): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + minDaysOut)
  d.setUTCDate(d.getUTCDate() + ((targetDay - d.getUTCDay() + 7) % 7))
  return d.toISOString().split('T')[0]
}

interface ConfirmationRow {
  id: string
  confirmation_email_id: string | null
  confirmation_status: string | null
  confirmation_status_at: number | null
}

async function book(resendId: string): Promise<ConfirmationRow> {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: '/emails', method: 'POST' })
    .reply(200, JSON.stringify({ id: resendId }), {
      headers: { 'Content-Type': 'application/json' }
    })

  const date = nextUtcWeekday(3, 5)
  const startTime = `${date}T18:00:00.000Z`
  const endTime = `${date}T18:30:00.000Z`
  const res = await SELF.fetch('https://test.com/contact/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.88',
      Referer: 'https://hadoku.me/contact'
    },
    body: JSON.stringify({
      name: 'Ruben',
      email: 'ruben@forest-ai.org',
      message: 'Recruiting',
      recipient: 'matthaeus@hadoku.me',
      appointment: {
        slotId: `slot-${date}-${startTime}`,
        date,
        startTime,
        endTime,
        duration: 30,
        platform: 'jitsi'
      }
    })
  })
  expect(res.status).toBe(201)
  return readRow()
}

async function readRow(): Promise<ConfirmationRow> {
  const row = await env.DB.prepare(
    `SELECT id, confirmation_email_id, confirmation_status, confirmation_status_at
     FROM appointments`
  ).first<ConfirmationRow>()
  return row!
}

function delivery(type: string, emailId: string) {
  return postSigned(
    JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data: {
        email_id: emailId,
        from: 'matthaeus@hadoku.me',
        to: ['ruben@forest-ai.org'],
        subject: 'Appointment Confirmed'
      }
    })
  )
}

describe('confirmation delivery tracking', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('records the Resend id and `sent` when the send is accepted', async () => {
    const row = await book('re_conf_1')
    expect(row.confirmation_email_id).toBe('re_conf_1')
    expect(row.confirmation_status).toBe('sent')
    expect(row.confirmation_status_at).toEqual(expect.any(Number))
  })

  it('lands a bounce on the appointment', async () => {
    await book('re_conf_2')
    const res = await delivery('email.bounced', 're_conf_2')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { delivery: 'bounced', matched: true } })
    expect((await readRow()).confirmation_status).toBe('bounced')
  })

  it('walks sent → delivered and never back', async () => {
    await book('re_conf_3')
    await delivery('email.delivered', 're_conf_3')
    expect((await readRow()).confirmation_status).toBe('delivered')

    // Webhooks arrive out of order: a late `sent` must not undo `delivered`.
    const late = await delivery('email.sent', 're_conf_3')
    expect(await late.json()).toMatchObject({ data: { delivery: 'sent', matched: true } })
    expect((await readRow()).confirmation_status).toBe('delivered')
  })

  it('keeps a bounce final', async () => {
    await book('re_conf_4')
    await delivery('email.bounced', 're_conf_4')
    await delivery('email.delivered', 're_conf_4')
    expect((await readRow()).confirmation_status).toBe('bounced')
  })

  it('acknowledges a delivery event for mail that is not a confirmation', async () => {
    const res = await delivery('email.delivered', 're_operator_reply')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { delivery: 'delivered', matched: false } })
  })

  it('still ignores event types that are neither mail nor delivery', async () => {
    const res = await delivery('email.opened', 're_conf_5')
    expect(await res.json()).toMatchObject({ data: { ignored: 'email.opened' } })
  })
})
