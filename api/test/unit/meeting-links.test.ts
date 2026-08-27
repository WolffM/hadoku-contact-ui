/**
 * Unit tests for the synchronous meeting-link generators.
 *
 * The Google branch is an outbound Calendar API call and is covered in
 * google-meet.test.ts; the end-to-end path through /submit is covered in
 * e2e/meeting-platforms.test.ts. What lives here is the behaviour that depends
 * on the ENV, which the e2e tests cannot reach — SELF.fetch runs the worker
 * against the bindings in wrangler.test.toml, not against a mutated `env`.
 */
import { describe, it, expect } from 'vitest'
import { generateMeetingLink } from '../../services/meeting-links'
import type { ContactEnv } from '../../types'

const APPOINTMENT = {
  slotId: 'slot-2026-06-15-2026-06-15T14:00:00.000Z',
  name: 'John Doe',
  email: 'john@example.com',
  startTime: '2026-06-15T14:00:00.000Z',
  endTime: '2026-06-15T14:30:00.000Z'
}

// Only the meeting-link bindings matter to these generators; DB/KV are never
// touched on the discord or jitsi branch.
function envWith(overrides: Partial<ContactEnv>): ContactEnv {
  return overrides as ContactEnv
}

describe('generateMeetingLink — discord', () => {
  it('falls back to the compiled-in invite when DISCORD_INVITE_URL is unset', async () => {
    const result = await generateMeetingLink('discord', APPOINTMENT, envWith({}))

    expect(result.success).toBe(true)
    expect(result.meetingLink).toBe('https://discord.gg/Epchg7QQ')
  })

  // Revoking a leaked invite, or moving servers, must not require republishing
  // the package and waiting on a parent deploy.
  it('prefers DISCORD_INVITE_URL when it is set', async () => {
    const result = await generateMeetingLink(
      'discord',
      APPOINTMENT,
      envWith({ DISCORD_INVITE_URL: 'https://discord.gg/RotatedInvite' })
    )

    expect(result.meetingLink).toBe('https://discord.gg/RotatedInvite')
  })

  it('ignores an empty DISCORD_INVITE_URL rather than emitting a blank link', async () => {
    const result = await generateMeetingLink(
      'discord',
      APPOINTMENT,
      envWith({ DISCORD_INVITE_URL: '' })
    )

    expect(result.meetingLink).toBe('https://discord.gg/Epchg7QQ')
  })
})

describe('generateMeetingLink — jitsi', () => {
  it('builds a room on meet.jit.si by default', async () => {
    const result = await generateMeetingLink('jitsi', APPOINTMENT, envWith({}))

    expect(result.success).toBe(true)
    expect(result.meetingLink).toMatch(/^https:\/\/meet\.jit\.si\/hadoku-[0-9a-z]+$/)
    expect(result.meetingId).toBe(result.meetingLink!.split('/').pop())
  })

  it('honours a self-hosted JITSI_DOMAIN', async () => {
    const result = await generateMeetingLink(
      'jitsi',
      APPOINTMENT,
      envWith({ JITSI_DOMAIN: 'meet.hadoku.me' })
    )

    expect(result.meetingLink).toMatch(/^https:\/\/meet\.hadoku\.me\/hadoku-[0-9a-z]+$/)
  })

  // The room name IS the access control on a public Jitsi deployment, and slot
  // ids are published by GET /appointments/slots — including which are taken.
  // Deriving one from the other let anyone who read the calendar walk in.
  it('does not derive the room from anything the slot published', async () => {
    const result = await generateMeetingLink('jitsi', APPOINTMENT, envWith({}))

    expect(result.meetingLink).not.toContain(APPOINTMENT.slotId)
    expect(result.meetingLink).not.toContain('2026-06-15')
    expect(result.meetingLink).not.toContain('14:00')
  })

  it('never repeats a room across bookings', async () => {
    const rooms = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const result = await generateMeetingLink('jitsi', APPOINTMENT, envWith({}))
      rooms.add(result.meetingId!)
    }

    expect(rooms.size).toBe(100)
  })

  // Room names go into a URL path and are echoed back to participants by the
  // Jitsi UI. The old slot-derived name carried the ISO timestamp's `:` and `.`.
  it('produces a room name that needs no URL escaping', async () => {
    const result = await generateMeetingLink('jitsi', APPOINTMENT, envWith({}))

    expect(encodeURIComponent(result.meetingId!)).toBe(result.meetingId)
  })
})

describe('generateMeetingLink — unknown platform', () => {
  it('reports failure rather than emitting a link', async () => {
    const result = await generateMeetingLink('teams' as never, APPOINTMENT, envWith({}))

    expect(result.success).toBe(false)
    expect(result.meetingLink).toBeUndefined()
    expect(result.error).toContain('teams')
  })
})
