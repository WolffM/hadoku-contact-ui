/**
 * Test setup — rebuilds D1 from the migrations and empties both KV namespaces
 * before EVERY test.
 *
 * This is the isolation vitest-pool-workers' `isolatedStorage` used to provide,
 * done in-process instead. That option snapshots storage by copying the `.sqlite`
 * files on disk around each test, and asserts the directory holds nothing else
 * when it does. D1 runs SQLite in WAL mode, so if the D1 object has not finished
 * closing when the copy starts — which happens on a loaded CI host — a
 * `.sqlite-shm` is still there and the whole run dies (issue #27). Rebuilding
 * through the binding never touches the files, so there is nothing to race.
 *
 * SQL files are imported as strings via the sql-loader Vite plugin.
 */
import { env } from 'cloudflare:test'
import { beforeEach } from 'vitest'

// @ts-expect-error — .sql imports handled by vite plugin
import migration0001 from '../migrations/0001_create_contact_tables.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0002 from '../migrations/0002_add_deleted_status.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0003 from '../migrations/0003_create_email_whitelist.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0004 from '../migrations/0004_create_appointments_tables.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0005 from '../migrations/0005_create_templates_tables.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0006 from '../migrations/0006_add_direction_column.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0007 from '../migrations/0007_inbound_email_sync.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0008 from '../migrations/0008_create_email_blocklist.sql'
// @ts-expect-error — .sql imports handled by vite plugin
import migration0009 from '../migrations/0009_platform_optional.sql'

/**
 * Split SQL into individual statements, stripping comments.
 *
 * Comments are stripped BEFORE the split, not after. Splitting first means a
 * `;` inside a `--` comment cuts the statement it documents in half, and the
 * two halves then fail as "incomplete input" — an error that points at the
 * migration runner rather than at the prose that actually caused it. Migration
 * 0008 hit exactly that.
 *
 * Still not a real SQL parser: a `;` inside a quoted string literal would split
 * wrongly too. No migration has one, and the ones that come closest (0005's
 * seeded template bodies) contain no semicolons.
 */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

const migrations = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009
]
const migrationStatements = migrations.flatMap(splitStatements)

/**
 * Drop every table and replay the migrations, so each test starts from exactly
 * what a fresh deployment has — seeded config and templates included.
 *
 * Tables are dropped newest-first, and foreign keys are deferred for the batch,
 * because `appointments` references `contact_submissions`. `sqlite_` and `_cf_`
 * tables belong to SQLite and D1 and are not ours to drop.
 */
async function resetDatabase(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY rowid DESC`
    )
    .all<{ name: string }>()

  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = on'),
    ...results.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
    ...migrationStatements.map(stmt => db.prepare(stmt))
  ])
}

async function clearKv(kv: KVNamespace) {
  let cursor: string | undefined
  do {
    const page = await kv.list({ cursor })
    await Promise.all(page.keys.map(({ name }) => kv.delete(name)))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

beforeEach(async () => {
  await Promise.all([resetDatabase(env.DB), clearKv(env.RATE_LIMIT_KV), clearKv(env.TEMPLATES_KV)])
})
