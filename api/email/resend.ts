/**
 * Resend email provider implementation
 */

import type { EmailProvider, EmailParams, EmailResponse } from './provider'

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
          from: `Hadoku Mail <${params.from}>`,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          ...(params.replyTo && { reply_to: [params.replyTo] })
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }))
        return {
          success: false,
          error: `Resend API error: ${response.status} - ${errorData.message ?? 'Unknown error'}`
        }
      }

      const data = await response.json()
      return {
        success: true,
        messageId: data.id as string
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
