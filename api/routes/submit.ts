/**
 * Contact form submission endpoint
 */

import { Hono } from 'hono'
import {
  validateContactSubmission,
  validateAppointment,
  extractClientIP,
  extractReferrer,
  validateReferrer
} from '../validation'
import {
  createSubmission,
  isEmailWhitelisted,
  addToWhitelist,
  createAppointment,
  isSlotAvailable,
  getAppointmentsByDate,
  getAppointmentConfig,
  getEmailTemplate
} from '../storage'
import { checkRateLimit, recordSubmission } from '../rate-limit'
import { generateMeetingLink } from '../services/meeting-links'
import { createEmailProvider } from '../email'
import {
  formatAppointmentConfirmation,
  formatAppointmentDateTime,
  renderTemplate,
  prepareAppointmentTemplateData
} from '../email/templates'
import { EMAIL_CONFIG, APPOINTMENT_CONFIG, RATE_LIMIT_CONFIG } from '../constants'
import {
  logRateLimitHit,
  logRateLimitWarning,
  logEmailSent,
  logEmailFailed,
  logAppointmentBooked,
  logAppointmentConflict,
  logSubmissionCreated
} from '../telemetry'

function hashIP(ip: string): string {
  let hash = 0
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

function isPublicRecipient(recipient: string | undefined): boolean {
  if (!recipient) return false
  return EMAIL_CONFIG.PUBLIC_RECIPIENTS.includes(
    recipient.toLowerCase() as (typeof EMAIL_CONFIG.PUBLIC_RECIPIENTS)[number]
  )
}

interface Env {
  DB: D1Database
  RATE_LIMIT_KV: KVNamespace
  TEMPLATES_KV: KVNamespace
  ANALYTICS_ENGINE?: AnalyticsEngineDataset
  EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
}

export function createSubmitRoutes(rateLimitOverrides?: {
  maxSubmissionsPerHour?: number
  windowDurationSeconds?: number
}) {
  const app = new Hono<{ Bindings: Env }>()

  app.post('/submit', async c => {
    const db = c.env.DB
    const kv = c.env.RATE_LIMIT_KV
    const request = c.req.raw

    try {
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ success: false, message: 'Invalid JSON in request body' }, 400)
      }

      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
      const recipient =
        typeof body.recipient === 'string' ? body.recipient.trim().toLowerCase() : undefined

      const isPublicMailbox = isPublicRecipient(recipient)
      const isWhitelisted = email ? await isEmailWhitelisted(db, email) : false

      if (!isPublicMailbox && !isWhitelisted && !validateReferrer(request)) {
        return c.json({ success: false, message: 'Invalid referrer' }, 400)
      }

      const ipAddress = extractClientIP(request)
      if (!ipAddress) {
        console.error('Could not extract client IP')
        return c.json({ success: false, message: 'Could not identify client' }, 400)
      }

      const rateLimitResult = await checkRateLimit(kv, ipAddress, rateLimitOverrides)
      if (!rateLimitResult.allowed) {
        logRateLimitHit(c.env, hashIP(ipAddress), rateLimitResult.remaining, '/submit')

        return c.json(
          {
            success: false,
            error: 'Rate limit exceeded',
            message: rateLimitResult.reason,
            retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
          },
          429,
          {
            'X-RateLimit-Limit': (
              rateLimitOverrides?.maxSubmissionsPerHour ??
              RATE_LIMIT_CONFIG.MAX_SUBMISSIONS_PER_HOUR
            ).toString(),
            'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
            'X-RateLimit-Reset': rateLimitResult.resetAt.toString()
          }
        )
      }

      if (rateLimitResult.remaining <= 1) {
        logRateLimitWarning(c.env, hashIP(ipAddress), rateLimitResult.remaining, '/submit')
      }

      const validation = validateContactSubmission(body)
      if (!validation.valid) {
        return c.json(
          {
            success: false,
            error: 'Validation failed',
            errors: validation.errors
          },
          400
        )
      }

      const sanitized = validation.sanitized
      if (!sanitized) {
        return c.json({ success: false, message: 'Validation failed' }, 400)
      }

      const userAgent = request.headers.get('User-Agent')
      const referrer = extractReferrer(request)

      const submission = await createSubmission(db, {
        name: sanitized.name,
        email: sanitized.email,
        message: sanitized.message,
        recipient: sanitized.recipient,
        ip_address: ipAddress,
        user_agent: userAgent,
        referrer
      })

      await recordSubmission(kv, ipAddress, rateLimitOverrides)

      logSubmissionCreated(c.env, sanitized.recipient || 'default')

      if (!isWhitelisted) {
        await addToWhitelist(
          db,
          sanitized.email,
          'auto-whitelist',
          submission.id,
          'Auto-whitelisted after contact form submission'
        )
      }

      if (body.appointment) {
        const appointmentValidation = validateAppointment(body.appointment)
        if (!appointmentValidation.valid) {
          return c.json(
            {
              success: false,
              error: 'Appointment validation failed',
              errors: appointmentValidation.errors
            },
            400
          )
        }

        const appointmentData = appointmentValidation.sanitized
        if (!appointmentData) {
          return c.json(
            {
              success: false,
              error: 'Appointment validation failed',
              errors: ['Invalid appointment data']
            },
            400
          )
        }

        const slotAvailable = await isSlotAvailable(db, appointmentData.slotId)

        if (!slotAvailable) {
          logAppointmentConflict(c.env, appointmentData.slotId)

          const updatedSlots = await getAppointmentsByDate(db, appointmentData.date)

          return c.json(
            {
              success: false,
              message: 'This time slot was just booked by someone else',
              conflict: {
                reason: 'slot_taken',
                updatedSlots: updatedSlots
                  .filter(s => s.status === 'confirmed')
                  .map(s => ({
                    id: s.slot_id,
                    startTime: s.start_time,
                    endTime: s.end_time,
                    available: false
                  }))
              }
            },
            409
          )
        }

        const meetingLinkResult = generateMeetingLink(
          appointmentData.platform,
          {
            slotId: appointmentData.slotId,
            name: sanitized.name,
            email: sanitized.email,
            startTime: appointmentData.startTime,
            endTime: appointmentData.endTime,
            message: sanitized.message
          },
          c.env
        )

        const config = await getAppointmentConfig(db)
        const timezone = config?.timezone ?? APPOINTMENT_CONFIG.DEFAULT_TIMEZONE

        const appointment = await createAppointment(db, {
          submission_id: submission.id,
          name: sanitized.name,
          email: sanitized.email,
          message: sanitized.message,
          slot_id: appointmentData.slotId,
          date: appointmentData.date,
          start_time: appointmentData.startTime,
          end_time: appointmentData.endTime,
          duration: appointmentData.duration,
          timezone,
          platform: appointmentData.platform,
          meeting_link: meetingLinkResult.success ? meetingLinkResult.meetingLink : undefined,
          meeting_id: meetingLinkResult.success ? meetingLinkResult.meetingId : undefined,
          ip_address: ipAddress ?? undefined,
          user_agent: userAgent ?? undefined
        })

        try {
          const providerName = c.env.EMAIL_PROVIDER ?? 'resend'
          const emailProvider = createEmailProvider(providerName, c.env.RESEND_API_KEY)

          const formattedDateTime = formatAppointmentDateTime(
            appointmentData.date,
            appointmentData.startTime,
            appointmentData.endTime,
            timezone
          )

          const templateData = prepareAppointmentTemplateData({
            recipientName: sanitized.name,
            recipientEmail: sanitized.email,
            appointmentDate: formattedDateTime.date,
            startTime: formattedDateTime.startTime,
            endTime: formattedDateTime.endTime,
            timezone,
            duration: appointmentData.duration,
            platform: appointmentData.platform,
            meetingLink: meetingLinkResult.success ? meetingLinkResult.meetingLink : undefined,
            message: sanitized.message
          })

          const storedTemplate = await getEmailTemplate(
            db,
            c.env.TEMPLATES_KV,
            'appointment_confirmation',
            'en'
          )

          let subject: string
          let text: string

          if (storedTemplate) {
            subject = renderTemplate(storedTemplate.subject ?? '', templateData)
            text = renderTemplate(storedTemplate.body, templateData)
          } else {
            const emailContent = formatAppointmentConfirmation({
              recipientName: sanitized.name,
              recipientEmail: sanitized.email,
              appointmentDate: formattedDateTime.date,
              startTime: formattedDateTime.startTime,
              endTime: formattedDateTime.endTime,
              timezone,
              duration: appointmentData.duration,
              platform: appointmentData.platform,
              meetingLink: meetingLinkResult.success ? meetingLinkResult.meetingLink : undefined,
              message: sanitized.message
            })
            subject = emailContent.subject
            text = emailContent.text
          }

          const emailResult = await emailProvider.sendEmail({
            from: EMAIL_CONFIG.DEFAULT_FROM,
            to: sanitized.email,
            subject,
            text,
            replyTo: EMAIL_CONFIG.DEFAULT_FROM
          })

          if (!emailResult.success) {
            console.error('Failed to send appointment confirmation email:', emailResult.error)
            logEmailFailed(c.env, 'appointment_confirmation', emailResult.error || 'Unknown error')
          } else {
            console.log(
              `Appointment confirmation email sent to ${sanitized.email} (${emailResult.messageId})`
            )
            const recipientDomain = sanitized.email.split('@')[1] || 'unknown'
            logEmailSent(c.env, 'appointment_confirmation', recipientDomain)
          }
        } catch (emailError) {
          console.error('Error sending appointment confirmation email:', emailError)
          logEmailFailed(
            c.env,
            'appointment_confirmation',
            emailError instanceof Error ? emailError.message : 'Unknown error'
          )
        }

        logAppointmentBooked(c.env, appointmentData.platform, appointmentData.duration)

        return c.json(
          {
            success: true,
            id: submission.id,
            appointmentId: appointment.id,
            message: 'Your message has been sent and appointment booked!',
            meetingLink: meetingLinkResult.success ? meetingLinkResult.meetingLink : undefined
          },
          201
        )
      }

      return c.json(
        {
          success: true,
          id: submission.id,
          message: 'Message submitted successfully'
        },
        201
      )
    } catch (error) {
      console.error('Error processing contact submission:', error)
      return c.json({ success: false, message: 'Failed to process submission' }, 500)
    }
  })

  return app
}
