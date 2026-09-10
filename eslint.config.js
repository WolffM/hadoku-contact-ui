import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import prettierConfig from 'eslint-config-prettier'

export default [
  // Ignore build outputs and dependencies
  {
    // `.claude/worktrees/` holds other agents' checkouts of THIS repo on other
    // branches. Linting them is always wrong: they are someone else's
    // in-progress work, they are not part of this commit, and their errors block
    // a pre-commit hook that runs `eslint .` over the whole tree.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '.claude/**'
    ]
  },

  // Base JavaScript config
  js.configs.recommended,

  // TypeScript and React config
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: {
        // Injected by vite's `define` from @wolffm/catalogue at config time — see
        // vite.config.ts. It is a build-time literal, so no-undef cannot see the
        // ambient declaration in src/globals.d.ts.
        __HADOKU_APP_NAME__: 'readonly',
        // Node.js
        console: 'readonly',
        process: 'readonly',
        // Browser
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        URLSearchParams: 'readonly',
        // Browser types
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        MediaQueryListEvent: 'readonly',
        // TypeScript/React
        React: 'readonly'
      }
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      // TypeScript
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',

      // React
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // General
      'no-console': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'warn'
    }
  },

  // Cloudflare Workers API files — add Workers globals, disable React rules
  {
    files: ['api/**/*.ts', 'vitest.config.api.ts'],
    languageOptions: {
      globals: {
        // Cloudflare Workers runtime
        D1Database: 'readonly',
        KVNamespace: 'readonly',
        AnalyticsEngineDataset: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        RequestInit: 'readonly',
        // A real Workers global, and one @cloudflare/workers-types declares as
        // `declare const` — which TypeScript does NOT expose on `globalThis`.
        // So `crypto.randomUUID()` is the only spelling that satisfies tsc, and
        // it needs to be declared here or no-undef rejects it.
        crypto: 'readonly',
        // Web APIs the Workers runtime provides and @cloudflare/workers-types
        // declares the same `declare const` way as crypto above — HMAC signing
        // in services/meeting-space.ts needs all three.
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly',
        // Node.js
        __dirname: 'readonly'
      }
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off'
    }
  },

  // Node scripts (`.mjs`) — Node globals only, no TypeScript/React rules
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  },

  // Prettier config (must be last)
  prettierConfig
]
