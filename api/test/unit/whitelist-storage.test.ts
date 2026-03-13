/**
 * Email Whitelist Storage Function Tests
 *
 * Tests whitelist CRUD operations against real D1.
 */
import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isEmailWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  getAllWhitelistedEmails
} from '../../storage'

describe('Email Whitelist Storage Functions', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_whitelist').run()
  })

  it('should return true for whitelisted email', async () => {
    await env.DB.prepare(
      'INSERT INTO email_whitelist (email, whitelisted_at, whitelisted_by) VALUES (?, ?, ?)'
    )
      .bind('test@example.com', Date.now(), 'admin')
      .run()

    const result = await isEmailWhitelisted(env.DB, 'test@example.com')
    expect(result).toBe(true)
  })

  it('should return false for non-whitelisted email', async () => {
    const result = await isEmailWhitelisted(env.DB, 'unknown@example.com')
    expect(result).toBe(false)
  })

  it('should normalize email to lowercase', async () => {
    await env.DB.prepare(
      'INSERT INTO email_whitelist (email, whitelisted_at, whitelisted_by) VALUES (?, ?, ?)'
    )
      .bind('test@example.com', Date.now(), 'admin')
      .run()

    const result = await isEmailWhitelisted(env.DB, 'TEST@EXAMPLE.COM')
    expect(result).toBe(true)
  })

  it('should add email to whitelist', async () => {
    const result = await addToWhitelist(
      env.DB,
      'new@example.com',
      'admin-123',
      'contact-456',
      'Test note'
    )
    expect(result).toBe(true)

    const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
      .bind('new@example.com')
      .first()
    expect(row).not.toBeNull()
    expect(row!.whitelisted_by).toBe('admin-123')
    expect(row!.notes).toBe('Test note')
  })

  it('should remove email from whitelist', async () => {
    await addToWhitelist(env.DB, 'removeme@example.com', 'admin')
    const removed = await removeFromWhitelist(env.DB, 'removeme@example.com')
    expect(removed).toBe(true)

    const row = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
      .bind('removeme@example.com')
      .first()
    expect(row).toBeNull()
  })

  it('should return all whitelisted emails', async () => {
    await addToWhitelist(env.DB, 'user1@example.com', 'admin')
    await addToWhitelist(env.DB, 'user2@example.com', 'admin')

    const results = await getAllWhitelistedEmails(env.DB)
    expect(results).toHaveLength(2)
  })
})
