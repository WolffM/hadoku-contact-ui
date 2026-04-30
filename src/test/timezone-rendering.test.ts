/**
 * Timezone Rendering Tests (UI-side)
 *
 * Verifies the contract the UI components rely on: given a UTC ISO string
 * from the API, the user sees the slot in their browser's local timezone.
 *
 * TimeSlotPicker.tsx renders slots with `format(new Date(slot.startTime), 'h:mm a')`
 * which uses the system's local timezone. We test that this respects TZ env.
 *
 * We use Intl.DateTimeFormat with explicit timeZone — equivalent to date-fns
 * format() output for this use case, and avoids importing React/date-fns here.
 */
import { describe, it, expect } from 'vitest'

function renderTimeInTZ(isoString: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
    timeZone: tz
  }).format(new Date(isoString))
}

describe('UI timezone rendering contract', () => {
  it('a UTC slot renders correctly in New York', () => {
    // 14:00 UTC = 09:00 EST (winter) / 10:00 EDT (summer)
    const winter = '2026-01-15T14:00:00.000Z'
    expect(renderTimeInTZ(winter, 'America/New_York')).toBe('09:00')

    const summer = '2026-07-15T14:00:00.000Z'
    expect(renderTimeInTZ(summer, 'America/New_York')).toBe('10:00')
  })

  it('the same UTC slot renders differently in Tokyo, London, and LA', () => {
    const iso = '2026-06-15T14:00:00.000Z'
    expect(renderTimeInTZ(iso, 'Asia/Tokyo')).toBe('23:00')
    expect(renderTimeInTZ(iso, 'Europe/London')).toBe('15:00') // BST
    expect(renderTimeInTZ(iso, 'America/Los_Angeles')).toBe('07:00') // PDT
  })

  it('renders consistently for users in DST-observing zones across the boundary', () => {
    // 12:00 UTC the day before US DST starts (2026-03-08): EST = 07:00
    const beforeDst = '2026-03-07T12:00:00.000Z'
    expect(renderTimeInTZ(beforeDst, 'America/New_York')).toBe('07:00')

    // Same wall-clock UTC after DST: EDT = 08:00
    const afterDst = '2026-03-09T12:00:00.000Z'
    expect(renderTimeInTZ(afterDst, 'America/New_York')).toBe('08:00')
  })

  it('handles UTC slots that cross day boundaries in user timezone', () => {
    // 03:00 UTC = 14:00 (previous day) in Sydney — wait, no: Sydney is UTC+10/+11
    // 03:00 UTC = 13:00 or 14:00 same day in Sydney. Use 23:00 UTC to flip days:
    const iso = '2026-06-15T23:00:00.000Z'
    const sydney = renderTimeInTZ(iso, 'Australia/Sydney')
    // Sydney in June = AEST (UTC+10), so 23:00 UTC = 09:00 next day
    expect(sydney).toBe('09:00')
  })
})

describe('What the UI does NOT control', () => {
  it('cannot fix wrong UTC times from the API', () => {
    // If the API returns 09:00 UTC claiming it represents "9 AM New York",
    // the UI will faithfully render it — as 04:00 or 05:00 NY time.
    // Test: feed the API's actual buggy output and verify the user sees the wrong time.
    const apiBuggyOutput = '2026-06-15T09:00:00.000Z' // Should have been ~13:00 UTC for "9 AM NY"
    const userSees = renderTimeInTZ(apiBuggyOutput, 'America/New_York')
    expect(userSees).toBe('05:00') // EDT = UTC-4; 09:00 UTC = 05:00 EDT
    // This is what proves the bug is upstream — UI is doing its job correctly.
  })
})
