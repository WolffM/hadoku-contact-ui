/**
 * Inbound email webhook for receiving emails via Resend.
 *
 * This route is now a thin adapter: it validates the webhook envelope, fetches
 * the body Resend does not include in the push, and hands off to
 * services/inbound-ingest, which is shared with the reconciliation sweep.
 *
 * It used to own the ingest decision itself and discard anything that failed
 * it — non-whitelisted senders, unfetchable bodies, any thrown error — always
 * returning 200. Combined with the webhook being the only ingest path, that is
 * why mail visible at resend.com never reached the command station.
 */

import { Hono } from 'hono'
import { ok, badRequest } from '../utils/responses'
import { getLedgerEntry } from '../storage'
import { ingestInboundEmail, extractAddress } from '../services/inbound-ingest'
import { verifySvixSignature } from '../utils/svix'
import type { AppContext } from '../types'

interface ResendWebhookEvent {
  type: string
  created_at: string
  data: {
    email_id: string
    from: string
    to: string[]
    subject: string
  }
}

interface ResendEmailDetails {
  id: string
  from: string
  to: string[]
  subject: string
  html?: string
  text?: string
  created_at: string
}

export function createInboundRoutes() {
  const app = new Hono<AppContext>()

  app.post('/inbound', async c => {
    // Verified BEFORE anything is parsed or fetched, and fail-closed: with no
    // secret configured every delivery is refused. This route is public, so
    // the signature is the only thing that makes a POST here Resend's. A
    // refused delivery loses nothing — the reconciliation sweep reads Resend's
    // received list on its own schedule and ingests whatever the webhook did
    // not. Resend retries non-2xx, which is harmless for the same reason.
    const webhookSecret = c.env.RESEND_WEBHOOK_SECRET
    if (!webhookSecret) {
      console.error('RESEND_WEBHOOK_SECRET not configured — refusing webhook')
      return c.json({ error: 'Webhook verification not configured' }, 503)
    }
    const rawBody = await c.req.text()
    const verdict = await verifySvixSignature(
      webhookSecret,
      {
        id: c.req.header('svix-id') ?? null,
        timestamp: c.req.header('svix-timestamp') ?? null,
        signature: c.req.header('svix-signature') ?? null
      },
      rawBody
    )
    if (verdict !== 'ok') {
      console.warn(`Inbound webhook refused: ${verdict}`)
      return c.json({ error: 'Invalid webhook signature' }, 401)
    }

    try {
      const event = JSON.parse(rawBody) as ResendWebhookEvent
      // Any other event type is acknowledged and ignored. That includes the
      // daily credential probe (hadoku_site's `resend-webhook` prober), which
      // signs a `hadoku.secret-probe` event with the vault's copy of the
      // secret: a 200 here is its proof that vault and worker agree.
      if (event.type !== 'email.received') {
        return ok(c, { success: true, ignored: event.type ?? null })
      }
      const emailId = event.data?.email_id
      if (!emailId) {
        console.warn('Inbound webhook missing email_id')
        return badRequest(c, 'Invalid webhook payload')
      }

      console.log(`Received email.received webhook for: ${emailId}`)

      if (!event.data.from) {
        console.warn('Inbound email missing sender address')
        return badRequest(c, 'Invalid email format')
      }
      console.log(`Email from: ${extractAddress(event.data.from)}`)
      console.log(`Email to: ${event.data.to?.[0]?.toLowerCase() ?? null}`)

      // Resend retries webhooks. Without this check a retry would create a
      // second submission for the same email, since the UNIQUE index on
      // resend_email_id would reject the insert and the whole handler would
      // fall into the catch below instead — reporting an error for mail that
      // was in fact already delivered.
      const alreadyHandled = await getLedgerEntry(c.env.DB, emailId)
      if (alreadyHandled) {
        console.log(`Webhook replay for ${emailId} — already ${alreadyHandled.outcome}`)
        return ok(c, {
          success: true,
          message: 'Already processed',
          emailId,
          processed: true,
          submissionId: alreadyHandled.submission_id ?? undefined
        })
      }

      const resendApiKey = c.env.RESEND_API_KEY
      if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured')
        return ok(c, {
          success: false,
          message: 'Email service not configured',
          processed: false
        })
      }

      const emailResponse = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
        headers: { Authorization: `Bearer ${resendApiKey}` }
      })

      if (!emailResponse.ok) {
        // Deliberately NOT recorded in the ledger: leaving it unseen is what
        // lets the reconciliation sweep pick this email up later and store it
        // with a real body. Previously this was where mail went to die.
        console.error(
          `Failed to fetch email ${emailId} from Resend: ${emailResponse.status} — leaving for reconciliation sweep`
        )
        return ok(c, {
          success: false,
          message: 'Failed to retrieve email content; deferred to reconciliation',
          processed: false
        })
      }

      const emailDetails = await emailResponse.json<ResendEmailDetails>()

      const result = await ingestInboundEmail(
        c.env,
        {
          emailId,
          from: event.data.from,
          to: event.data.to,
          subject: event.data.subject,
          text: emailDetails.text,
          html: emailDetails.html,
          createdAt: emailDetails.created_at
        },
        'webhook'
      )

      return ok(c, {
        success: result.processed,
        message: result.message,
        emailId,
        processed: result.processed,
        submissionId: result.submissionId,
        filteredReason: result.filteredReason
      })
    } catch (error) {
      console.error('Error processing inbound email:', error)

      // Still a 200 — Resend retries on non-2xx and a retry storm helps
      // nobody. The email is not lost: nothing was written to the ledger, so
      // the reconciliation sweep will ingest it on its next run.
      return ok(c, {
        success: false,
        message: 'Internal error processing email; deferred to reconciliation',
        processed: false
      })
    }
  })

  return app
}
