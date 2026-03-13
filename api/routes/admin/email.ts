/**
 * Admin email and whitelist routes
 *
 * Send emails, manage whitelist
 */

import { Hono } from 'hono'
import { badRequest, notFound, serverError } from '../../utils/responses'
import { addToWhitelist, getAllWhitelistedEmails, removeFromWhitelist } from '../../storage'
import { createEmailProvider } from '../../email'
import { EMAIL_CONFIG, VALIDATION_CONSTRAINTS } from '../../constants'
import { adminOk } from './index'
import type { AppContext } from '../../types'

export function createEmailRoutes() {
  const app = new Hono<AppContext>()

  app.post('/send-email', async c => {
    try {
      const body = await c.req.json()

      if (!body.from || typeof body.from !== 'string') {
        return badRequest(c, 'from field is required')
      }
      if (!body.to || typeof body.to !== 'string') {
        return badRequest(c, 'to field is required')
      }
      if (!body.subject || typeof body.subject !== 'string') {
        return badRequest(c, 'subject field is required')
      }
      if (!body.text || typeof body.text !== 'string') {
        return badRequest(c, 'text field is required')
      }

      const fromDomain = body.from.split('@')[1]
      if (!fromDomain || !EMAIL_CONFIG.VALID_DOMAINS.includes(fromDomain as 'hadoku.me')) {
        return badRequest(
          c,
          `from address must be from one of: ${EMAIL_CONFIG.VALID_DOMAINS.join(', ')}`
        )
      }

      if (!VALIDATION_CONSTRAINTS.EMAIL_REGEX.test(body.to)) {
        return badRequest(c, 'Invalid recipient email address')
      }

      const providerName = c.env.EMAIL_PROVIDER ?? 'resend'
      const emailProvider = createEmailProvider(providerName, c.env.RESEND_API_KEY)

      const effectiveReplyTo = typeof body.replyTo === 'string' ? body.replyTo : body.from

      const result = await emailProvider.sendEmail({
        from: body.from,
        to: body.to,
        subject: body.subject,
        text: body.text,
        replyTo: effectiveReplyTo
      })

      if (!result.success) {
        console.error('Email sending failed:', result.error)
        return serverError(c, result.error ?? 'Failed to send email')
      }

      const auth = c.get('authContext')
      const adminIdentifier = auth?.credential ?? 'admin'

      const contactId = typeof body.contactId === 'string' ? body.contactId : undefined

      await addToWhitelist(
        c.env.DB,
        body.to,
        adminIdentifier,
        contactId,
        'Auto-whitelisted after admin reply'
      )

      return adminOk(c, {
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
        whitelisted: true
      })
    } catch (error) {
      console.error('Error sending email:', error)
      return serverError(c, 'Failed to send email')
    }
  })

  app.get('/whitelist', async c => {
    try {
      const emails = await getAllWhitelistedEmails(c.env.DB)

      return adminOk(c, {
        emails,
        total: emails.length
      })
    } catch (error) {
      console.error('Error fetching whitelist:', error)
      return serverError(c, 'Failed to fetch whitelist')
    }
  })

  app.post('/whitelist', async c => {
    try {
      const body = await c.req.json()

      if (!body.email || typeof body.email !== 'string') {
        return badRequest(c, 'email field is required')
      }

      if (!VALIDATION_CONSTRAINTS.EMAIL_REGEX.test(body.email)) {
        return badRequest(c, 'Invalid email address')
      }

      const auth = c.get('authContext')
      const adminIdentifier = auth?.credential ?? 'admin'

      const success = await addToWhitelist(
        c.env.DB,
        body.email,
        adminIdentifier,
        typeof body.contactId === 'string' ? body.contactId : undefined,
        typeof body.notes === 'string' ? body.notes : 'Manually added by admin'
      )

      if (!success) {
        return serverError(c, 'Failed to add email to whitelist')
      }

      return adminOk(c, {
        success: true,
        message: `Email ${body.email} added to whitelist`,
        email: body.email.toLowerCase()
      })
    } catch (error) {
      console.error('Error adding to whitelist:', error)
      return serverError(c, 'Failed to add to whitelist')
    }
  })

  app.delete('/whitelist/:email', async c => {
    try {
      const email = c.req.param('email')

      if (!email) {
        return badRequest(c, 'Email parameter is required')
      }

      const success = await removeFromWhitelist(c.env.DB, email)

      if (!success) {
        return notFound(c, 'Email not found in whitelist')
      }

      return adminOk(c, {
        success: true,
        message: `Email ${email} removed from whitelist`
      })
    } catch (error) {
      console.error('Error removing from whitelist:', error)
      return serverError(c, 'Failed to remove from whitelist')
    }
  })

  return app
}
