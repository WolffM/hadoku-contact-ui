import { defineConfig } from 'vitest/config'

/**
 * UI-side test config — runs in plain Node (not workerd).
 * For pure-function tests like timezone formatting, validation helpers, etc.
 * Heavy DOM rendering tests would need jsdom/@testing-library; not added yet.
 */
export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    globals: true,
    environment: 'node'
  }
})
