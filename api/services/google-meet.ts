/**
 * Google Meet link generation via Google Calendar API.
 *
 * Uses the Calendar API path (events.insert with conferenceData.createRequest)
 * which works on personal Gmail accounts — no paid Workspace required.
 *
 * Side effect: creates a calendar event on the OAuth-authorized user's primary
 * calendar. The event holds the Meet link. Without an event, the API will not
 * mint a Meet URL.
 *
 * Setup:
 *   1. Create OAuth client at https://console.cloud.google.com/apis/credentials
 *      Type: "Web application", redirect: http://localhost:8080/oauth/callback
 *   2. Run a one-time auth flow with scope:
 *        https://www.googleapis.com/auth/calendar.events
 *   3. Store the resulting refresh token plus client id/secret as worker secrets:
 *        GOOGLE_OAUTH_CLIENT_ID
 *        GOOGLE_OAUTH_CLIENT_SECRET
 *        GOOGLE_OAUTH_REFRESH_TOKEN
 *   4. Optional: GOOGLE_CALENDAR_ID (defaults to 'primary')
 */

interface GoogleMeetEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REFRESH_TOKEN?: string
  GOOGLE_CALENDAR_ID?: string
}

interface OAuthTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

interface CalendarEventResponse {
  id: string
  conferenceData?: {
    entryPoints?: { entryPointType: string; uri?: string }[]
    conferenceId?: string
  }
}

export interface GoogleMeetLinkInput {
  slotId: string
  name: string
  email: string
  startTime: string // ISO 8601
  endTime: string // ISO 8601
  message?: string
}

export interface GoogleMeetLinkResult {
  success: boolean
  meetingLink?: string
  meetingId?: string
  error?: string
}

async function getAccessToken(env: GoogleMeetEnv): Promise<string> {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN.'
    )
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token exchange failed: ${response.status} ${text}`)
  }

  const data = (await response.json()) as OAuthTokenResponse
  return data.access_token
}

export async function createGoogleMeetEvent(
  input: GoogleMeetLinkInput,
  env: GoogleMeetEnv
): Promise<GoogleMeetLinkResult> {
  try {
    const accessToken = await getAccessToken(env)
    const calendarId = env.GOOGLE_CALENDAR_ID || 'primary'

    const event = {
      summary: `Meeting with ${input.name}`,
      description: input.message
        ? `Booked via hadoku.me\n\n${input.message}`
        : 'Booked via hadoku.me',
      start: { dateTime: input.startTime },
      end: { dateTime: input.endTime },
      attendees: [{ email: input.email }],
      conferenceData: {
        createRequest: {
          requestId: input.slotId,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    )
    url.searchParams.set('conferenceDataVersion', '1')
    url.searchParams.set('sendUpdates', 'none')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    })

    if (!response.ok) {
      const text = await response.text()
      return {
        success: false,
        error: `Calendar API error: ${response.status} ${text.slice(0, 200)}`
      }
    }

    const data = (await response.json()) as CalendarEventResponse
    const videoEntry = data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')

    if (!videoEntry?.uri) {
      return {
        success: false,
        error:
          'Calendar event created but no Meet link returned (conference may still be provisioning)'
      }
    }

    return {
      success: true,
      meetingLink: videoEntry.uri,
      meetingId: data.conferenceData?.conferenceId || data.id
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error generating Meet link'
    }
  }
}
