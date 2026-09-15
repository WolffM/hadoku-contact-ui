/**
 * Email templates for appointment confirmations and reminders
 */

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let result = template

  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, content: string) => {
      return data[varName] ? content : ''
    }
  )

  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    const value = data[varName]
    if (value === undefined || value === null) {
      return ''
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return JSON.stringify(value)
  })

  return result
}

/** "discord" -> "Discord", "google" -> "Google Meet". */
function platformLabel(platform: string): string {
  const named: Record<string, string> = {
    discord: 'Discord',
    jitsi: 'Jitsi Meet',
    google: 'Google Meet',
    teams: 'Microsoft Teams'
  }
  return named[platform.toLowerCase()] ?? platform.charAt(0).toUpperCase() + platform.slice(1)
}

export interface AppointmentEmailData {
  recipientName: string
  recipientEmail: string
  appointmentDate: string
  startTime: string
  endTime: string
  timezone: string
  duration: number
  platform: string
  meetingLink?: string
  message?: string
  /**
   * True when the Discord link is a PRIVATE, single-use space invite rather
   * than the shared server invite. It changes what the guest must be told:
   * a space invite works once and is theirs alone, so "share it with anyone
   * who should join" would be actively wrong. Derived at the call site from
   * the meeting id, because only there is a space distinguishable from a
   * legacy `discord-<slotId>` booking.
   */
  isPrivateSpace?: boolean
}

export function formatAppointmentConfirmation(data: AppointmentEmailData): {
  subject: string
  text: string
} {
  const subject = `Appointment Confirmed - ${data.appointmentDate} at ${data.startTime}`

  const text = `Hi ${data.recipientName},

Your meeting is confirmed.

  ${data.appointmentDate}
  ${data.startTime} - ${data.endTime} ${data.timezone} (${data.duration} min)
  ${platformLabel(data.platform)}
${data.meetingLink ? `\nJoin here:\n${data.meetingLink}\n` : ''}
${getPlatformInstructions(data.platform, data.meetingLink, data.isPrivateSpace)}
${data.message ? `\nYou wrote:\n${data.message}\n` : ''}
Need to change or cancel? Just reply to this email.

- Matthaeus Wolff
hadoku.me`

  return { subject, text }
}

// What the confirmation says when link generation FAILED. It used to promise
// "I'll send you a <platform> link shortly" — a promise nothing in the system
// keeps: no retry, no queue, no alert to the operator, and the booking looks
// entirely successful from the admin side. It fired on every Google booking,
// because the Calendar OAuth secrets have never been provisioned.
//
// Asking for a reply is the honest version and the useful one: it routes the
// failure to a human through the inbox that already exists, instead of leaving
// the booker waiting on a message nobody knows to send.
function missingLinkNotice(platformLabel: string): string {
  return `I wasn't able to generate the ${platformLabel} link automatically. Reply to this email and I'll send it over before the meeting.`
}

function getPlatformInstructions(
  platform: string,
  meetingLink?: string,
  isPrivateSpace?: boolean
): string {
  // NO LINK IN HERE. The link is printed once, above this, under "Join here".
  // This block repeated it verbatim, so every confirmation carried the same URL
  // twice — which reads as a mistake and made the mail longer than the booking.
  if (!meetingLink) return missingLinkNotice(platformLabel(platform))

  switch (platform.toLowerCase()) {
    case 'discord':
      // A space invite is single-use and belongs to one guest: telling them to
      // pass it on would cost them their own way in.
      return isPrivateSpace
        ? 'That link opens a private space set up just for this meeting. It works once, so keep it to yourself.'
        : 'Make sure you have Discord installed and an account set up before we meet.'

    case 'jitsi':
      return 'Jitsi runs in any modern browser - no account or install needed.'

    case 'google':
      return 'You can join from your browser (Chrome recommended) or the Google Meet app.'

    case 'teams':
      return 'You can join from your browser or the Microsoft Teams app.'

    default:
      return 'Meeting details will be provided shortly.'
  }
}

export function formatAppointmentReminder(data: AppointmentEmailData): {
  subject: string
  text: string
} {
  const subject = `Reminder: Appointment Tomorrow - ${data.appointmentDate} at ${data.startTime}`

  const text = `Hi ${data.recipientName},

A reminder about your meeting tomorrow.

  ${data.appointmentDate}
  ${data.startTime} - ${data.endTime} ${data.timezone} (${data.duration} min)
  ${platformLabel(data.platform)}
${data.meetingLink ? `\nJoin here:\n${data.meetingLink}\n` : ''}
${getPlatformInstructions(data.platform, data.meetingLink, data.isPrivateSpace)}

Need to reschedule? Just reply to this email.

- Matthaeus Wolff
hadoku.me`

  return { subject, text }
}

export function prepareAppointmentTemplateData(
  data: AppointmentEmailData
): Record<string, unknown> {
  const platformInstructions = getPlatformInstructions(data.platform, data.meetingLink)
  const platformName = data.platform.charAt(0).toUpperCase() + data.platform.slice(1)

  return {
    recipientName: data.recipientName,
    recipientEmail: data.recipientEmail,
    appointmentDate: data.appointmentDate,
    startTime: data.startTime,
    endTime: data.endTime,
    timezone: data.timezone,
    duration: data.duration,
    platform: data.platform,
    platformName,
    meetingLink: data.meetingLink ?? '',
    message: data.message ?? '',
    platformInstructions
  }
}

export function formatAppointmentDateTime(
  isoDate: string,
  isoStartTime: string,
  isoEndTime: string,
  timezone: string
): {
  date: string
  startTime: string
  endTime: string
  /** Human-facing abbreviation ("PDT"), not the IANA id. */
  timezoneLabel: string
} {
  const startDate = new Date(isoStartTime)
  const endDate = new Date(isoEndTime)

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  }
  const date = startDate.toLocaleDateString('en-US', dateOptions)

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone
  }
  const startTime = startDate.toLocaleTimeString('en-US', timeOptions)
  const endTime = endDate.toLocaleTimeString('en-US', timeOptions)

  // "PDT", not "America/Los_Angeles". The IANA id is what the database stores
  // and what the API speaks, but printing it at a guest reads like a leaked
  // internal value — nobody says "2:45 PM America/Los_Angeles" out loud.
  // Falls back to the IANA id if the runtime cannot produce an abbreviation,
  // which is still better than no timezone at all on a meeting invitation.
  let tzLabel = timezone
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short'
    }).formatToParts(startDate)
    tzLabel = parts.find(p => p.type === 'timeZoneName')?.value ?? timezone
  } catch {
    // Unknown zone — keep the id.
  }

  return { date, startTime, endTime, timezoneLabel: tzLabel }
}
