/**
 * The submit route refuses an address whose domain cannot receive mail, and
 * reports it to service_events through edge-router.
 *
 * The suite's config turns the check off (its fixtures use example.com, a null
 * MX), so these tests call the worker directly with an env that turns it back
 * on, a fake EDGE_ROUTER binding that records what telemetry posts, and the
 * DoH resolver mocked.
 */
import { env, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import worker from '../../test-entry'
import type { ContactEnv } from '../../types'

interface Posted {
  url: string
  key: string | null
  body: { level: string; message: string; context: Record<string, unknown> }
}

function edgeRouter() {
  const posted: Posted[] = []
  const binding = {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      posted.push({
        url: req.url,
        key: req.headers.get('X-User-Key'),
        body: (await req.json()) as Posted['body']
      })
      return Response.json({ success: true })
    }
  } as unknown as Fetcher
  return { binding, posted }
}

function mockDoh(name: string, type: string, body: unknown) {
  fetchMock
    .get('https://cloudflare-dns.com')
    .intercept({ path: `/dns-query?name=${name}&type=${type}`, method: 'GET' })
    .reply(200, JSON.stringify(body), { headers: { 'Content-Type': 'application/dns-json' } })
}

async function submit(email: string, router: Fetcher) {
  const ctx = createExecutionContext()
  const testEnv: ContactEnv = {
    ...(env as unknown as ContactEnv),
    EMAIL_DOMAIN_CHECK: undefined,
    HADOKU_SERVICE_KEY: 'contact-service-key',
    EDGE_ROUTER: router
  }
  const res = await worker.fetch(
    new Request('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.77',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Ruben',
        email,
        message: 'Recruiting',
        recipient: 'matthaeus@hadoku.me'
      })
    }),
    testEnv,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('email domain check on submit', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('refuses a domain that does not exist, names the field, and stores nothing', async () => {
    mockDoh('foreet-ai.org', 'MX', { Status: 3 })
    const router = edgeRouter()

    const res = await submit('ruben@foreet-ai.org', router.binding)

    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; field: string; message: string }
    expect(body.success).toBe(false)
    expect(body.field).toBe('email')
    expect(body.message).toContain('foreet-ai.org does not exist')

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM contact_submissions').first<{
      n: number
    }>()
    expect(rows!.n).toBe(0)
    const whitelisted = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_whitelist').first<{
      n: number
    }>()
    expect(whitelisted!.n).toBe(0)

    // Reported to service_events, through edge-router, as this worker's key.
    expect(router.posted).toHaveLength(1)
    const [event] = router.posted
    expect(event.url).toBe('https://hadoku.me/health/api/telemetry')
    expect(event.key).toBe('contact-service-key')
    expect(event.body.level).toBe('warn')
    expect(event.body.message).toBe('event=contact.email_domain_rejected nonexistent foreet-ai.org')
    expect(event.body.context.service).toBe('contact')
  })

  it('refuses a null-MX domain', async () => {
    mockDoh('example.com', 'MX', { Status: 0, Answer: [{ type: 15, data: '0 .' }] })
    const res = await submit('someone@example.com', edgeRouter().binding)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { message: string }
    expect(body.message).toContain('example.com does not accept email')
  })

  it('accepts a domain with a real MX', async () => {
    mockDoh('forest-ai.org', 'MX', {
      Status: 0,
      Answer: [{ type: 15, data: '1 smtp.google.com.' }]
    })
    const router = edgeRouter()
    const res = await submit('ruben@forest-ai.org', router.binding)
    expect(res.status).toBe(201)
    expect(router.posted.map(p => p.body.message)).toEqual([
      'event=contact.submit_created matthaeus@hadoku.me'
    ])
  })

  it('lets the submission through when the resolver fails, and says so', async () => {
    mockDoh('forest-ai.org', 'MX', { Status: 2 })
    const router = edgeRouter()
    const res = await submit('ruben@forest-ai.org', router.binding)
    expect(res.status).toBe(201)
    expect(router.posted.map(p => p.body.message)).toContain(
      'event=contact.email_domain_unverified forest-ai.org MX rcode 2'
    )
  })

  it('skips the lookup for a whitelisted sender', async () => {
    await env.DB.prepare(
      `INSERT INTO email_whitelist (email, whitelisted_at, whitelisted_by) VALUES (?, ?, 'test')`
    )
      .bind('ruben@forest-ai.org', Date.now())
      .run()
    // No DoH interceptor, so a lookup would fail and fail open: the absence of
    // the unverified event is what proves none was made.
    const router = edgeRouter()
    const res = await submit('ruben@forest-ai.org', router.binding)
    expect(res.status).toBe(201)
    expect(router.posted.map(p => p.body.message)).toEqual([
      'event=contact.submit_created matthaeus@hadoku.me'
    ])
  })
})
