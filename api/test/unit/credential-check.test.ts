/**
 * checkCalendarCredential — the three answers it can give.
 *
 * The end-to-end wiring (a dead credential fails the nightly job, and does so
 * only after the retention steps have run) is in
 * e2e/credential-canary.test.ts. What lives here is the configuration
 * branching, which the e2e tests cannot reach: SELF.fetch runs the worker
 * against wrangler.test.toml's bindings, so unsetting a binding on `env` does
 * not change what the worker sees.
 */
import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkCalendarCredential } from '../../services/google-meet'

const CONFIGURED = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'test-refresh-token'
}

describe('checkCalendarCredential — unconfigured', () => {
  // A deployment offering only Jitsi and Discord binds no Google secrets. It
  // must not start failing its nightly job over a feature it never enabled —
  // and it must not make an outbound call to discover that.
  it.each([
    ['nothing bound', {}],
    ['client id only', { GOOGLE_OAUTH_CLIENT_ID: 'x' }],
    ['no refresh token', { GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' }]
  ])('reports configured:false with %s', async (_label, env) => {
    // fetchMock is not activated here: an outbound call would throw, so this
    // also proves the short-circuit happens before any network access.
    const result = await checkCalendarCredential(env)

    expect(result).toEqual({ configured: false })
  })
})

describe('checkCalendarCredential — configured', () => {
  beforeEach(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => {
    fetchMock.deactivate()
  })

  it('reports alive when the refresh token exchanges', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, JSON.stringify({ access_token: 'ok', expires_in: 3599, token_type: 'Bearer' }))

    expect(await checkCalendarCredential(CONFIGURED)).toEqual({ configured: true, alive: true })
  })

  // invalid_grant is what an expired or revoked refresh token answers — the
  // 7-day Testing-status expiry, six months idle, a password change, a revoke.
  it('reports not-alive on invalid_grant, and carries the reason', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_grant' }))

    const result = await checkCalendarCredential(CONFIGURED)

    expect(result.configured).toBe(true)
    expect(result).toMatchObject({ alive: false })
    // The reason reaches the job's failure message, which is the only text a
    // human sees in the Discord page.
    expect((result as { error: string }).error).toContain('invalid_grant')
  })

  it('reports not-alive rather than throwing when Google is unreachable', async () => {
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .replyWithError(new Error('connection reset'))

    const result = await checkCalendarCredential(CONFIGURED)

    expect(result).toMatchObject({ configured: true, alive: false })
  })
})
