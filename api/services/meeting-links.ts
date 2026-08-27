/**
 * Meeting link generation service
 *
 * Discord — server invite, from config (synchronous).
 * Jitsi   — URL construction over a random room token (synchronous).
 * Google  — Google Calendar API call (async, returns null link if OAuth secrets missing).
 *
 * Validation in validation.ts ensures `platform` matches VALID_PLATFORMS
 * before this is reached, so the default branch is defensive only.
 *
 * A link generated here is a CAPABILITY: on Jitsi and Discord, holding the URL
 * is the whole of the access control. Nothing here may therefore be derived
 * from a value the public can already read — see `jitsiRoomToken`.
 */

import { createGoogleMeetEvent } from './google-meet'
import type { ContactEnv } from '../types'

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
  env: ContactEnv
): Promise<MeetingLinkResult> {
  switch (platform) {
    case 'discord':
      return generateDiscordLink(appointment, env)
    case 'jitsi':
      return generateJitsiLink(env)
    case 'google':
      return createGoogleMeetEvent(appointment, env)
    default:
      return {
        success: false,
        error: `Unsupported platform: ${String(platform)}`
      }
  }
}

// The invite the operator hands out for a Discord booking. A `[vars]` entry,
// not a secret — it is printed in confirmation email and shown in the browser.
// It lives in config because an invite is the one part of this that expires:
// revoking a leaked invite, or moving servers, used to mean republishing the
// package and waiting on a parent deploy. DEFAULT_DISCORD_INVITE keeps existing
// deployments on the invite they already had when the var is unset.
const DEFAULT_DISCORD_INVITE = 'https://discord.gg/Epchg7QQ'

function generateDiscordLink(appointment: AppointmentDetails, env: ContactEnv): MeetingLinkResult {
  return {
    success: true,
    meetingLink: env.DISCORD_INVITE_URL || DEFAULT_DISCORD_INVITE,
    meetingId: `discord-${appointment.slotId}`
  }
}

/**
 * A room name nobody can derive.
 *
 * The room used to be `hadoku-${slotId}`, and `slotId` is
 * `slot-<date>-<ISO start>` — every booked slot id is reconstructible from the
 * PUBLIC `GET /appointments/slots` listing, which names each slot and says
 * whether it is taken. A meet.jit.si room is open to whoever holds its URL, so
 * that made every meeting joinable by a stranger who read the calendar: take
 * the ids marked unavailable, prefix `hadoku-`, walk in. The ISO timestamp also
 * put `:` and `.` in the room name, which Jitsi renders back at participants.
 *
 * 128 bits from the CSPRNG, base36. Unguessable, and no longer a function of
 * anything the booking published.
 */
function jitsiRoomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('')
}

function generateJitsiLink(env: ContactEnv): MeetingLinkResult {
  const roomName = `hadoku-${jitsiRoomToken()}`
  const jitsiDomain = env.JITSI_DOMAIN ?? 'meet.jit.si'

  return {
    success: true,
    meetingLink: `https://${jitsiDomain}/${roomName}`,
    meetingId: roomName
  }
}
