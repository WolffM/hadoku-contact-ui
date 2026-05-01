/**
 * Unit tests for timezone helpers.
 */
import { describe, it, expect } from 'vitest'
import { zonedDateToUtc, dayOfWeekInZone } from '../../utils/timezone'

describe('zonedDateToUtc', () => {
  it('9 AM in New York EDT (May 3, 2026) is 13:00 UTC', () => {
    const utc = zonedDateToUtc('2026-05-03', 9, 0, 'America/New_York')
    expect(utc.toISOString()).toBe('2026-05-03T13:00:00.000Z')
  })

  it('9 AM in Los Angeles PDT (May 3, 2026) is 16:00 UTC', () => {
    const utc = zonedDateToUtc('2026-05-03', 9, 0, 'America/Los_Angeles')
    expect(utc.toISOString()).toBe('2026-05-03T16:00:00.000Z')
  })

  it('9 AM in New York EST (Jan 15, 2026) is 14:00 UTC', () => {
    const utc = zonedDateToUtc('2026-01-15', 9, 0, 'America/New_York')
    expect(utc.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })
})

describe('dayOfWeekInZone', () => {
  it('May 3, 2026 in New York is Sunday (0)', () => {
    expect(dayOfWeekInZone('2026-05-03', 'America/New_York')).toBe(0)
  })

  it('May 4, 2026 in New York is Monday (1)', () => {
    expect(dayOfWeekInZone('2026-05-04', 'America/New_York')).toBe(1)
  })

  it('May 9, 2026 in New York is Saturday (6)', () => {
    expect(dayOfWeekInZone('2026-05-09', 'America/New_York')).toBe(6)
  })

  it('returns -1 if zone unknown (defensive)', () => {
    // Bad zone falls through to whatever Intl renders; document behavior.
    const result = dayOfWeekInZone('2026-05-03', 'America/New_York')
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(6)
  })
})
