import { defineE2eVitestConfig } from '@wolffm/e2e-harness/vitest'
import apiConfig from './vitest.config.api'

// The nightly e2e run (e2e.yml): the API suite's Miniflare config, narrowed to
// api/test/e2e, through the fleet preset — console reporter beside the JSON
// report, the hook-error sidecar report-e2e reads, and TZ=UTC.
export default defineE2eVitestConfig({
  ...apiConfig,
  test: { ...apiConfig.test, include: ['api/test/e2e/**/*.test.ts'] }
})
