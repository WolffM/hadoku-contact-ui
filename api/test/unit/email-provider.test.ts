/**
 * Email Provider Factory Tests
 *
 * Pure unit tests — no D1/KV needed. Tests the factory pattern
 * for creating email providers.
 */
import { describe, it, expect } from 'vitest'
import { createEmailProvider } from '../../email'
import { ResendProvider } from '../../email/resend'
import { MailChannelsProvider } from '../../email/mailchannels'

describe('Email Provider Factory', () => {
  const testApiKey = 'test-api-key'

  it('should create Resend provider by default', () => {
    const provider = createEmailProvider('resend', testApiKey)
    expect(provider).toBeInstanceOf(ResendProvider)
  })

  it('should create MailChannels provider when specified', () => {
    const provider = createEmailProvider('mailchannels')
    expect(provider).toBeInstanceOf(MailChannelsProvider)
  })

  it('should throw error for Resend without API key', () => {
    expect(() => createEmailProvider('resend')).toThrow('RESEND_API_KEY is required')
  })

  it('should fall back to Resend for unknown providers', () => {
    const provider = createEmailProvider('unknown-provider', testApiKey)
    expect(provider).toBeInstanceOf(ResendProvider)
  })

  it('should be case-insensitive', () => {
    const provider = createEmailProvider('RESEND', testApiKey)
    expect(provider).toBeInstanceOf(ResendProvider)
  })
})
