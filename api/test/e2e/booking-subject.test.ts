/**
 * A contact-form message that booked a meeting reaches the Inbox with a
 * subject. There is no subject column: the Inbox parses `Subject: X\n\n<body>`,
 * the envelope inbound mail is stored in, so that is what the row is given.
 */
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { bookingSubject } from '../../email/templates'

function futureDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

async function submit(email: string, message: string, appointment?: { hour: number }) {
  const date = futureDate(4)
  const start = appointment
    ? new Date(`${date}T${String(appointment.hour).padStart(2, '0')}:00:00.000Z`)
    : null
  const response = await SELF.fetch('https://test.com/contact/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.77',
      Referer: 'https://hadoku.me/contact'
    },
    body: JSON.stringify({
      name: 'Ruben',
      email,
      message,
      recipient: 'matthaeus@hadoku.me',
      ...(start && {
        appointment: {
          slotId: `slot-${date}-${start.toISOString()}`,
          date,
          startTime: start.toISOString(),
          endTime: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
          duration: 30,
          platform: 'jitsi'
        }
      })
    })
  })
  return { response, start }
}

async function storedMessage(email: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT message FROM contact_submissions WHERE email = ? ORDER BY created_at'
  )
    .bind(email)
    .all<{ message: string }>()
  return rows.results.map(r => r.message)
}

async function operatorZone(): Promise<string> {
  const row = await env.DB.prepare('SELECT timezone FROM appointment_config WHERE id = 1').first<{
    timezone: string
  }>()
  return row!.timezone
}

describe('booked mail carries a subject', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('UPDATE appointment_config SET weekly_hours = ? WHERE id = 1')
      .bind('1'.repeat(168))
      .run()
    const keys = await env.RATE_LIMIT_KV.list()
    for (const key of keys.keys) await env.RATE_LIMIT_KV.delete(key.name)
  })

  it('gives a booking "Meeting: <title> · <date>, <start>" over the original message', async () => {
    const { response, start } = await submit('ruben@example.com', 'Recruiting', { hour: 16 })
    expect(response.status).toBe(201)

    const subject = bookingSubject('Recruiting', start!.toISOString(), await operatorZone())
    expect(await storedMessage('ruben@example.com')).toEqual([`Subject: ${subject}\n\nRecruiting`])

    // The appointment keeps the guest's words as they wrote them.
    const apt = await env.DB.prepare('SELECT message FROM appointments').first<{
      message: string
    }>()
    expect(apt!.message).toBe('Recruiting')
  })

  it('leaves mail that booked nothing without one', async () => {
    const { response } = await submit('plain@example.com', 'Just saying hi')
    expect(response.status).toBe(201)

    expect(await storedMessage('plain@example.com')).toEqual(['Just saying hi'])
  })

  // The row is written before the booking is validated; a refused booking must
  // not leave mail promising a meeting.
  it('does not promise a meeting whose booking was refused', async () => {
    expect((await submit('first@example.com', 'Recruiting', { hour: 17 })).response.status).toBe(
      201
    )
    const second = await submit('second@example.com', 'Recruiting', { hour: 17 })
    expect(second.response.status).toBe(409)

    expect(await storedMessage('second@example.com')).toEqual(['Recruiting'])
  })
})
