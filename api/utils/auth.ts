/**
 * Authentication middleware for Hadoku APIs
 *
 * Inlined from @hadoku/worker-utils for package independence.
 */

import type { Context, Next, MiddlewareHandler } from 'hono'

interface AuthContext {
  userType: string
  [key: string]: unknown
}

interface AuthConfig<TEnv = Record<string, unknown>> {
  sources: string[]
  resolver: (credential: string | undefined, env: TEnv) => string | AuthContext
  contextKey?: string
  additionalFields?: (c: Context, env: TEnv) => Record<string, unknown>
}

function extractCredential(c: Context, source: string): string | undefined {
  const [type, key] = source.split(':')

  switch (type.toLowerCase()) {
    case 'header':
      return c.req.header(key)
    case 'query':
      return c.req.query(key)
    case 'cookie': {
      const cookieHeader = c.req.header('Cookie')
      if (!cookieHeader) return undefined
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map(c => {
          const [k, v] = c.trim().split('=')
          return [k, v]
        })
      )
      return cookies[key]
    }
    default:
      return undefined
  }
}

function createAuthMiddleware<TEnv extends Record<string, unknown> = Record<string, unknown>>(
  config: AuthConfig<TEnv>
): MiddlewareHandler {
  const contextKey = config.contextKey || 'authContext'

  return async (c: Context, next: Next) => {
    let credential: string | undefined
    for (const source of config.sources) {
      credential = extractCredential(c, source)
      if (credential) break
    }

    const resolved = config.resolver(credential, c.env as TEnv)

    let authContext: AuthContext
    if (typeof resolved === 'string') {
      authContext = { userType: resolved }
    } else {
      authContext = resolved
    }

    if (config.additionalFields) {
      const additional = config.additionalFields(c, c.env as TEnv)
      authContext = { ...authContext, ...additional }
    }

    c.set(contextKey, authContext)
    await next()
  }
}

export function parseKeysFromEnv(
  jsonString: string | undefined
): Record<string, string> | Set<string> {
  if (!jsonString) {
    return {}
  }

  try {
    const parsed = JSON.parse(jsonString)

    if (Array.isArray(parsed)) {
      return new Set(parsed.filter(key => typeof key === 'string'))
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, string>
    }
  } catch (error) {
    console.warn('Failed to parse keys JSON:', error)
  }

  return {}
}

export function validateKeyAndGetType(
  key: string,
  adminKeys: Record<string, string> | Set<string>,
  friendKeys: Record<string, string> | Set<string>
): { valid: boolean; userType: 'admin' | 'friend' | 'public' } {
  if (adminKeys instanceof Set) {
    if (adminKeys.has(key)) {
      return { valid: true, userType: 'admin' }
    }
  } else if (key in adminKeys) {
    return { valid: true, userType: 'admin' }
  }

  if (friendKeys instanceof Set) {
    if (friendKeys.has(key)) {
      return { valid: true, userType: 'friend' }
    }
  } else if (key in friendKeys) {
    return { valid: true, userType: 'friend' }
  }

  return { valid: false, userType: 'public' }
}

export interface HadokuAuthContext {
  userType: 'admin' | 'friend' | 'public'
  credential: string | null
}

export interface HadokuAuthEnv {
  ADMIN_KEYS?: string
  FRIEND_KEYS?: string
}

export function createHadokuAuth<TEnv extends HadokuAuthEnv = HadokuAuthEnv>(): MiddlewareHandler {
  return createAuthMiddleware<TEnv & Record<string, unknown>>({
    sources: ['header:X-User-Key'],
    resolver: (credential, env) => {
      const adminKeys = parseKeysFromEnv(env.ADMIN_KEYS)
      const friendKeys = parseKeysFromEnv(env.FRIEND_KEYS)

      let userType: 'admin' | 'friend' | 'public' = 'public'

      if (credential) {
        const result = validateKeyAndGetType(credential, adminKeys, friendKeys)
        userType = result.userType
      }

      return {
        userType,
        credential: credential ?? null
      }
    }
  })
}
