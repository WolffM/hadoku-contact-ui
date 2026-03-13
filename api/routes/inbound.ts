/**
 * Inbound email webhook for receiving emails via Resend
 */

import { Hono } from 'hono'
import { ok, badRequest } from '../utils/responses'
import { isEmailWhitelisted, createSubmission } from '../storage'
import { EMAIL_CONFIG } from '../constants'
import type { AppContext } from '../types'

interface ResendWebhookEvent {
  type: 'email.received'
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
    const db = c.env.DB
    const request = c.req.raw

    try {
      const webhookSecret = c.env.RESEND_WEBHOOK_SECRET
      if (webhookSecret) {
        const signature = request.headers.get('svix-signature')
        if (!signature) {
          console.warn('Missing webhook signature')
          return badRequest(c, 'Missing webhook signature')
        }
      }

      const event = await c.req.json<ResendWebhookEvent>()

      const emailId = event.data.email_id
      console.log(`Received email.received webhook for: ${emailId}`)

      const senderEmail = event.data.from.toLowerCase()
      if (!senderEmail) {
        console.warn('Inbound email missing sender address')
        return badRequest(c, 'Invalid email format')
      }

      const emailRegex = /<(.+)>/
      const emailMatch = emailRegex.exec(senderEmail)
      const cleanEmail = emailMatch?.[1] ?? senderEmail

      console.log(`Email from: ${cleanEmail}`)

      const recipient = event.data.to[0]?.toLowerCase() ?? null
      console.log(`Email to: ${recipient}`)

      const isPublicRecipient =
        recipient &&
        EMAIL_CONFIG.PUBLIC_RECIPIENTS.includes(
          recipient as (typeof EMAIL_CONFIG.PUBLIC_RECIPIENTS)[number]
        )

      const isWhitelisted = await isEmailWhitelisted(db, cleanEmail)

      if (!isWhitelisted && !isPublicRecipient) {
        console.log(
          `Rejecting email from non-whitelisted sender: ${cleanEmail} to non-public recipient: ${recipient}`
        )

        return ok(c, {
          success: false,
          message: 'Sender not whitelisted',
          processed: false
        })
      }

      console.log(
        `Processing email - whitelisted: ${isWhitelisted}, public recipient: ${isPublicRecipient}`
      )

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
        headers: {
          Authorization: `Bearer ${resendApiKey}`
        }
      })

      if (!emailResponse.ok) {
        console.error(`Failed to fetch email from Resend: ${emailResponse.status}`)
        return ok(c, {
          success: false,
          message: 'Failed to retrieve email content',
          processed: false
        })
      }

      const emailDetails = await emailResponse.json<ResendEmailDetails>()

      const message = emailDetails.text ?? emailDetails.html ?? '(No message body)'

      const submission = await createSubmission(db, {
        name: cleanEmail.split('@')[0],
        email: cleanEmail,
        message: `Subject: ${event.data.subject}\n\n${message}`,
        ip_address: null,
        user_agent: 'Resend Inbound Email',
        referrer: null,
        recipient
      })

      console.log(`Created submission ${submission.id} from inbound email ${emailId}`)

      return ok(c, {
        success: true,
        message: 'Email processed successfully',
        submissionId: submission.id,
        emailId,
        processed: true
      })
    } catch (error) {
      console.error('Error processing inbound email:', error)

      return ok(c, {
        success: false,
        message: 'Internal error processing email',
        processed: false
      })
    }
  })

  return app
}
