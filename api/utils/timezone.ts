/**
 * Timezone utilities for converting between local wall-clock time
 * (in a configured IANA zone) and UTC.
 *
 * The Cloudflare Workers runtime ships with the full ICU/timezone DB,
 * so Intl.DateTimeFormat with explicit timeZone works correctly.
 */

/** Get a Date's offset (ms) in a given IANA timezone. Positive = east of UTC. */
function getTimezoneOffset(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  // Intl renders midnight as "24" in some locales — normalize.
  const hour = parts.hour === '24' ? 0 : parseInt(parts.hour)
  const asLocal = Date.UTC(
    parseInt(parts.year),
    parseInt(parts.month) - 1,
    parseInt(parts.day),
    hour,
    parseInt(parts.minute),
    parseInt(parts.second)
  )
  return asLocal - date.getTime()
}

/**
 * Convert a wall-clock time in a given IANA timezone to a UTC Date.
 * Example: zonedDateToUtc('2026-04-30', 9, 0, 'America/New_York')
 *          → Date representing 13:00 UTC (= 09:00 EDT)
 */
export function zonedDateToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  // First guess: treat the wall-clock as if it were UTC
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  // Find what the offset is at that approximate moment in the target zone
  const offset = getTimezoneOffset(utcGuess, timeZone)
  // Subtract offset to get the true UTC instant for that wall-clock
  return new Date(utcGuess.getTime() - offset)
}

/**
 * Day-of-week (0=Sun..6=Sat) of a YYYY-MM-DD date interpreted in a given timezone.
 * The date string is the wall-clock date — we anchor at noon to avoid DST edges.
 */
export function dayOfWeekInZone(date: string, timeZone: string): number {
  const noonUtc = zonedDateToUtc(date, 12, 0, timeZone)
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short'
  }).format(noonUtc)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
}
