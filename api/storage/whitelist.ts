/**
 * Email whitelist storage operations
 */

export interface WhitelistEntry {
  email: string
  whitelisted_at: number
  whitelisted_by: string
  contact_id: string | null
  notes: string | null
}

export async function isEmailWhitelisted(db: D1Database, email: string): Promise<boolean> {
  const result = await db
    .prepare(`SELECT email FROM email_whitelist WHERE email = ?`)
    .bind(email.toLowerCase())
    .first()

  return result !== null
}

export async function addToWhitelist(
  db: D1Database,
  email: string,
  whitelistedBy: string,
  contactId?: string,
  notes?: string
): Promise<boolean> {
  const whitelistedAt = Date.now()

  try {
    await db
      .prepare(
        `INSERT INTO email_whitelist (email, whitelisted_at, whitelisted_by, contact_id, notes)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(email) DO UPDATE SET
					whitelisted_at = ?,
					whitelisted_by = ?,
					contact_id = COALESCE(?, contact_id),
					notes = COALESCE(?, notes)`
      )
      .bind(
        email.toLowerCase(),
        whitelistedAt,
        whitelistedBy,
        contactId ?? null,
        notes ?? null,
        whitelistedAt,
        whitelistedBy,
        contactId ?? null,
        notes ?? null
      )
      .run()

    return true
  } catch (error) {
    console.error('Failed to add email to whitelist:', error)
    return false
  }
}

export async function removeFromWhitelist(db: D1Database, email: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM email_whitelist WHERE email = ?`)
    .bind(email.toLowerCase())
    .run()

  return result.success
}

export async function getAllWhitelistedEmails(db: D1Database): Promise<WhitelistEntry[]> {
  const result = await db
    .prepare(
      `SELECT email, whitelisted_at, whitelisted_by, contact_id, notes
			FROM email_whitelist
			ORDER BY whitelisted_at DESC`
    )
    .all<WhitelistEntry>()

  return result.results ?? []
}
