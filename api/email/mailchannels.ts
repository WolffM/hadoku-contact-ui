/**
 * MailChannels email provider implementation
 * Free for Cloudflare Workers, no API key required
 */

import type { EmailProvider, EmailParams, EmailResponse } from './provider'

export class MailChannelsProvider implements EmailProvider {
  async sendEmail(params: EmailParams): Promise<EmailResponse> {
    try {
      const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [{ email: params.to }],
              ...(params.replyTo && {
                reply_to: { email: params.replyTo }
              })
            }
          ],
          from: {
            email: params.from,
            name: 'Hadoku Mail'
          },
          subject: params.subject,
          content: [
            {
              type: 'text/plain',
              value: params.text
            }
          ]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `MailChannels API error: ${response.status} - ${errorText}`
        }
      }

      return {
        success: true,
        messageId: `mailchannels-${Date.now()}`
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  }
}
