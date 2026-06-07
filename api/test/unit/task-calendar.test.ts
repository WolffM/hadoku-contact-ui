/**
 * Unit tests for the task-calendar bridge.
 *
 * Covers the deterministic body mapping plus the three push outcomes:
 * skipped (no key), success, and a non-2xx response — all of which must
 * resolve (never throw) so a calendar failure can't fail the booking.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildTaskFromAppointment,
  buildTaskFromMail,
  pushAppointmentToCalendar
} from '../../services/task-calendar'
import type { StoredAppointment } from '../../storage/appointments'
import type { StoredSubmission } from '../../storage/submissions'

const SAMPLE: StoredAppointment = {
  id: 'appt-123',
  submission_id: 'sub-1',
  name: 'John Doe',
  email: 'john@example.com',
  message: 'Looking forward to it',
  slot_id: 'slot-2026-06-15-T14',
  date: '2026-06-15',
  start_time: '2026-06-15T14:00:00.000Z',
  end_time: '2026-06-15T14:30:00.000Z',
  duration: 30,
  timezone: 'America/Los_Angeles',
  platform: 'google',
  meeting_link: 'https://meet.google.com/abc-defg-hij',
  meeting_id: 'abc-defg-hij',
  status: 'confirmed',
  created_at: 1718000000000,
  updated_at: 1718000000000,
  cancelled_at: null,
  ip_address: null,
  user_agent: null,
  confirmation_sent: false,
  reminder_sent: false
}

describe('buildTaskFromAppointment', () => {
  it('maps an appointment to a deterministic CreateTaskInput body', () => {
    const body = buildTaskFromAppointment(SAMPLE)
    expect(body.id).toBe('contact-appt-123')
    expect(body.title).toBe('Meeting: John Doe')
    expect(body.startTime).toBe(SAMPLE.start_time)
    expect(body.endTime).toBe(SAMPLE.end_time)
    expect(body.tag).toBe('contact')
    expect(body.source).toBe('contact')
    expect(body.sourceId).toBe('appt-123')
    expect(body.createdAt).toBe('2024-06-10T06:13:20.000Z')
    expect(body.metadata).toMatchObject({
      scheduledBy: 'john@example.com',
      name: 'John Doe',
      platform: 'google',
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      duration: 30,
      status: 'confirmed'
    })
  })

  it('honours a custom source in both the id and source field', () => {
    const body = buildTaskFromAppointment(SAMPLE, 'meeting-orchestrator')
    expect(body.id).toBe('meeting-orchestrator-appt-123')
    expect(body.source).toBe('meeting-orchestrator')
  })
})

const SAMPLE_MAIL: StoredSubmission = {
  id: 'sub-789',
  name: 'Re: project kickoff',
  email: 'client@example.com',
  message: 'Thanks for reaching out — here are the details.',
  status: 'read',
  created_at: 1718000000000,
  deleted_at: null,
  ip_address: null,
  user_agent: null,
  referrer: null,
  recipient: 'matthaeus@hadoku.me',
  direction: 'outbound'
}

describe('buildTaskFromMail', () => {
  it('maps an outbound mail submission to an all-day CreateTaskInput body', () => {
    const body = buildTaskFromMail(SAMPLE_MAIL, { sentBy: 'admin-key-1' })
    expect(body.id).toBe('admin-mail-sub-789')
    expect(body.title).toBe('Mail: Re: project kickoff')
    // All-day: a `date` and NO start/end times.
    expect(body.date).toBe('2024-06-10')
    expect(body.startTime).toBeUndefined()
    expect(body.endTime).toBeUndefined()
    expect(body.tag).toBe('mail')
    expect(body.source).toBe('admin-mail')
    expect(body.sourceId).toBe('sub-789')
    expect(body.metadata).toMatchObject({
      subject: 'Re: project kickoff',
      to: 'client@example.com',
      from: 'matthaeus@hadoku.me',
      direction: 'outbound',
      sentBy: 'admin-key-1'
    })
  })
})

describe('pushAppointmentToCalendar', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('skips (no fetch) when CONTACT_SYNC_KEY is unset', async () => {
    const result = await pushAppointmentToCalendar(SAMPLE, {})
    expect(result).toEqual({ ok: false, skipped: true })
  })

  it('POSTs the task with X-User-Key and reports success', async () => {
    let sentBody: unknown
    let sentKey: string | undefined
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api',
        method: 'POST'
      })
      .reply(200, (opts: { headers: Record<string, string>; body: string }) => {
        sentKey = opts.headers['x-user-key']
        sentBody = JSON.parse(opts.body)
        return { ok: true, id: 'contact-appt-123', version: 1 }
      })

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACT_SYNC_KEY: 'owner-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })

    expect(result.ok).toBe(true)
    expect(result.taskId).toBe('contact-appt-123')
    expect(sentKey).toBe('owner-key-uuid')
    expect((sentBody as { id: string }).id).toBe('contact-appt-123')
  })

  it('resolves with ok:false on a non-2xx response (never throws)', async () => {
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api', method: 'POST' })
      .reply(403, 'forbidden')

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACT_SYNC_KEY: 'owner-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })
})
