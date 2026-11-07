/**
 * The tier ladder (`TIER_RANK`) and the two functions built on it:
 * `createEdgeAuth` (which decides what `X-Hadoku-Tier` becomes) and
 * `tierAtLeast` (the only rank comparison every route gate uses).
 *
 * `member` was missing from the ladder until 2026-11-06 (hadoku_site#523).
 * `TIERS.has('member')` was then false, so `createEdgeAuth` silently rewrote
 * a provenance-trusted member caller to `public` — see the comment on
 * `TIER_RANK` in ../../utils/auth.ts. Nothing here floors below `service`, so
 * a member was refused either way; what was wrong was the mislabeling, not
 * the admission.
 */
import { Hono } from 'hono'
import { describe, it, expect } from 'vitest'
import { createEdgeAuth, tierAtLeast, TIER_RANK } from '../../utils/auth'
import type { AppContext, HadokuAuthContext } from '../../types'

const EDGE_SECRET = 'test-edge-secret'

function appWithEdgeAuth() {
  const app = new Hono<AppContext>()
  app.use('*', createEdgeAuth())
  app.get('/whoami', c => c.json(c.get('authContext')))
  return app
}

async function whoami(tier: string | undefined, { trusted = true } = {}) {
  const app = appWithEdgeAuth()
  const headers: Record<string, string> = {}
  if (trusted) headers['X-Edge-Auth'] = EDGE_SECRET
  if (tier !== undefined) headers['X-Hadoku-Tier'] = tier
  const res = await app.request('/whoami', { headers }, { EDGE_AUTH_SECRET: EDGE_SECRET })
  return (await res.json()) as HadokuAuthContext
}

describe('the ladder', () => {
  it('is the platform ladder, member between public and friend', () => {
    expect(TIER_RANK).toEqual({
      public: 0,
      member: 1,
      friend: 2,
      service: 3,
      wife: 4,
      admin: 5
    })
  })
})

describe('createEdgeAuth', () => {
  it('passes a provenance-trusted member through as member, not public', async () => {
    const auth = await whoami('member')
    expect(auth.userType).toBe('member')
  })

  it('still passes every other known tier through unchanged', async () => {
    // Derived from the ladder rather than hand-typed, so a tier added to it
    // is covered here with no edit to this test. public and member are
    // asserted on their own above, since public isn't passed-through-as-is
    // (there's nothing to compare it to) and member is the new case.
    for (const tier of Object.keys(TIER_RANK).filter(t => t !== 'public' && t !== 'member')) {
      expect((await whoami(tier)).userType).toBe(tier)
    }
  })

  it('still rewrites a name the ladder does not know to public', async () => {
    expect((await whoami('superuser')).userType).toBe('public')
  })

  it('still rewrites ANY tier to public without edge provenance', async () => {
    expect((await whoami('admin', { trusted: false })).userType).toBe('public')
    expect((await whoami('member', { trusted: false })).userType).toBe('public')
  })

  it('defaults to public with no X-Hadoku-Tier header at all', async () => {
    expect((await whoami(undefined)).userType).toBe('public')
  })
})

describe('tierAtLeast', () => {
  it('admits a tier at or above the floor and nothing below it', () => {
    expect(tierAtLeast({ userType: 'member' }, 'member')).toBe(true)
    expect(tierAtLeast({ userType: 'friend' }, 'member')).toBe(true)
    expect(tierAtLeast({ userType: 'admin' }, 'member')).toBe(true)
    expect(tierAtLeast({ userType: 'public' }, 'member')).toBe(false)
  })

  // The admission this whole fix is about: a member must not clear a floor it
  // could not clear before the ladder knew it. Every real route here floors at
  // service or admin, both above member.
  it('a member is refused at the service and admin floors, exactly like before', () => {
    expect(tierAtLeast({ userType: 'member' }, 'service')).toBe(false)
    expect(tierAtLeast({ userType: 'member' }, 'admin')).toBe(false)
  })

  it('member outranks public and is outranked by friend', () => {
    expect(tierAtLeast({ userType: 'member' }, 'public')).toBe(true)
    expect(tierAtLeast({ userType: 'public' }, 'member')).toBe(false)
    expect(tierAtLeast({ userType: 'friend' }, 'member')).toBe(true)
  })

  it('an unknown or absent tier clears no floor above public', () => {
    expect(tierAtLeast({ userType: 'superuser' }, 'member')).toBe(false)
    expect(tierAtLeast(undefined, 'member')).toBe(false)
    expect(tierAtLeast({}, 'member')).toBe(false)
  })
})
