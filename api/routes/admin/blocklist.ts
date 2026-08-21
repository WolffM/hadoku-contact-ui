/**
 * Admin blocklist routes — the Block button and the rules behind it.
 *
 * Two shapes on purpose:
 *
 *   POST /submissions/:id/block   the button. The operator is looking at a
 *                                 message and blocks its sender; the pattern is
 *                                 DERIVED from the row, never typed.
 *   POST /blocklist               the list editor, for blocking a sender whose
 *                                 mail is not in front of you.
 *
 * The first exists because making the UI construct the pattern would put address
 * parsing in the client, where a mistake silently blocks the wrong sender. The
 * server already knows the row's `email`; it derives the rule from that.
 */

import { Hono } from 'hono'
import { badRequest, notFound, serverError } from '../../utils/responses'
import {
  addToBlocklist,
  applyBlockToExistingMail,
  domainOf,
  findBlockRule,
  getAllBlocklistEntries,
  getSubmissionById,
  normalizeBlockPattern,
  removeFromBlocklist,
  restoreBlockedMail,
  type BlockKind
} from '../../storage'
import { RETENTION_CONFIG } from '../../constants'
import { isWhitelistEnforced } from '../../services/inbound-ingest'
import { adminOk } from './index'
import type { AppContext } from '../../types'

function parseScope(raw: unknown): BlockKind | null {
  return raw === 'address' || raw === 'domain' ? raw : null
}

