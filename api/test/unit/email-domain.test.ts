/**
 * checkEmailDomain: does an address's domain receive mail?
 *
 * The answers below are the shapes Cloudflare's DoH JSON API returned on
 * 2026-11-22 for the domains named: `foreet-ai.org` (NXDOMAIN, the 11-21 typo),
 * `forest-ai.org` (a real MX) and `example.com` (RFC 7505 null MX).
 */
import { describe, it, expect } from 'vitest'
import { checkEmailDomain, DOH_URL } from '../../services/email-domain'

type Answers = Record<string, { Status: number; Answer?: { type: number; data: string }[] }>

/** A fetcher that answers DoH queries from a table keyed `name/TYPE`. */
function doh(answers: Answers) {
  const asked: string[] = []
  const fetcher = (url: string) => {
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe(DOH_URL)
    const key = `${u.searchParams.get('name')}/${u.searchParams.get('type')}`
    asked.push(key)
    const body = answers[key]
    if (!body) throw new Error(`unexpected DoH query ${key}`)
    return Promise.resolve(Response.json(body))
  }
  return { fetcher, asked }
}

describe('checkEmailDomain', () => {
  it('refuses a domain that does not exist (NXDOMAIN)', async () => {
    const { fetcher } = doh({ 'foreet-ai.org/MX': { Status: 3 } })
    expect(await checkEmailDomain('ruben@foreet-ai.org', fetcher)).toEqual({
      status: 'nonexistent',
      domain: 'foreet-ai.org'
    })
  })

  it('accepts a domain with a real MX, asking nothing else', async () => {
    const { fetcher, asked } = doh({
      'forest-ai.org/MX': { Status: 0, Answer: [{ type: 15, data: '1 smtp.google.com.' }] }
    })
    expect(await checkEmailDomain('ruben@forest-ai.org', fetcher)).toEqual({ status: 'ok' })
    expect(asked).toEqual(['forest-ai.org/MX'])
  })

  it('refuses a null MX (RFC 7505)', async () => {
    const { fetcher } = doh({
      'example.com/MX': { Status: 0, Answer: [{ type: 15, data: '0 .' }] }
    })
    expect(await checkEmailDomain('a@example.com', fetcher)).toEqual({
      status: 'no_mail',
      domain: 'example.com'
    })
  })

  it('reads MX records past a CNAME in the answer', async () => {
    const { fetcher } = doh({
      'alias.test/MX': {
        Status: 0,
        Answer: [
          { type: 5, data: 'real.test.' },
          { type: 15, data: '10 mx.real.test.' }
        ]
      }
    })
    expect(await checkEmailDomain('a@alias.test', fetcher)).toEqual({ status: 'ok' })
  })

  it('accepts an implicit MX: no MX, but an A record', async () => {
    const { fetcher } = doh({
      'plain.test/MX': { Status: 0 },
      'plain.test/A': { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] }
    })
    expect(await checkEmailDomain('a@plain.test', fetcher)).toEqual({ status: 'ok' })
  })

  it('accepts an implicit MX on AAAA alone', async () => {
    const { fetcher } = doh({
      'v6.test/MX': { Status: 0 },
      'v6.test/A': { Status: 0 },
      'v6.test/AAAA': { Status: 0, Answer: [{ type: 28, data: '2001:db8::1' }] }
    })
    expect(await checkEmailDomain('a@v6.test', fetcher)).toEqual({ status: 'ok' })
  })

  it('refuses a domain with no MX, A or AAAA', async () => {
    const { fetcher } = doh({
      'bare.test/MX': { Status: 0 },
      'bare.test/A': { Status: 0 },
      'bare.test/AAAA': { Status: 0 }
    })
    expect(await checkEmailDomain('a@bare.test', fetcher)).toEqual({
      status: 'no_mail',
      domain: 'bare.test'
    })
  })

  it('lowercases the domain it asks about', async () => {
    const { fetcher, asked } = doh({
      'forest-ai.org/MX': { Status: 0, Answer: [{ type: 15, data: '1 smtp.google.com.' }] }
    })
    await checkEmailDomain('Ruben@Forest-AI.org', fetcher)
    expect(asked).toEqual(['forest-ai.org/MX'])
  })

  it('fails open on SERVFAIL', async () => {
    const { fetcher } = doh({ 'flaky.test/MX': { Status: 2 } })
    expect(await checkEmailDomain('a@flaky.test', fetcher)).toEqual({
      status: 'unknown',
      domain: 'flaky.test',
      error: 'MX rcode 2'
    })
  })

  it('fails open when the resolver is unreachable', async () => {
    const fetcher = () => Promise.reject(new Error('connection refused'))
    expect(await checkEmailDomain('a@any.test', fetcher)).toEqual({
      status: 'unknown',
      domain: 'any.test',
      error: 'connection refused'
    })
  })

  it('fails open on a non-2xx from the resolver', async () => {
    const fetcher = () => Promise.resolve(new Response('busy', { status: 503 }))
    expect(await checkEmailDomain('a@any.test', fetcher)).toEqual({
      status: 'unknown',
      domain: 'any.test',
      error: 'DoH MX HTTP 503'
    })
  })
})
