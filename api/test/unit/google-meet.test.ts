/**
 * Unit tests for Google Meet integration via Calendar API.
 *
 * Mocks the OAuth token exchange and Calendar event creation calls.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createGoogleMeetEvent } from '../../services/google-meet'

const FAKE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'test-refresh-token'
}

const SAMPLE_INPUT = {
  slotId: 'slot-2026-06-15-T14',
  name: 'John Doe',
  email: 'john@example.com',
  startTime: '2026-06-15T14:00:00.000Z',
  endTime: '2026-06-15T15:00:00.000Z',
  message: 'Quarterly check-in'
}

describe('createGoogleMeetEvent', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('returns a Meet link when both API calls succeed', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'mocked-access', expires_in: 3600 })

    fetchMock
      .get('https://www.googleapis.com')
      .intercept({
        path: (p: string) => p.startsWith('/calendar/v3/calendars/primary/events'),
        method: 'POST'
      })
      .reply(200, {
        id: 'evt-abc-123',
        conferenceData: {
          conferenceId: 'meet-room-xyz',
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
            { entryPointType: 'phone' }
          ]
        }
      })

    const result = await createGoogleMeetEvent(SAMPLE_INPUT, FAKE_ENV)
    expect(result.success).toBe(true)
    expect(result.meetingLink).toBe('https://meet.google.com/abc-defg-hij')
    expect(result.meetingId).toBe('meet-room-xyz')
  })

  it('returns error when OAuth secrets are missing', async () => {
    const result = await createGoogleMeetEvent(SAMPLE_INPUT, {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('Google OAuth not configured')
  })

  it('returns error when token exchange fails', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(401, 'invalid_grant')

    const result = await createGoogleMeetEvent(SAMPLE_INPUT, FAKE_ENV)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Token exchange failed: 401')
  })

  it('returns error when Calendar API fails', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'mocked-access', expires_in: 3600 })

    fetchMock
      .get('https://www.googleapis.com')
      .intercept({
        path: (p: string) => p.startsWith('/calendar/v3/calendars/primary/events'),
        method: 'POST'
      })
      .reply(403, 'insufficient_permission')

    const result = await createGoogleMeetEvent(SAMPLE_INPUT, FAKE_ENV)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Calendar API error: 403')
  })

  it('returns error when conferenceData is missing video entry point', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'mocked-access', expires_in: 3600 })

    fetchMock
      .get('https://www.googleapis.com')
      .intercept({
        path: (p: string) => p.startsWith('/calendar/v3/calendars/primary/events'),
        method: 'POST'
      })
      .reply(200, {
        id: 'evt-abc-123',
        conferenceData: { entryPoints: [{ entryPointType: 'phone' }] }
      })

    const result = await createGoogleMeetEvent(SAMPLE_INPUT, FAKE_ENV)
    expect(result.success).toBe(false)
    expect(result.error).toContain('no Meet link')
  })

  it('uses GOOGLE_CALENDAR_ID env override when provided', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'mocked-access', expires_in: 3600 })

    fetchMock
      .get('https://www.googleapis.com')
      .intercept({
        path: (p: string) => p.startsWith('/calendar/v3/calendars/work%40example.com/events'),
        method: 'POST'
      })
      .reply(200, {
        id: 'evt-1',
        conferenceData: {
          conferenceId: 'cid-1',
          entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/zzz' }]
        }
      })

    const result = await createGoogleMeetEvent(SAMPLE_INPUT, {
      ...FAKE_ENV,
      GOOGLE_CALENDAR_ID: 'work@example.com'
    })
    expect(result.success).toBe(true)
  })
})
