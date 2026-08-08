/**
 * Database utility functions
 */

import { DATABASE_CONFIG } from '../constants'

export interface DatabaseSize {
  sizeBytes: number
  percentUsed: number
  warning: boolean
}

export async function getDatabaseSize(db: D1Database): Promise<DatabaseSize> {
  try {
    const pragmaResult = await db.batch([
      db.prepare('PRAGMA page_count'),
      db.prepare('PRAGMA page_size')
    ])

    // Number() rather than a cast: these come out of a D1 PRAGMA as `unknown`,
    // and a `as number` would have compiled while still yielding NaN for any
    // non-numeric value — which is exactly the silent-garbage outcome the
    // capacity warning must not have. Number(undefined) is NaN, so the ?? keeps
    // the defaults doing real work.
    const pageCount = Number(
      (pragmaResult[0].results[0] as Record<string, unknown>)?.page_count ?? 0
    )
    const pageSize = Number(
      (pragmaResult[1].results[0] as Record<string, unknown>)?.page_size ??
        DATABASE_CONFIG.DEFAULT_PAGE_SIZE
    )

    const sizeBytes = pageCount * pageSize
    const percentUsed = (sizeBytes / DATABASE_CONFIG.FREE_TIER_LIMIT_BYTES) * 100
    const warning = percentUsed > DATABASE_CONFIG.CAPACITY_WARNING_THRESHOLD * 100

    return {
      sizeBytes,
      percentUsed,
      warning
    }
  } catch (error) {
    console.error('Failed to get database size:', error)
    return {
      sizeBytes: 0,
      percentUsed: 0,
      warning: false
    }
  }
}

export async function isDatabaseNearCapacity(db: D1Database): Promise<boolean> {
  const size = await getDatabaseSize(db)
  return size.warning
}
