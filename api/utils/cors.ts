/**
 * CORS middleware
 *
 * Inlined from @hadoku/worker-utils for package independence.
 */

import { cors } from 'hono/cors'

export const DEFAULT_HADOKU_ORIGINS = [
  'https://hadoku.me',
  'https://task-api.hadoku.me',
  'http://localhost:*'
]

export interface CORSConfig {
  origins: string[]
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  maxAge?: number
}

function matchOrigin(origin: string, pattern: string): boolean {
  if (origin === pattern) return true

  if (pattern.includes('*')) {
    const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(origin)
  }

  return false
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some(pattern => matchOrigin(origin, pattern))
}

export function createCorsMiddleware(config: CORSConfig) {
  const {
    origins,
    methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders,
    credentials = true,
    maxAge = 86400
  } = config

  return cors({
    origin: origin => {
      if (!origin) return origins[0]
      return isOriginAllowed(origin, origins) ? origin : origins[0]
    },
    allowMethods: methods,
    allowHeaders: allowedHeaders,
    exposeHeaders: exposedHeaders,
    credentials,
    maxAge
  })
}
