import { defineConfig } from 'vitest/config'

/**
 * UI-side test config — runs in plain Node (not workerd).
 * For pure-function tests like timezone formatting, validation helpers, etc.
 * Heavy DOM rendering tests would need jsdom/@testing-library; not added yet.
 */
export default defineConfig({
  test: {
    // The json file is what CI's report-tests step reads (ci.yml).
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-ui.json' },
    include: ['src/test/**/*.test.ts'],
    globals: true,
    environment: 'node'
  }
})
