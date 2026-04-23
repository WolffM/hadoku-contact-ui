import { describe, it, expect, vi } from 'vitest'
import {
  maybeForwardInboundEmail,
  parsePickleballWaitlistSubject
} from '../../routes/inbound-forwarders'
import type { ContactEnv } from '../../types'

function makeEnv(overrides: Partial<ContactEnv> = {}): ContactEnv {
  return {
    DB: {} as D1Database,
    RATE_LIMIT_KV: {} as KVNamespace,
    TEMPLATES_KV: {} as KVNamespace,
    SCRAPER_API_URL: 'https://scraper.hadoku.me',
    SCRAPER_API_KEY: 'secret-key',
    ...overrides
  } as ContactEnv
}

describe('maybeForwardInboundEmail', () => {
  it('returns { handled: false } for non-forwarded recipients', async () => {
    const env = makeEnv()
    const result = await maybeForwardInboundEmail(env, {
      recipient: 'matthaeus@hadoku.me',
      senderEmail: 'alice@example.com',
      subject: 'hello',
      body: 'hi',
      emailId: 'e1'
    })
    expect(result.handled).toBe(false)
  })

  it('forwards pickleball waitlist to scraper with bearer auth', async () => {
    const env = makeEnv()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 202 }))
    const result = await maybeForwardInboundEmail(
      env,
      {
        recipient: 'pickleball-waitlist@hadoku.me',
        senderEmail: 'noreply@pickleballkingdom.com',
        subject: 'A spot opened up',
        body: 'Visit https://pickleballkingdom.podplay.app/community/events/abc-123 to register',
        emailId: 'e2'
      },
      fetchMock as unknown as typeof fetch
    )

    expect(result.handled).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(202)
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://scraper.hadoku.me/api/v1/pickleball/waitlist-trigger')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-key')
    expect(headers['X-Hadoku-Forward-Recipient']).toBe('pickleball-waitlist@hadoku.me')
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(body.email_from).toBe('noreply@pickleballkingdom.com')
    expect(body.email_subject).toBe('A spot opened up')
    expect(body.event_url).toBe('https://pickleballkingdom.podplay.app/community/events/abc-123')
  })

  it('handles recipient case-insensitively', async () => {
    const env = makeEnv()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
    const result = await maybeForwardInboundEmail(
      env,
      {
        recipient: 'Pickleball-Waitlist@HADOKU.ME',
        senderEmail: 'x@y.com',
        subject: 's',
        body: null,
        emailId: 'e3'
      },
      fetchMock as unknown as typeof fetch
    )
    expect(result.handled).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('marks handled but not ok when scraper config is missing', async () => {
    const env = makeEnv({ SCRAPER_API_URL: undefined, SCRAPER_API_KEY: undefined })
    const fetchMock = vi.fn()
    const result = await maybeForwardInboundEmail(
      env,
      {
        recipient: 'pickleball-waitlist@hadoku.me',
        senderEmail: 'x@y.com',
        subject: 's',
        body: null,
        emailId: 'e4'
      },
      fetchMock as unknown as typeof fetch
    )
    expect(result.handled).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('forward_target_not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('captures error when fetch rejects', async () => {
    const env = makeEnv()
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await maybeForwardInboundEmail(
      env,
      {
        recipient: 'pickleball-waitlist@hadoku.me',
        senderEmail: 'x@y.com',
        subject: 's',
        body: null,
        emailId: 'e5'
      },
      fetchMock as unknown as typeof fetch
    )
    expect(result.handled).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('network down')
  })

  it('omits event_url when no podplay link is present', async () => {
    const env = makeEnv()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
    await maybeForwardInboundEmail(
      env,
      {
        recipient: 'pickleball-waitlist@hadoku.me',
        senderEmail: 'x@y.com',
        subject: 'spot opened',
        body: 'go sign up now',
        emailId: 'e6'
      },
      fetchMock as unknown as typeof fetch
    )
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.event_url).toBeNull()
  })

  it('parses event name + weekday from real waitlist subject and posts as hints', async () => {
    const env = makeEnv()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
    await maybeForwardInboundEmail(
      env,
      {
        recipient: 'pickleball-waitlist@hadoku.me',
        senderEmail: 'info@podplay.app',
        subject: 'Open Play - Social / Low Intermediate (Tuesday, January 20) has a new open spot!',
        body: 'We\u2019re notifying you since you joined the waitlist.',
        emailId: 'e7'
      },
      fetchMock as unknown as typeof fetch
    )
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.event_name_hint).toBe('Open Play - Social / Low Intermediate')
    expect(body.weekday_hint).toBe('Tuesday')
    expect(body.date_hint).toBe('January 20')
    expect(body.event_url).toBeNull()
  })
})

describe('parsePickleballWaitlistSubject', () => {
  it('parses the Social / Low Intermediate sample', () => {
    const parsed = parsePickleballWaitlistSubject(
      'Open Play - Social / Low Intermediate (Tuesday, January 20) has a new open spot!'
    )
    expect(parsed.eventName).toBe('Open Play - Social / Low Intermediate')
    expect(parsed.weekday).toBe('Tuesday')
    expect(parsed.dateText).toBe('January 20')
  })

  it('parses the Intermediate - RED sample', () => {
    const parsed = parsePickleballWaitlistSubject(
      'Open Play - Intermediate - RED (Wednesday, December 17) has a new open spot!'
    )
    expect(parsed.eventName).toBe('Open Play - Intermediate - RED')
    expect(parsed.weekday).toBe('Wednesday')
    expect(parsed.dateText).toBe('December 17')
  })

  it('is tolerant of missing exclamation point', () => {
    const parsed = parsePickleballWaitlistSubject(
      'Open Play - Beginners (Friday, March 5) has a new open spot'
    )
    expect(parsed.eventName).toBe('Open Play - Beginners')
    expect(parsed.weekday).toBe('Friday')
  })

  it('returns null fields for unrelated subjects', () => {
    const parsed = parsePickleballWaitlistSubject('Your Pickleball Kingdom receipt')
    expect(parsed.eventName).toBeNull()
    expect(parsed.weekday).toBeNull()
    expect(parsed.dateText).toBeNull()
  })
})
