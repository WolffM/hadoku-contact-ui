/**
 * The Inbox subject of mail that booked a meeting. Read by the operator, so the
 * time is in the operator's zone whatever zone the guest booked from.
 */
import { describe, it, expect } from 'vitest'
import { bookingSubject } from '../../email/templates'

describe('bookingSubject', () => {
  it('names the meeting, then its date and start in the given zone', () => {
    expect(bookingSubject('Recruiting', '2026-11-22T16:00:00.000Z', 'America/Los_Angeles')).toBe(
      'Meeting: Recruiting · Sun, Nov 22, 8:00 AM PST'
    )
  })

  it("lands on the zone's own calendar day", () => {
    // 01:30 UTC on the 23rd is still the evening of the 22nd in Los Angeles.
    expect(bookingSubject('Chat', '2026-11-23T01:30:00.000Z', 'America/Los_Angeles')).toBe(
      'Meeting: Chat · Sun, Nov 22, 5:30 PM PST'
    )
  })
})