export function createBlocklistRoutes() {
  const app = new Hono<AppContext>()

  app.get('/blocklist', async c => {
    try {
      const entries = await getAllBlocklistEntries(c.env.DB)

      return adminOk(c, {
        entries,
        total: entries.length,
        retentionDays: RETENTION_CONFIG.SPAM_RETENTION_DAYS
      })
    } catch (error) {
      console.error('Error fetching blocklist:', error)
      return serverError(c, 'Failed to fetch blocklist')
    }
  })

  app.post('/blocklist', async c => {
    try {
      const body = await c.req.json()

      if (!body.pattern || typeof body.pattern !== 'string') {
        return badRequest(c, 'pattern field is required')
      }

      // `scope` is optional here and inferred when absent (an `@` means the
      // address, a bare host means the domain) — but an EXPLICIT scope is never
      // overridden, because "block the whole domain" typed as a full address is
      // a real intent and guessing against it is how you fail to block a sender
      // that rotates its local part.
      const normalized = normalizeBlockPattern(body.pattern, parseScope(body.scope) ?? undefined)
      if (!normalized) {
        return badRequest(
          c,
          'pattern must be an email address (info@example.com) or a domain (example.com)'
        )
      }

      const auth = c.get('authContext')
      const blockedBy = auth?.credential ?? 'admin'

      await addToBlocklist(c.env.DB, {
        pattern: normalized.pattern,
        kind: normalized.kind,
        blockedBy,
        contactId: typeof body.contactId === 'string' ? body.contactId : null,
        notes: typeof body.notes === 'string' ? body.notes : null
      })

      const moved = await applyBlockToExistingMail(c.env.DB, normalized.pattern, normalized.kind)

      return adminOk(c, {
        pattern: normalized.pattern,
        kind: normalized.kind,
        movedToSpam: moved,
        retentionDays: RETENTION_CONFIG.SPAM_RETENTION_DAYS,
        message: `Blocked ${normalized.pattern}; ${moved} message(s) moved to Spam`
      })
    } catch (error) {
      console.error('Error adding to blocklist:', error)
      return serverError(c, 'Failed to add to blocklist')
    }
  })

  app.delete('/blocklist/:pattern', async c => {
    try {
      const raw = c.req.param('pattern')
      if (!raw) {
        return badRequest(c, 'pattern parameter is required')
      }

      const pattern = decodeURIComponent(raw).trim().toLowerCase()

      // The stored `kind` decides how existing mail is matched back out, so read
      // the row BEFORE deleting it. Inferring the kind from the pattern's shape
      // instead would work for every case except the one that matters — a domain
      // rule and an address rule are distinguishable by the `@`, but only the
      // row knows which was actually stored if both ever existed.
      const entries = await getAllBlocklistEntries(c.env.DB)
      const entry = entries.find(e => e.pattern === pattern)

      if (!entry) {
        return notFound(c, 'Pattern not found in blocklist')
      }

      await removeFromBlocklist(c.env.DB, pattern)
      const restored = await restoreBlockedMail(
        c.env.DB,
        entry.pattern,
        entry.kind,
        isWhitelistEnforced(c.env)
      )

      return adminOk(c, {
        pattern: entry.pattern,
        kind: entry.kind,
        restored,
        message: `Unblocked ${entry.pattern}; ${restored} message(s) returned from Spam`
      })
    } catch (error) {
      console.error('Error removing from blocklist:', error)
      return serverError(c, 'Failed to remove from blocklist')
    }
  })

  // The Block button.
  app.post('/submissions/:id/block', async c => {
    try {
      const id = c.req.param('id')
      const submission = await getSubmissionById(c.env.DB, id)

      if (!submission) {
        return notFound(c, 'Submission')
      }

      // Blocking from an outbound row would take the address the operator SENT
      // to and block it — self-inflicted, and the row's `email` column makes it
      // look identical to an inbound sender. Refuse rather than guess.
      if (submission.direction === 'outbound') {
        return badRequest(c, 'Cannot block a sender from a message you sent')
      }

      const scope = parseScope((await c.req.json().catch(() => ({}))).scope) ?? 'address'
      const source = scope === 'domain' ? domainOf(submission.email) : submission.email
      const normalized = normalizeBlockPattern(source, scope)

      if (!normalized) {
        return badRequest(c, `Cannot derive a ${scope} rule from sender "${submission.email}"`)
      }

      const auth = c.get('authContext')
      const blockedBy = auth?.credential ?? 'admin'

      await addToBlocklist(c.env.DB, {
        pattern: normalized.pattern,
        kind: normalized.kind,
        blockedBy,
        contactId: submission.id,
        notes: `Blocked from message ${submission.id}`
      })

      const moved = await applyBlockToExistingMail(c.env.DB, normalized.pattern, normalized.kind)

      return adminOk(c, {
        pattern: normalized.pattern,
        kind: normalized.kind,
        movedToSpam: moved,
        retentionDays: RETENTION_CONFIG.SPAM_RETENTION_DAYS,
        message: `Blocked ${normalized.pattern}; ${moved} message(s) moved to Spam`
      })
    } catch (error) {
      console.error('Error blocking sender:', error)
      return serverError(c, 'Failed to block sender')
    }
  })

  // The Unblock button, and the mirror of the Block one.
  //
  // Keyed on the submission rather than a pattern because the UI cannot know
  // WHICH rule caught a message: `info@cerebras.net` may be in Spam because
  // that address was blocked or because `cerebras.net` was. Resolving it in the
  // client would duplicate findBlockRule's precedence there, and the two would
  // eventually disagree. The server already knows.
  app.post('/submissions/:id/unblock', async c => {
    try {
      const id = c.req.param('id')
      const submission = await getSubmissionById(c.env.DB, id)

      if (!submission) {
        return notFound(c, 'Submission')
      }

      const rule = await findBlockRule(c.env.DB, submission.email)
      if (!rule) {
        return notFound(c, `No blocklist rule matching ${submission.email}`)
      }

      await removeFromBlocklist(c.env.DB, rule.pattern)
      const restored = await restoreBlockedMail(
        c.env.DB,
        rule.pattern,
        rule.kind,
        isWhitelistEnforced(c.env)
      )

      return adminOk(c, {
        pattern: rule.pattern,
        kind: rule.kind,
        restored,
        message: `Unblocked ${rule.pattern}; ${restored} message(s) returned from Spam`
      })
    } catch (error) {
      console.error('Error unblocking sender:', error)
      return serverError(c, 'Failed to unblock sender')
    }
  })

  return app
}
