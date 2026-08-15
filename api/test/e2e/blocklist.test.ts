/**
 * Blocking a sender, end to end.
 *
 * Covers the two ways a block can be defeated in practice: an inbound mail that
 * consults the whitelist before the blocklist, and a web-form submission that
 * auto-whitelists the very sender that was just blocked.
 */
import { env, SELF, fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addToWhitelist, findBlockRule } from '../../storage'
import { EMAIL_CONFIG } from '../../constants'

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Edge-Auth': 'test-edge-secret',
  'X-Hadoku-Tier': 'admin'
}

const NON_PUBLIC_RECIPIENT = 'support@hadoku.me'

if ((EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]).includes(NON_PUBLIC_RECIPIENT)) {
  throw new Error(`${NON_PUBLIC_RECIPIENT} is now public; pick another gated mailbox.`)
}

interface SubmissionRow {
  id: string
  email: string
  status: string
  filtered_reason: string | null
  spammed_at: number | null
}

function adminRequest(path: string, options: RequestInit = {}) {
  return SELF.fetch(`https://test.com${path}`, { headers: ADMIN_HEADERS, ...options })
}

function mockRetrieve(emailId: string, body: Record<string, unknown>) {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: `/emails/receiving/${emailId}`, method: 'GET' })
    .reply(200, JSON.stringify(body))
}

async function postWebhook(data: {
  email_id: string
  from: string
  to: string[]
  subject: string
}) {
  return SELF.fetch('https://test.com/contact/api/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data })
  })
}

async function rowFor(emailId: string): Promise<SubmissionRow | null> {
  return env.DB.prepare('SELECT * FROM contact_submissions WHERE resend_email_id = ?')
    .bind(emailId)
    .first<SubmissionRow>()
}

async function seedSubmission(id: string, email: string, direction = 'inbound') {
  await env.DB.prepare(
    `INSERT INTO contact_submissions (id, name, email, message, status, created_at, recipient, direction)
     VALUES (?, ?, ?, ?, 'unread', ?, ?, ?)`
  )
    .bind(id, email.split('@')[0], email, 'body', Date.now(), NON_PUBLIC_RECIPIENT, direction)
    .run()
}

