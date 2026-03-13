import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'api/index.ts'
  },
  outDir: 'dist/api',
  format: ['esm'],
  dts: true,
  tsconfig: 'tsconfig.api.json',
  clean: true,
  external: ['hono'],
  target: 'es2022'
})
