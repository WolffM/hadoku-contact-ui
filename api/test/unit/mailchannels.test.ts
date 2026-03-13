/**
 * MailChannels Provider Tests
 *
 * Tests the MailChannels email provider using fetchMock
 * instead of mocking global.fetch.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MailChannelsProvider } from '../../email/mailchannels'

describe('MailChannels Provider', () => {
  let provider: MailChannelsProvider

  beforeEach(() => {
    provider = new MailChannelsProvider()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.deactivate()
  })

  it('should send email successfully', async () => {
    fetchMock
      .get('https://api.mailchannels.net')
      .intercept({ path: '/tx/v1/send', method: 'POST' })
      .reply(202, 'Accepted')

    const result = await provider.sendEmail({
      from: 'test@hadoku.me',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      text: 'Test message'
    })

    expect(result.success).toBe(true)
    expect(result.messageId).toBeDefined()
    expect(result.messageId).toContain('mailchannels-')
  })

  it('should handle API errors', async () => {
    fetchMock
      .get('https://api.mailchannels.net')
      .intercept({ path: '/tx/v1/send', method: 'POST' })
      .reply(400, 'Bad Request: Invalid email format')

    const result = await provider.sendEmail({
      from: 'test@hadoku.me',
      to: 'invalid-email',
      subject: 'Test',
      text: 'Test'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('MailChannels API error')
    expect(result.error).toContain('400')
  })

  it('should handle network errors', async () => {
    fetchMock
      .get('https://api.mailchannels.net')
      .intercept({ path: '/tx/v1/send', method: 'POST' })
      .replyWithError(new Error('Network error'))

    const result = await provider.sendEmail({
      from: 'test@hadoku.me',
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'Test'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Network error')
  })
})
