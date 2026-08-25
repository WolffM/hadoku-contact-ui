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
async function applyMigration(db: D1Database, sql: string) {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(s => s.trim())
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
    migration0006,
    migration0007,
    migration0008,
    migration0009
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

  const hasResendEmailId = await env.DB.prepare(
    "SELECT 1 FROM pragma_table_info('contact_submissions') WHERE name='resend_email_id'"
  ).first()
  if (!hasResendEmailId) {
    await applyMigration(env.DB, migration0007)
  }

  const hasSpammedAt = await env.DB.prepare(
    "SELECT 1 FROM pragma_table_info('contact_submissions') WHERE name='spammed_at'"
  ).first()
  if (!hasSpammedAt) {
    await applyMigration(env.DB, migration0008)
  }

  // Probe the COLUMN, not a table's existence: 0009 changes `platform` from
  // NOT NULL to nullable in place, so the only durable evidence that it ran is
  // pragma_table_info's `notnull` flag for that column.
  const platformNullable = await env.DB.prepare(
    `SELECT 1 FROM pragma_table_info('appointments') WHERE name='platform' AND "notnull"=0`
  ).first()
  if (!platformNullable) {
    await applyMigration(env.DB, migration0009)
  }
}
