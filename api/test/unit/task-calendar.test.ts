/**
 * Unit tests for the task-calendar bridge.
 *
 * Covers the deterministic body mapping plus the push outcomes: skipped (no
 * key), success, and a non-2xx response — all of which must resolve (never
 * throw) so a calendar failure can't fail the booking. The delete path carries
 * the same discipline, plus idempotency: a 404 is a no-op success.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildTaskFromAppointment,
  buildTaskFromMail,
  pushAppointmentToCalendar,
  removeAppointmentFromCalendar,
  removeMailFromCalendar,
  __resetCalendarBoardCache
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

  it('skips (no fetch) when CONTACTUI_SERVICE_KEY is unset', async () => {
    const result = await pushAppointmentToCalendar(SAMPLE, {})
    expect(result).toEqual({ ok: false, skipped: true })
  })

  it('discovers the shared board from GET /boards, ignoring our own boards', async () => {
    __resetCalendarBoardCache()
    let sentBoard: string | undefined
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api/boards', method: 'GET' })
      .reply(200, {
        boards: [
          // Our own board, also called "main" — selecting by display name would
          // pick this and mirror into an empty board of ours.
          { id: 'main', name: 'main', access: 'owner' },
          { id: 'HANDLE-SHARED-WITH-US', name: 'main', access: 'contributor' }
        ]
      })
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api', method: 'POST' })
      .reply(200, (opts: { body: string }) => {
        sentBoard = (JSON.parse(opts.body) as { boardId: string }).boardId
        return { ok: true, id: 'contact-appt-123', version: 1 }
      })

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })
    expect(result.ok).toBe(true)
    expect(sentBoard).toBe('HANDLE-SHARED-WITH-US')
  })

  it('skips when no board is shared with us', async () => {
    __resetCalendarBoardCache()
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api/boards', method: 'GET' })
      .reply(200, { boards: [{ id: 'main', name: 'main', access: 'owner' }] })

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })
    expect(result).toEqual({ ok: false, skipped: true })
  })

  it('refuses (never guesses) when several boards are shared with us', async () => {
    __resetCalendarBoardCache()
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api/boards', method: 'GET' })
      .reply(200, {
        boards: [
          { id: 'HANDLE-A', access: 'contributor' },
          { id: 'HANDLE-B', access: 'contributor' }
        ]
      })

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })
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
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_CALENDAR_BOARD: 'MRY93H8LG7ZCSK998165RCUBHW',
      TASK_API_URL: 'https://task.test/api'
    })

    expect(result.ok).toBe(true)
    expect(result.taskId).toBe('contact-appt-123')
    // We authenticate as OURSELVES, not as the calendar owner.
    expect(sentKey).toBe('contactui-key-uuid')
    expect((sentBody as { id: string }).id).toBe('contact-appt-123')
    // ...and address the owner's board by handle, which is what routes the
    // write out of our namespace and into theirs via the share grant.
    expect((sentBody as { boardId: string }).boardId).toBe('MRY93H8LG7ZCSK998165RCUBHW')
  })

  it('resolves with ok:false on a non-2xx response (never throws)', async () => {
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api', method: 'POST' })
      .reply(403, 'forbidden')

    const result = await pushAppointmentToCalendar(SAMPLE, {
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_CALENDAR_BOARD: 'MRY93H8LG7ZCSK998165RCUBHW',
      TASK_API_URL: 'https://task.test/api'
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })
})

describe('removing a mirrored event', () => {
  const ENV = {
    CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
    TASK_CALENDAR_BOARD: 'MRY93H8LG7ZCSK998165RCUBHW',
    TASK_API_URL: 'https://task.test/api'
  }

  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('skips (no fetch) when CONTACTUI_SERVICE_KEY is unset', async () => {
    const result = await removeAppointmentFromCalendar('appt-123', {})
    expect(result).toEqual({ ok: false, skipped: true })
  })

  it('DELETEs the deterministic task id with the board as a QUERY param', async () => {
    let sentKey: string | undefined
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api/contact-appt-123',
        query: { boardId: 'MRY93H8LG7ZCSK998165RCUBHW' },
        method: 'DELETE'
      })
      .reply(200, (opts: { headers: Record<string, string> }) => {
        sentKey = opts.headers['x-user-key']
        return { ok: true, message: 'Task contact-appt-123 deleted' }
      })

    // Same id the create path built for this appointment.
    expect(buildTaskFromAppointment(SAMPLE).id).toBe('contact-appt-123')

    const result = await removeAppointmentFromCalendar(SAMPLE.id, ENV)
    expect(result.ok).toBe(true)
    expect(result.taskId).toBe('contact-appt-123')
    // We authenticate as OURSELVES here too — the contributor grant covers delete.
    expect(sentKey).toBe('contactui-key-uuid')
  })

  it('treats an already-absent task (404) as a no-op success', async () => {
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api/admin-mail-sub-789',
        query: { boardId: 'MRY93H8LG7ZCSK998165RCUBHW' },
        method: 'DELETE'
      })
      .reply(404, { error: 'Task admin-mail-sub-789 not found', code: 'TASK_NOT_FOUND' })

    const result = await removeMailFromCalendar(SAMPLE_MAIL.id, ENV)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(404)
  })

  it('does NOT swallow a BOARD_NOT_FOUND 404 — a revoked share must surface', async () => {
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api/contact-appt-123',
        query: { boardId: 'MRY93H8LG7ZCSK998165RCUBHW' },
        method: 'DELETE'
      })
      .reply(404, { error: 'Board ... not found', code: 'BOARD_NOT_FOUND' })

    const result = await removeAppointmentFromCalendar(SAMPLE.id, ENV)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('resolves with ok:false on a non-2xx response (never throws)', async () => {
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api/contact-appt-123',
        query: { boardId: 'MRY93H8LG7ZCSK998165RCUBHW' },
        method: 'DELETE'
      })
      .reply(403, 'forbidden')

    const result = await removeAppointmentFromCalendar(SAMPLE.id, ENV)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('addresses the SAME discovered board the create path uses', async () => {
    __resetCalendarBoardCache()
    fetchMock
      .get('https://task.test')
      .intercept({ path: '/api/boards', method: 'GET' })
      .reply(200, {
        boards: [
          { id: 'main', name: 'main', access: 'owner' },
          { id: 'HANDLE-SHARED-WITH-US', name: 'main', access: 'contributor' }
        ]
      })
    fetchMock
      .get('https://task.test')
      .intercept({
        path: '/api/contact-appt-123',
        query: { boardId: 'HANDLE-SHARED-WITH-US' },
        method: 'DELETE'
      })
      .reply(200, { ok: true, message: 'deleted' })

    const result = await removeAppointmentFromCalendar(SAMPLE.id, {
      CONTACTUI_SERVICE_KEY: 'contactui-key-uuid',
      TASK_API_URL: 'https://task.test/api'
    })
    expect(result.ok).toBe(true)
    __resetCalendarBoardCache()
  })
})
