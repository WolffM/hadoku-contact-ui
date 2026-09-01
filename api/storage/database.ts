/**
 * Database utility functions
 */

import { DATABASE_CONFIG } from '../constants'

export interface DatabaseSize {
  sizeBytes: number
  percentUsed: number
  warning: boolean
  /**
   * False when the size could not be read at all. Callers must not render
   * `sizeBytes` as a measurement when this is false — it is a placeholder, not
   * a small database. See the comment on getDatabaseSize.
   */
  available: boolean
}

/**
 * How full is the D1 database?
 *
 * Read from `meta.size_after`, which D1 returns on EVERY query — the size of
 * the database after that statement, in bytes. A `SELECT 1` therefore measures
 * the database without touching it.
 *
 * It used to run `PRAGMA page_count` / `PRAGMA page_size`, which D1 refuses:
 * every call threw `D1_ERROR: not authorized: SQLITE_AUTH`, the catch below
 * swallowed it, and the function returned a hardcoded zero. So capacity read
 * `0.0% (0.00 MB)` on every nightly run and on every /admin/stats response,
 * `warning` was permanently false, and the alarm could not fire no matter how
 * full the database got. It reported healthy precisely because it was blind —
 * the failure mode the whole check exists to prevent.
 *
 * `available: false` is what keeps that from recurring. A failed read is now
 * distinguishable from an empty database, and callers are expected to say
 * "unknown" rather than "0 MB". This function still does not throw, because one
 * of its callers is an admin stats endpoint that should degrade rather than
 * 500; the nightly job is where the loudness lives.
 */
export async function getDatabaseSize(db: D1Database): Promise<DatabaseSize> {
  try {
    // The cheapest statement that still produces meta. It reads no table, so
    // it cannot fail for reasons unrelated to the database being reachable.
    const result = await db.prepare('SELECT 1').run()

    // Number() rather than a cast: `as number` would compile and still yield
    // NaN, which is exactly the silent-garbage outcome a capacity warning must
    // not have.
    const sizeBytes = Number(result.meta?.size_after)

    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new Error(`D1 returned no usable size_after (got ${String(result.meta?.size_after)})`)
    }

    const percentUsed = (sizeBytes / DATABASE_CONFIG.FREE_TIER_LIMIT_BYTES) * 100

    return {
      sizeBytes,
      percentUsed,
      warning: percentUsed > DATABASE_CONFIG.CAPACITY_WARNING_THRESHOLD * 100,
      available: true
    }
  } catch (error) {
    console.error('Failed to get database size:', error)
    return {
      sizeBytes: 0,
      percentUsed: 0,
      // NOT a capacity warning: this says nothing about how full the database
      // is. `available: false` is the signal, and it is the caller's job to
      // treat it as "unknown" rather than as a healthy zero.
      warning: false,
      available: false
    }
  }
}

export async function isDatabaseNearCapacity(db: D1Database): Promise<boolean> {
  const size = await getDatabaseSize(db)
  return size.warning
}
