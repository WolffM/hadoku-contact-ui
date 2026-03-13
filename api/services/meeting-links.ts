/**
 * Meeting link generation service
 */

export type MeetingPlatform = 'discord' | 'google' | 'teams' | 'jitsi'

export interface MeetingLinkResult {
  success: boolean
  meetingLink?: string
  meetingId?: string
  error?: string
}

export interface AppointmentDetails {
  slotId: string
  name: string
  email: string
  startTime: string
  endTime: string
  message?: string
}

export function generateMeetingLink(
  platform: MeetingPlatform,
  appointment: AppointmentDetails,
  env: Record<string, unknown>
): MeetingLinkResult {
  switch (platform) {
    case 'discord':
      return generateDiscordLink(appointment, env)
    case 'google':
      return generateGoogleMeetLink(appointment, env)
    case 'teams':
      return generateTeamsLink(appointment, env)
    case 'jitsi':
      return generateJitsiLink(appointment, env)
    default:
      return {
        success: false,
        error: `Unsupported platform: ${String(platform)}`
      }
  }
}

function generateDiscordLink(
  appointment: AppointmentDetails,
  _env: Record<string, unknown>
): MeetingLinkResult {
  const discordInvite = 'https://discord.gg/Epchg7QQ'

  return {
    success: true,
    meetingLink: discordInvite,
    meetingId: `discord-${appointment.slotId}`
  }
}

function generateGoogleMeetLink(
  _appointment: AppointmentDetails,
  env: Record<string, unknown>
): MeetingLinkResult {
  const hasGoogleCredentials = env.GOOGLE_CALENDAR_API_KEY && env.GOOGLE_CALENDAR_ID

  if (!hasGoogleCredentials) {
    return {
      success: false,
      error:
        'Google Calendar API not configured. Set GOOGLE_CALENDAR_API_KEY and GOOGLE_CALENDAR_ID in secrets.'
    }
  }

  return {
    success: false,
    error: 'Google Meet integration not yet implemented. Configure Google Calendar API.'
  }
}

function generateTeamsLink(
  _appointment: AppointmentDetails,
  env: Record<string, unknown>
): MeetingLinkResult {
  const hasTeamsCredentials = env.MICROSOFT_GRAPH_CLIENT_ID && env.MICROSOFT_GRAPH_CLIENT_SECRET

  if (!hasTeamsCredentials) {
    return {
      success: false,
      error:
        'Microsoft Graph API not configured. Set MICROSOFT_GRAPH_CLIENT_ID and MICROSOFT_GRAPH_CLIENT_SECRET in secrets.'
    }
  }

  return {
    success: false,
    error: 'Microsoft Teams integration not yet implemented. Configure Microsoft Graph API.'
  }
}

function generateJitsiLink(
  appointment: AppointmentDetails,
  env: Record<string, unknown>
): MeetingLinkResult {
  const roomName = `hadoku-${appointment.slotId}`
  const jitsiDomain =
    (typeof env.JITSI_DOMAIN === 'string' ? env.JITSI_DOMAIN : null) ?? 'meet.jit.si'
  const meetingLink = `https://${jitsiDomain}/${roomName}`

  return {
    success: true,
    meetingLink,
    meetingId: roomName
  }
}
