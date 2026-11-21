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
import { generateMeetingLink, meetingTitle, MEETING_TITLE_MAX } from '../../services/meeting-links'
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
    expect(result.meetingLink).toMatch(
      /^https:\/\/meet\.jit\.si\/hadoku-[0-9a-z]+#config\.subject=[^#]+$/
    )
    expect(result.meetingId).toBe(result.meetingLink!.split('/').pop()!.split('#')[0])
  })

  it('honours a self-hosted JITSI_DOMAIN', async () => {
    const result = await generateMeetingLink(
      'jitsi',
      APPOINTMENT,
      envWith({ JITSI_DOMAIN: 'meet.hadoku.me' })
    )

    expect(result.meetingLink).toMatch(
      /^https:\/\/meet\.hadoku\.me\/hadoku-[0-9a-z]+#config\.subject=[^#]+$/
    )
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

describe('generateMeetingLink — jitsi title', () => {
  // An untitled room greets both people with its 128-bit token.
  it("titles the room with the guest's message, in the fragment only", async () => {
    const result = await generateMeetingLink(
      'jitsi',
      { ...APPOINTMENT, message: 'Recruiting' },
      envWith({})
    )
    const url = new URL(result.meetingLink!)

    expect(url.hash).toBe(`#config.subject=${encodeURIComponent('"Recruiting"')}`)
    // The path, which is the whole access control, is still only the token.
    expect(url.pathname).toBe(`/${result.meetingId}`)
  })

  it('keeps a title with quotes and symbols intact through the fragment', async () => {
    const message = 'Chat re: "Q4" & 100% #roadmap'
    const result = await generateMeetingLink('jitsi', { ...APPOINTMENT, message }, envWith({}))
    const encoded = new URL(result.meetingLink!).hash.slice('#config.subject='.length)

    expect(JSON.parse(decodeURIComponent(encoded))).toBe(message)
  })
})

describe('meetingTitle', () => {
  it('uses a short one-line message as the title', () => {
    expect(meetingTitle({ name: 'Ruben', message: '  Recruiting  ' })).toBe('Recruiting')
  })

  it('falls back to the name for no message, a multi-line one, or a long one', () => {
    expect(meetingTitle({ name: 'Ruben' })).toBe('Meeting with Ruben')
    expect(meetingTitle({ name: 'Ruben', message: 'Hi\nlet us talk' })).toBe('Meeting with Ruben')
    expect(meetingTitle({ name: 'Ruben', message: 'x'.repeat(MEETING_TITLE_MAX + 1) })).toBe(
      'Meeting with Ruben'
    )
    expect(meetingTitle({ name: 'Ruben', message: 'x'.repeat(MEETING_TITLE_MAX) })).toBe(
      'x'.repeat(MEETING_TITLE_MAX)
    )
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
