import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/entry.tsx',
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // Externalize peer dependencies (parent provides them)
      // Provided by the parent page's import map (hadoku_site
      // src/layouts/Base.astro). Each of these is a SINGLETON: React and the
      // theme context match on module identity, and prefs-client and the logger
      // each hold their own cache. Inlining one gives the page a second copy
      // that the first never talks to — which is how aggregator and printtool
      // threw "No <HadokuThemeRoot> above this component" on 2026-08-05 with
      // the provider plainly mounted.
      // Enforced by hadoku_site's check:mf-externals.
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@wolffm/themes',
        '@wolffm/task-ui-components',
        '@wolffm/logger/client'
      ],
      output: {
        assetFileNames: 'style.css'
      }
    },
    target: 'es2022',
    cssCodeSplit: false,
    minify: 'esbuild'
  }
})
