import { defineE2eVitestConfig } from '@wolffm/e2e-harness/vitest'
import apiConfig from './vitest.config.api'

// The nightly e2e run (e2e.yml): the API suite's Miniflare config, narrowed to
// api/test/e2e, through the fleet preset — console reporter beside the JSON
// report, the hook-error sidecar report-e2e reads, and TZ=UTC.
//
// The api config's reporters and outputFile are left behind: they write
// reports/vitest-api.json for ci.yml, and a 'json' reporter already present
// stops the preset adding its own, so the e2e report never reached
// e2e-report.json, the path report-e2e and report-tests read (#33).
const { reporters: _reporters, outputFile: _outputFile, ...apiTest } = apiConfig.test ?? {}

export default defineE2eVitestConfig({
  ...apiConfig,
  test: { ...apiTest, include: ['api/test/e2e/**/*.test.ts'] }
})
