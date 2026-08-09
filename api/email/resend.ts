/**
 * Resend email provider implementation
 */

import type { EmailProvider, EmailParams, EmailResponse } from './provider'
import { EMAIL_CONFIG } from '../constants'

/**
 * The two shapes Resend's send endpoint returns.
 *
 * `Response.json()` is typed `unknown` (correctly — it is parsed JSON from the
 * network), so reading `.message` / `.id` off it needs a declared shape. Both
 * fields are optional: the error branch already falls back when Resend answers
 * with something unexpected, and pretending they are guaranteed would move that
 * failure from a fallback string to a runtime undefined.
 */
interface ResendErrorBody {
  message?: string
}

interface ResendSendBody {
  id?: string
}

export class ResendProvider implements EmailProvider {
  constructor(private apiKey: string) {}

  async sendEmail(params: EmailParams): Promise<EmailResponse> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `${params.fromName ?? EMAIL_CONFIG.DEFAULT_FROM_NAME} <${params.from}>`,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          ...(params.replyTo && { reply_to: [params.replyTo] })
        })
      })

      if (!response.ok) {
        const errorData = (await response
          .json()
          .catch(() => ({ message: 'Unknown error' }))) as ResendErrorBody
        return {
          success: false,
          error: `Resend API error: ${response.status} - ${errorData.message ?? 'Unknown error'}`
        }
      }

      const data = (await response.json()) as ResendSendBody
      return {
        success: true,
        messageId: data.id
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        error: `Failed to send email: ${errorMessage}`
      }
    }
  }
}
