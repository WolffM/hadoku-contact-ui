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
          bindings: {
            ADMIN_KEYS: '["test-admin-key"]',
            FRIEND_KEYS: '["test-friend-key"]',
            RESEND_API_KEY: 'test-resend-key',
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
        singleWorker: true
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
