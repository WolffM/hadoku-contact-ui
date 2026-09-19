/**
 * The grant table's parser, which is the whole access-control decision.
 *
 * Every case here is a MISCONFIGURATION, and every one of them must deny. The
 * routes cannot test these — the binding is fixed for the worker's lifetime —
 * so this file is the only place the fail-closed behaviour is pinned.
 */
import { describe, it, expect } from 'vitest'
import { parseMailfeedScopes, resolveMailfeedScope } from '../../services/mailfeed-scope'

const VALID = JSON.stringify({
  'user-a': { label: 'jobplatform', senderDomains: ['greenhouse.io', 'ashbyhq.com'] }
})

describe('parseMailfeedScopes', () => {
  it('parses a well-formed grant', () => {
    const scopes = parseMailfeedScopes(VALID)
    expect(scopes.get('user-a')).toEqual({
      label: 'jobplatform',
      senderDomains: ['greenhouse.io', 'ashbyhq.com']
    })
  })

  it('lowercases and de-duplicates domains', () => {
    const scopes = parseMailfeedScopes(
      JSON.stringify({ u: { label: 'x', senderDomains: ['Greenhouse.IO', 'greenhouse.io'] } })
    )
    expect(scopes.get('u')?.senderDomains).toEqual(['greenhouse.io'])
  })

  it('returns nothing for an unset binding', () => {
    expect(parseMailfeedScopes(undefined).size).toBe(0)
    expect(parseMailfeedScopes('').size).toBe(0)
    expect(parseMailfeedScopes('   ').size).toBe(0)
  })

  it('returns nothing for unparseable JSON', () => {
    expect(parseMailfeedScopes('{not json').size).toBe(0)
  })

  it('refuses a top-level array or scalar', () => {
    expect(parseMailfeedScopes('[]').size).toBe(0)
    expect(parseMailfeedScopes('"user-a"').size).toBe(0)
  })

  it('drops an entry that names no domains', () => {
    expect(parseMailfeedScopes(JSON.stringify({ u: { label: 'x' } })).size).toBe(0)
    expect(parseMailfeedScopes(JSON.stringify({ u: { label: 'x', senderDomains: [] } })).size).toBe(
      0
    )
  })

  /**
   * The wildcard cases, which are the reason the validation exists at all.
   *
   * `queryMailfeed` builds a LIKE pattern as `'%.' || ?`, so a `%` or `_`
   * reaching the SQL is a wildcard inside the predicate separating this caller
   * from the operator's private mail. `%` alone matches every sender there is.
   */
  it('refuses SQL LIKE metacharacters in a domain', () => {
    for (const domain of ['%', '%.io', 'green_ouse.io', 'green%.io']) {
      expect(parseMailfeedScopes(JSON.stringify({ u: { senderDomains: [domain] } })).size).toBe(0)
    }
  })

  it('refuses a domain with no dot, or with empty labels', () => {
    for (const domain of ['io', '.io', 'greenhouse.', 'green..io', '-greenhouse.io']) {
      expect(parseMailfeedScopes(JSON.stringify({ u: { senderDomains: [domain] } })).size).toBe(0)
    }
  })

  /**
   * One bad domain invalidates the WHOLE entry rather than being skipped.
   *
   * Narrowing a grant to the survivors would leave a feed that still returns
   * mail, so a typo would present as "that sender never writes to us" — the
   * exact silent-miss failure the consumer of this feed exists to detect.
   */
  it('drops the entire entry when any one domain is invalid', () => {
    const scopes = parseMailfeedScopes(
      JSON.stringify({ u: { senderDomains: ['greenhouse.io', '%'] } })
    )
    expect(scopes.size).toBe(0)
  })

  it('falls back to the userId as a label', () => {
    const scopes = parseMailfeedScopes(JSON.stringify({ u: { senderDomains: ['greenhouse.io'] } }))
    expect(scopes.get('u')?.label).toBe('u')
  })
})

describe('resolveMailfeedScope', () => {
  it('admits a listed caller', () => {
    const res = resolveMailfeedScope(VALID, 'user-a')
    expect(res.allowed).toBe(true)
  })

  it('denies when the binding is unset — never opens up', () => {
    expect(resolveMailfeedScope(undefined, 'user-a')).toEqual({
      allowed: false,
      reason: 'not_configured'
    })
  })

  it('denies an unidentified caller', () => {
    expect(resolveMailfeedScope(VALID, null)).toEqual({
      allowed: false,
      reason: 'unidentified_caller'
    })
    expect(resolveMailfeedScope(VALID, '  ')).toEqual({
      allowed: false,
      reason: 'unidentified_caller'
    })
  })

  it('denies a caller that is not listed', () => {
    expect(resolveMailfeedScope(VALID, 'user-b')).toEqual({
      allowed: false,
      reason: 'unconfigured_caller'
    })
  })
})
