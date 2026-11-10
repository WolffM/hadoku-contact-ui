import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    include: ['api/test/unit/**/*.test.ts', 'api/test/e2e/**/*.test.ts'],
    setupFiles: ['api/test/setup.ts'],
    globals: true,
    poolOptions: {
      workers: {
        main: './api/test-entry.ts',
        miniflare: {
          compatibilityDate: '2025-01-11',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['RATE_LIMIT_KV', 'TEMPLATES_KV'],
          // The mail-push hub (api/push/mail-push.ts), exported from test-entry.
          durableObjects: { MAIL_PUSH: { className: 'MailPushHub', useSQLite: true } },
          bindings: {
            // Edge-auth: tests authenticate the way edge-router stamps
            // requests (X-Edge-Auth + X-Hadoku-Tier), not X-User-Key.
            EDGE_AUTH_SECRET: 'test-edge-secret',
            RESEND_API_KEY: 'test-resend-key',
            // Svix's published reference secret, so the signer in the webhook
            // tests can be checked against Svix's own vector.
            RESEND_WEBHOOK_SECRET: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
            // The scoped mail feed's grant table. A binding rather than a
            // per-test override because the routes read it through the worker
            // env, which SELF.fetch cannot vary. The unset / malformed /
            // wildcard cases are covered as unit tests over
            // parseMailfeedScopes, where they can be.
            MAILFEED_SCOPES: JSON.stringify({
              'user-jobplatform': {
                label: 'jobplatform',
                senderDomains: ['greenhouse.io', 'ashbyhq.com']
              }
            }),
            // Google OAuth fakes — present so createGoogleMeetEvent makes
            // real HTTP calls (intercepted via fetchMock) instead of bailing
            // at the "not configured" check. Tests that book with
            // platform=google should mock the OAuth + Calendar endpoints,
            // OR expect the call to fail and meeting_link to stay null.
            GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
            GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
            GOOGLE_OAUTH_REFRESH_TOKEN: 'test-refresh-token'
          }
        },
        singleWorker: true,
        // Off on purpose: api/test/setup.ts rebuilds storage before every test.
        // The on-disk snapshotting this option does is what flaked (#27).
        isolatedStorage: false
      }
    }
  },
  plugins: [
    {
      name: 'sql-loader',
      transform(code: string, id: string) {
        if (id.endsWith('.sql')) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null
          }
        }
      }
    }
  ]
})
