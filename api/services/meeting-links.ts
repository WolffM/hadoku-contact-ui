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
import { provisionMeetingSpace, spacesConfigured } from './meeting-space'
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
/**
 * How long a booking's private space should live: until the meeting is over,
 * plus a week for the conversation to finish afterwards.
 *
 * Floored at the grace period alone, so a meeting already in the past (an admin
 * backfilling a row, a clock skew) still gets a usable space rather than a
 * negative TTL that ArchiveBot would reject as invalid.
 */
const SPACE_GRACE_MS = 8 * 24 * 60 * 60 * 1000

export function spaceTtlForMeeting(endTimeIso: string, now = Date.now()): number {
  const end = Date.parse(endTimeIso)
  if (!Number.isFinite(end)) return SPACE_GRACE_MS
  return Math.max(SPACE_GRACE_MS, end - now + SPACE_GRACE_MS)
}

const DEFAULT_DISCORD_INVITE = 'https://discord.gg/Epchg7QQ'

async function generateDiscordLink(
  appointment: AppointmentDetails,
  env: ContactEnv
): Promise<MeetingLinkResult> {
  // Where spaces are configured, every guest gets an ISOLATED one: a category
  // only they and the operator can see, with a single-use invite that assigns
  // the role on join. See services/meeting-space.ts.
  if (spacesConfigured(env)) {
    const space = await provisionMeetingSpace(
      {
        // The slot id is stable per appointment, so a retried submit reuses
        // the space instead of burning three more channels of a 500 budget.
        idempotencyKey: `contact-${appointment.slotId}`,
        // TTL RUNS FROM THE MEETING, NOT FROM NOW. ArchiveBot's default is 8
        // days from provisioning, and the booking window allows 30 days out —
        // so a month-ahead booking would have had its space swept 22 days
        // BEFORE the meeting, killing the guest's invite and kicking them if
        // they had already joined. Measuring from the end of the meeting keeps
        // the "gone about a week later" behaviour for every booking regardless
        // of how far ahead it was made.
        ttlMs: spaceTtlForMeeting(appointment.endTime),
        // Operator-facing only. ArchiveBot names the channels and role with an
        // opaque token — a role list is visible to the guild and must not
        // announce who booked.
        label: `Contact booking ${appointment.startTime} (${appointment.email})`,
        // The space is the only place the guest sees the time in THEIR zone.
        // ArchiveBot turns this into a `<t:SECONDS:R>` tag in the intro post
        // and a ping five minutes before; the confirmation email can only ever
        // state the operator's timezone.
        startsAt: appointment.startTime,
        // Shown inside the space, which only this guest and the operator can
        // read — so it may name the meeting. It deliberately does NOT carry the
        // email address `label` does; that is for the operator's eyes.
        title: `Meeting with ${appointment.name}`
      },
      env
    )

    if (space.ok) {
      // meetingId carries the spaceId so a cancellation can revoke it. No
      // schema change: the column already exists for external meeting ids.
      return { success: true, meetingLink: space.inviteUrl, meetingId: space.spaceId }
    }

    // Deliberately NOT falling back to the shared invite. Handing a stranger
    // the general server invite would drop them into the main guild — the
    // exact thing spaces exist to prevent — so an outage degrades to "no link"
    // rather than to a quieter privacy problem. submit.ts reports this through
    // logMeetingLinkFailed and the confirmation email asks them to reply.
    return { success: false, error: `space provisioning failed: ${space.error}` }
  }

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
