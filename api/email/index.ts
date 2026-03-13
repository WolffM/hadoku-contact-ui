/**
 * Email service factory
 */

import type { EmailProvider } from './provider'
import { MailChannelsProvider } from './mailchannels'
import { ResendProvider } from './resend'

export type { EmailProvider, EmailParams, EmailResponse } from './provider'

export function createEmailProvider(providerName = 'resend', apiKey?: string): EmailProvider {
  switch (providerName.toLowerCase()) {
    case 'resend':
      if (!apiKey) {
        throw new Error('RESEND_API_KEY is required for Resend provider')
      }
      return new ResendProvider(apiKey)
    case 'mailchannels':
      return new MailChannelsProvider()
    default:
      console.warn(`Unknown email provider: ${providerName}, falling back to Resend`)
      if (!apiKey) {
        throw new Error('RESEND_API_KEY is required')
      }
      return new ResendProvider(apiKey)
  }
}
