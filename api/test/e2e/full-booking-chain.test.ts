/**
 * Full booking chain e2e test
 *
 * Submits to POST /contact/api/submit with platform=google and verifies the
 * COMPLETE chain executes end-to-end:
 *
 *   1. /submit accepts the request
 *   2. createSubmission writes a row to contact_submissions in D1
 *   3. Google OAuth token exchange (mocked)
 *   4. Google Calendar API event creation (mocked) → returns a Meet URL
 *   5. Resend email API (mocked) → confirmation email
 *   6. createAppointment writes a row to appointments with the Meet URL
 *   7. 201 response with meetingLink in body
 *
 * If any layer is silently broken in the future, this test catches it.
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

interface CapturedRequest {
  url: string
  method: string
  body?: string
  headers?: Record<string, string>
}

function nextUtcWeekday(targetDay: number, minDaysOut = 5): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + minDaysOut)
  const cur = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + ((targetDay - cur + 7) % 7))
  return d.toISOString().split('T')[0]
}

describe('Full booking chain (Google Meet + email)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM appointments').run()
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    const keys = await env.RATE_LIMIT_KV.list()
    for (const key of keys.keys) await env.RATE_LIMIT_KV.delete(key.name)

    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('books → mints Meet link → sends email → stores everything in D1', async () => {
    const date = nextUtcWeekday(2, 5) // next Tuesday at least 5 days out (weekday)
    const startTime = `${date}T18:00:00.000Z` // 18:00 UTC = 14:00 EDT (within NY business hours 9–17)
    const endTime = `${date}T18:30:00.000Z`
    const slotId = `slot-${date}-${startTime}`

    // ---- Mock layer 1: Google OAuth token exchange ----
    const oauthCalls: CapturedRequest[] = []
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(({ path, method, body }) => {
        oauthCalls.push({
          url: `https://oauth2.googleapis.com${path}`,
          method,
          body: typeof body === 'string' ? body : undefined
        })
        return {
          statusCode: 200,
          data: { access_token: 'mocked-access-token-xyz', expires_in: 3600 }
        }
      })

    // ---- Mock layer 2: Google Calendar API event creation ----
    const calendarCalls: CapturedRequest[] = []
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({
        path: (p: string) => p.startsWith('/calendar/v3/calendars/primary/events'),
        method: 'POST'
      })
      .reply(({ path, method, body }) => {
        calendarCalls.push({
          url: `https://www.googleapis.com${path}`,
          method,
          body: typeof body === 'string' ? body : undefined
        })
        return {
          statusCode: 200,
          data: {
            id: 'evt-real-id-12345',
            conferenceData: {
              conferenceId: 'meet-conf-id-789',
              entryPoints: [
                { entryPointType: 'video', uri: 'https://meet.google.com/zxc-vbnm-asd' },
                { entryPointType: 'phone', uri: 'tel:+1555' }
              ]
            }
          }
        }
      })

    // ---- Mock layer 3: Resend email API ----
    const resendCalls: CapturedRequest[] = []
    fetchMock
      .get('https://api.resend.com')
      .intercept({ path: '/emails', method: 'POST' })
      .reply(({ path, method, body }) => {
        resendCalls.push({
          url: `https://api.resend.com${path}`,
          method,
          body: typeof body === 'string' ? body : undefined
        })
        return {
          statusCode: 200,
          data: { id: 'resend-msg-id-456' }
        }
      })

    // ---- Trigger the booking ----
    const response = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.42',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Alice Tester',
        email: 'alice@example.com',
        message: 'Looking forward to the chat — wanted to discuss the project.',
        recipient: 'matthaeus@hadoku.me',
        appointment: {
          slotId,
          date,
          startTime,
          endTime,
          duration: 30,
          platform: 'google'
        }
      })
    })

    // ---- Verify the response ----
    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.meetingLink).toBe('https://meet.google.com/zxc-vbnm-asd')

    // ---- Verify each upstream was called exactly once ----
    expect(oauthCalls).toHaveLength(1)
    expect(calendarCalls).toHaveLength(1)
    expect(resendCalls).toHaveLength(1)

    // ---- OAuth call: form-encoded refresh_token grant ----
    expect(oauthCalls[0].body).toContain('grant_type=refresh_token')
    expect(oauthCalls[0].body).toContain('refresh_token=test-refresh-token')
    expect(oauthCalls[0].body).toContain('client_id=test-client-id')

    // ---- Calendar call: hangoutsMeet conferenceData with attendee + slot ----
    expect(calendarCalls[0].url).toContain('conferenceDataVersion=1')
    const calBody = JSON.parse(calendarCalls[0].body!) as {
      summary: string
      start: { dateTime: string }
      end: { dateTime: string }
      attendees: { email: string }[]
      conferenceData: {
        createRequest: {
          requestId: string
          conferenceSolutionKey: { type: string }
        }
      }
    }
    expect(calBody.summary).toContain('Alice Tester')
    expect(calBody.start.dateTime).toBe(startTime)
    expect(calBody.end.dateTime).toBe(endTime)
    expect(calBody.attendees[0].email).toBe('alice@example.com')
    expect(calBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
    expect(calBody.conferenceData.createRequest.requestId).toBe(slotId)

    // ---- Resend call: confirmation email to the user with the Meet link ----
    const resendBody = JSON.parse(resendCalls[0].body!) as {
      from: string
      to: string | string[]
      subject: string
      text: string
    }
    const toAddrs = Array.isArray(resendBody.to) ? resendBody.to : [resendBody.to]
    expect(toAddrs).toContain('alice@example.com')
    expect(resendBody.from).toContain('matthaeus@hadoku.me')
    expect(resendBody.subject).toMatch(/[Aa]ppointment/)
    expect(resendBody.text).toContain('https://meet.google.com/zxc-vbnm-asd')

    // ---- D1: submission row + appointment row + auto-whitelisted email ----
    const submissions = await env.DB.prepare('SELECT * FROM contact_submissions').all<{
      name: string
      email: string
      message: string
    }>()
    expect(submissions.results).toHaveLength(1)
    expect(submissions.results[0].name).toBe('Alice Tester')
    expect(submissions.results[0].email).toBe('alice@example.com')

    const appointments = await env.DB.prepare('SELECT * FROM appointments').all<{
      name: string
      email: string
      platform: string
      meeting_link: string
      meeting_id: string
      slot_id: string
      duration: number
    }>()
    expect(appointments.results).toHaveLength(1)
    const apt = appointments.results[0]
    expect(apt.name).toBe('Alice Tester')
    expect(apt.email).toBe('alice@example.com')
    expect(apt.platform).toBe('google')
    expect(apt.meeting_link).toBe('https://meet.google.com/zxc-vbnm-asd')
    expect(apt.meeting_id).toBe('meet-conf-id-789')
    expect(apt.slot_id).toBe(slotId)
    expect(apt.duration).toBe(30)

    const whitelist = await env.DB.prepare('SELECT * FROM email_whitelist').all<{
      email: string
    }>()
    expect(whitelist.results.some(w => w.email === 'alice@example.com')).toBe(true)

    // ---- All interceptors consumed ----
    fetchMock.assertNoPendingInterceptors()
  })

  it('books with platform=jitsi → no Calendar API call, but email still sent', async () => {
    const date = nextUtcWeekday(3, 5) // next Wednesday
    const startTime = `${date}T18:00:00.000Z`
    const endTime = `${date}T18:30:00.000Z`
    const slotId = `slot-${date}-${startTime}`

    const resendCalls: CapturedRequest[] = []
    fetchMock
      .get('https://api.resend.com')
      .intercept({ path: '/emails', method: 'POST' })
      .reply(({ path, method, body }) => {
        resendCalls.push({
          url: `https://api.resend.com${path}`,
          method,
          body: typeof body === 'string' ? body : undefined
        })
        return { statusCode: 200, data: { id: 'resend-jitsi-id' } }
      })

    const response = await SELF.fetch('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.43',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Bob Jitsi',
        email: 'bob@example.com',
        message: 'Quick chat please',
        recipient: 'matthaeus@hadoku.me',
        appointment: { slotId, date, startTime, endTime, duration: 30, platform: 'jitsi' }
      })
    })

    expect(response.status).toBe(201)

    const apt = await env.DB.prepare('SELECT * FROM appointments WHERE email = ?')
      .bind('bob@example.com')
      .first<{ meeting_link: string; platform: string }>()
    expect(apt!.platform).toBe('jitsi')
    expect(apt!.meeting_link).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-/)

    expect(resendCalls).toHaveLength(1)
    const resendBody = JSON.parse(resendCalls[0].body!) as { text: string }
    expect(resendBody.text).toContain('meet.jit.si')

    fetchMock.assertNoPendingInterceptors()
  })
})
