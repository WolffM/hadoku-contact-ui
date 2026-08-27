/**
 * Unit tests for the appointment confirmation copy.
 *
 * Specifically the branch taken when meeting-link generation FAILED, which is
 * the branch every Google Meet booking has taken since the feature shipped —
 * the Calendar OAuth secrets have never been provisioned.
 */
import { describe, it, expect } from 'vitest'
import { formatAppointmentConfirmation } from '../../email/templates'

const BASE = {
  recipientName: 'John Doe',
  recipientEmail: 'john@example.com',
  appointmentDate: 'Monday, June 15, 2026',
  startTime: '2:00 PM',
  endTime: '2:30 PM',
  timezone: 'America/Los_Angeles',
  duration: 30
}

describe('appointment confirmation — link present', () => {
  it('prints the join URL', () => {
    const { text } = formatAppointmentConfirmation({
      ...BASE,
      platform: 'jitsi',
      meetingLink: 'https://meet.jit.si/hadoku-abc123'
    })

    expect(text).toContain('https://meet.jit.si/hadoku-abc123')
    // The apology is asserted on its distinctive phrase: the template's footer
    // already says "reply to this email" on every send, link or no link.
    expect(text).not.toContain("wasn't able to generate")
  })
})

describe('appointment confirmation — link missing', () => {
  // The old copy promised "I'll send you a <platform> link shortly". Nothing in
  // the system keeps that promise: there is no retry, no queue, and no operator
  // alert. Asking for a reply routes the failure to a human through the inbox
  // that already exists.
  it.each(['google', 'jitsi', 'discord', 'teams'])(
    'asks %s bookers to reply rather than promising a link nothing sends',
    platform => {
      const { text } = formatAppointmentConfirmation({ ...BASE, platform })

      expect(text).toContain("wasn't able to generate")
      expect(text).toContain("Reply to this email and I'll send it over")
      expect(text).not.toMatch(/link shortly/)
    }
  )

  it('still confirms the appointment itself', () => {
    const { subject, text } = formatAppointmentConfirmation({ ...BASE, platform: 'google' })

    expect(subject).toContain('Appointment Confirmed')
    expect(text).toContain('Monday, June 15, 2026')
    expect(text).toContain('2:00 PM')
  })

  it('names the platform that failed, so the reply is actionable', () => {
    expect(formatAppointmentConfirmation({ ...BASE, platform: 'google' }).text).toContain(
      'Google Meet link'
    )
    expect(formatAppointmentConfirmation({ ...BASE, platform: 'discord' }).text).toContain(
      'Discord invite'
    )
  })
})