describe('blocking a sender', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM contact_submissions').run()
    await env.DB.prepare('DELETE FROM email_whitelist').run()
    await env.DB.prepare('DELETE FROM email_blocklist').run()
    await env.DB.prepare('DELETE FROM inbound_email_ledger').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  describe('POST /admin/submissions/:id/block', () => {
    it('blocks the sender and sweeps their existing mail into Spam', async () => {
      await seedSubmission('spam-1', 'info@cerebras.net')
      await seedSubmission('spam-2', 'info@cerebras.net')
      await seedSubmission('keep-1', 'friend@example.com')

      const response = await adminRequest('/contact/api/admin/submissions/spam-1/block', {
        method: 'POST',
        body: JSON.stringify({})
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data.pattern).toBe('info@cerebras.net')
      expect(body.data.kind).toBe('address')
      expect(body.data.movedToSpam).toBe(2)
      expect(body.data.retentionDays).toBe(90)

      expect(await findBlockRule(env.DB, 'info@cerebras.net')).not.toBeNull()

      const kept = await env.DB.prepare('SELECT * FROM contact_submissions WHERE id = ?')
        .bind('keep-1')
        .first<SubmissionRow>()
      expect(kept?.filtered_reason).toBeNull()
    })

    it('blocks the whole domain when asked, catching rotated local parts', async () => {
      await seedSubmission('spam-1', 'info@cerebras.net')
      await seedSubmission('spam-2', 'hello@cerebras.net')

      const response = await adminRequest('/contact/api/admin/submissions/spam-1/block', {
        method: 'POST',
        body: JSON.stringify({ scope: 'domain' })
      })

      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data.pattern).toBe('cerebras.net')
      expect(body.data.kind).toBe('domain')
      expect(body.data.movedToSpam).toBe(2)
    })

    it('refuses to block from a message the operator SENT', async () => {
      await seedSubmission('out-1', 'client@example.com', 'outbound')

      const response = await adminRequest('/contact/api/admin/submissions/out-1/block', {
        method: 'POST',
        body: JSON.stringify({})
      })

      expect(response.status).toBe(400)
      expect(await findBlockRule(env.DB, 'client@example.com')).toBeNull()
    })

    it('404s on an unknown submission', async () => {
      const response = await adminRequest('/contact/api/admin/submissions/nope/block', {
        method: 'POST',
        body: JSON.stringify({})
      })
      expect(response.status).toBe(404)
    })

    it('requires admin', async () => {
      await seedSubmission('spam-1', 'info@cerebras.net')
      const response = await SELF.fetch(
        'https://test.com/contact/api/admin/submissions/spam-1/block',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
      expect(response.status).toBe(403)
      expect(await findBlockRule(env.DB, 'info@cerebras.net')).toBeNull()
    })
  })

  describe('inbound mail from a blocked sender', () => {
    it('lands in Spam, already read, with the clock started', async () => {
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'info@cerebras.net' })
      })

      mockRetrieve('em_spam', { id: 'em_spam', text: 'buy compute' })
      const response = await postWebhook({
        email_id: 'em_spam',
        from: 'Cerebras <info@cerebras.net>',
        to: [NON_PUBLIC_RECIPIENT],
        subject: 'Scale your AI'
      })

      expect(response.status).toBe(200)
      const row = await rowFor('em_spam')
      expect(row?.filtered_reason).toBe('blocked')
      // Never unread: being notified by a blocked sender defeats the feature.
      expect(row?.status).toBe('read')
      expect(row?.spammed_at).toBeGreaterThan(0)
    })

    it('is blocked even when the sender is whitelisted', async () => {
      // A single past reply auto-whitelists a sender, so without this precedence
      // one old conversation would permanently outrank an explicit block.
      await addToWhitelist(env.DB, 'info@cerebras.net', 'admin')
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'info@cerebras.net' })
      })

      mockRetrieve('em_wl', { id: 'em_wl', text: 'more spam' })
      await postWebhook({
        email_id: 'em_wl',
        from: 'info@cerebras.net',
        to: [NON_PUBLIC_RECIPIENT],
        subject: 'Again'
      })

      expect((await rowFor('em_wl'))?.filtered_reason).toBe('blocked')
    })

    it('is blocked even when addressed to a public mailbox', async () => {
      // Public addresses are the ones scraped off the site, so they are exactly
      // where blocking matters most — the bypass must not outrank a block.
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'cerebras.net', scope: 'domain' })
      })

      mockRetrieve('em_pub', { id: 'em_pub', text: 'spam' })
      await postWebhook({
        email_id: 'em_pub',
        from: 'newsletter@cerebras.net',
        to: ['matthaeus@hadoku.me'],
        subject: 'Newsletter'
      })

      expect((await rowFor('em_pub'))?.filtered_reason).toBe('blocked')
    })

    it('leaves unblocked senders alone', async () => {
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'info@cerebras.net' })
      })

      mockRetrieve('em_ok', { id: 'em_ok', text: 'hello' })
      await postWebhook({
        email_id: 'em_ok',
        from: 'friend@example.com',
        to: ['matthaeus@hadoku.me'],
        subject: 'Hi'
      })

      expect((await rowFor('em_ok'))?.filtered_reason).toBeNull()
    })
  })

  describe('web form from a blocked sender', () => {
    it('quarantines the submission and refuses to auto-whitelist them', async () => {
      // The form auto-whitelists its submitter, so left unguarded this is the
      // path that UNDOES a block.
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'info@cerebras.net' })
      })

      const response = await SELF.fetch('https://test.com/contact/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.7',
          Referer: 'https://hadoku.me/contact'
        },
        body: JSON.stringify({
          name: 'Cerebras',
          email: 'info@cerebras.net',
          message: 'Still trying to sell you compute',
          recipient: 'matthaeus@hadoku.me'
        })
      })

      // Still a normal 201. A blocked sender must not be able to detect the
      // block by the response — that just tells a spammer to switch addresses.
      expect(response.status).toBe(201)

      const row = await env.DB.prepare(
        'SELECT * FROM contact_submissions WHERE email = ? ORDER BY created_at DESC'
      )
        .bind('info@cerebras.net')
        .first<SubmissionRow>()
      expect(row?.filtered_reason).toBe('blocked')
      expect(row?.status).toBe('read')

      const whitelisted = await env.DB.prepare('SELECT * FROM email_whitelist WHERE email = ?')
        .bind('info@cerebras.net')
        .first()
      expect(whitelisted).toBeNull()
    })
  })

  describe('DELETE /admin/blocklist/:pattern', () => {
    it('unblocks and returns the mail from Spam', async () => {
      await seedSubmission('spam-1', 'info@cerebras.net')
      await adminRequest('/contact/api/admin/submissions/spam-1/block', {
        method: 'POST',
        body: JSON.stringify({})
      })

      const response = await adminRequest(
        `/contact/api/admin/blocklist/${encodeURIComponent('info@cerebras.net')}`,
        { method: 'DELETE' }
      )

      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data.restored).toBe(1)

      expect(await findBlockRule(env.DB, 'info@cerebras.net')).toBeNull()
      const row = await env.DB.prepare('SELECT * FROM contact_submissions WHERE id = ?')
        .bind('spam-1')
        .first<SubmissionRow>()
      expect(row?.spammed_at).toBeNull()
    })

    it('unblocks by submission, resolving the DOMAIN rule that caught it', async () => {
      // The reason this endpoint exists: the message is from info@cerebras.net
      // but the rule holding it is the domain. A client guessing "unblock the
      // address" would remove nothing and leave the mail in Spam.
      await seedSubmission('spam-1', 'info@cerebras.net')
      await adminRequest('/contact/api/admin/submissions/spam-1/block', {
        method: 'POST',
        body: JSON.stringify({ scope: 'domain' })
      })

      const response = await adminRequest('/contact/api/admin/submissions/spam-1/unblock', {
        method: 'POST'
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data.pattern).toBe('cerebras.net')
      expect(body.data.kind).toBe('domain')
      expect(body.data.restored).toBe(1)

      expect(await findBlockRule(env.DB, 'info@cerebras.net')).toBeNull()
    })

    it('404s on a pattern that was never blocked', async () => {
      const response = await adminRequest('/contact/api/admin/blocklist/nobody%40example.com', {
        method: 'DELETE'
      })
      expect(response.status).toBe(404)
    })
  })

  describe('GET /admin/blocklist', () => {
    it('lists the rules with the retention window', async () => {
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'info@cerebras.net' })
      })
      await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'spam.example', scope: 'domain' })
      })

      const response = await adminRequest('/contact/api/admin/blocklist')
      const body = (await response.json()) as {
        data: { entries: unknown[]; total: number; retentionDays: number }
      }

      expect(body.data.total).toBe(2)
      expect(body.data.retentionDays).toBe(90)
    })

    it('rejects a pattern that is neither an address nor a domain', async () => {
      const response = await adminRequest('/contact/api/admin/blocklist', {
        method: 'POST',
        body: JSON.stringify({ pattern: 'notadomain' })
      })
      expect(response.status).toBe(400)
    })
  })
})
