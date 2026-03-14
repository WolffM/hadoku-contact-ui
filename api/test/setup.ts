/**
 * Test setup — applies D1 migrations once before all tests.
 *
 * SQL files are imported as strings via the sql-loader Vite plugin.
 * Only runs migrations if tables don't exist yet (idempotent).
 */
import { env } from 'cloudflare:test'

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

/** Split SQL into individual statements, strip comments */
async function applyMigration(db: D1Database, sql: string) {
  const statements = sql
    .split(';')
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(s => s.length > 0)

  for (const stmt of statements) {
    await db.prepare(stmt).run()
  }
}

// Check if migrations already applied (singleWorker mode persists D1)
const existing = await env.DB.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='appointment_config'"
).first()

if (!existing) {
  const migrations = [
    migration0001,
    migration0002,
    migration0003,
    migration0004,
    migration0005,
    migration0006
  ]
  for (const sql of migrations) {
    await applyMigration(env.DB, sql)
  }
} else {
  // Apply incremental migrations for existing databases
  const hasDirection = await env.DB.prepare(
    "SELECT 1 FROM pragma_table_info('contact_submissions') WHERE name='direction'"
  ).first()
  if (!hasDirection) {
    await applyMigration(env.DB, migration0006)
  }
}
