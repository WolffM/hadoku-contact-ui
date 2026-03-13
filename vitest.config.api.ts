import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'
import path from 'node:path'

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'api', 'migrations')
  const migrations = await readD1Migrations(migrationsPath)

  return {
    test: {
      include: ['api/test/unit/**/*.test.ts', 'api/test/e2e/**/*.test.ts'],
      setupFiles: ['api/test/setup.ts'],
      globals: true
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
    ],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.test.toml'
        },
        miniflare: {
          d1Databases: {
            DB: {
              migrations
            }
          },
          kvNamespaces: ['RATE_LIMIT_KV', 'TEMPLATES_KV']
        }
      }
    }
  }
})
