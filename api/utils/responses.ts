/**
 * Standard response helpers
 *
 * Inlined from @hadoku/worker-utils for package independence.
 */

import type { Context } from 'hono'

export function ok<T>(c: Context, data: T): Response {
  return c.json(
    {
      data,
      timestamp: new Date().toISOString()
    },
    200
  )
}

export function badRequest(c: Context, error: string): Response {
  return c.json(
    {
      error,
      timestamp: new Date().toISOString()
    },
    400
  )
}

export function notFound(c: Context, resource = 'Resource'): Response {
  return c.json(
    {
      error: `${resource} not found`,
      timestamp: new Date().toISOString()
    },
    404
  )
}

export function serverError(c: Context, message = 'Internal server error'): Response {
  return c.json(
    {
      error: message,
      timestamp: new Date().toISOString()
    },
    500
  )
}
