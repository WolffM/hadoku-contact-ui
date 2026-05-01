/**
 * Meeting link generation service
 *
 * Discord — static invite (synchronous).
 * Jitsi   — URL construction (synchronous).
 * Google  — Google Calendar API call (async, returns null link if OAuth secrets missing).
 *
 * Validation in validation.ts ensures `platform` matches VALID_PLATFORMS
 * before this is reached, so the default branch is defensive only.
 */

import { createGoogleMeetEvent } from './google-meet'

export type MeetingPlatform = 'discord' | 'jitsi' | 'google'

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

export async function generateMeetingLink(
  platform: MeetingPlatform,
  appointment: AppointmentDetails,
  env: Record<string, unknown>
): Promise<MeetingLinkResult> {
  switch (platform) {
    case 'discord':
      return generateDiscordLink(appointment)
    case 'jitsi':
      return generateJitsiLink(appointment, env)
    case 'google':
      return createGoogleMeetEvent(appointment, env as Parameters<typeof createGoogleMeetEvent>[1])
    default:
      return {
        success: false,
        error: `Unsupported platform: ${String(platform)}`
      }
  }
}

function generateDiscordLink(appointment: AppointmentDetails): MeetingLinkResult {
  return {
    success: true,
    meetingLink: 'https://discord.gg/Epchg7QQ',
    meetingId: `discord-${appointment.slotId}`
  }
}

function generateJitsiLink(
  appointment: AppointmentDetails,
  env: Record<string, unknown>
): MeetingLinkResult {
  const roomName = `hadoku-${appointment.slotId}`
  const jitsiDomain =
    (typeof env.JITSI_DOMAIN === 'string' ? env.JITSI_DOMAIN : null) ?? 'meet.jit.si'

  return {
    success: true,
    meetingLink: `https://${jitsiDomain}/${roomName}`,
    meetingId: roomName
  }
}
