/**
 * The operator's link must never be the guest's invite.
 *
 * A Discord booking's meeting_link is a maxUses:1 invite minted for one guest.
 * The command station rendered exactly that as "Join Meeting", so the admin UI
 * offered the operator the single link they must not consume.
 */
import { describe, it, expect } from 'vitest'
import { operatorLinkFor } from '../../services/meeting-space'
import type { ContactEnv } from '../../types'

const GUILD = '1442248915599753339'
const env = { ARCHIVEBOT_SPACE_GUILD_ID: GUILD } as unknown as ContactEnv

describe('operatorLinkFor', () => {
  it('routes a space booking to the guild, not to the invite', () => {
    const link = operatorLinkFor({ platform: 'discord', meeting_id: '2v3339076n2h5q49' }, env)
    expect(link).toBe(`https://discord.com/channels/${GUILD}`)
    // The assertion that matters: it is not an invite of any kind.
    expect(link).not.toContain('discord.gg')
  })

  it.each([
    ['jitsi', 'hadoku-abc123'],
    ['google', 'xyz-abcd-efg']
  ])('returns null for %s — its link already suits everyone', (platform, meetingId) => {
    expect(operatorLinkFor({ platform, meeting_id: meetingId }, env)).toBeNull()
  })

  // Pre-space Discord bookings carry the SHARED invite, which the operator can
  // click without consuming anything.
  it('returns null for a legacy discord booking', () => {
    expect(
      operatorLinkFor({ platform: 'discord', meeting_id: 'discord-slot-2026-01-01' }, env)
    ).toBeNull()
  })

  it('returns null when no guild is configured, rather than a broken URL', () => {
    expect(
      operatorLinkFor({ platform: 'discord', meeting_id: '2v3339076n2h5q49' }, {} as ContactEnv)
    ).toBeNull()
  })
})

// Migration 0009 made platform optional: an admin-created event can name no
// platform at all, and asking for its operator link must not throw.
describe('operatorLinkFor — nullable platform', () => {
  it('returns null for an appointment with no platform', () => {
    expect(operatorLinkFor({ platform: null, meeting_id: null }, env)).toBeNull()
  })
})
