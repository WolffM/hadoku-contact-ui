/**
 * Error handlers for Hono apps
 *
 * Inlined from @hadoku/worker-utils for package independence.
 */

import type { Context } from 'hono'

export function createErrorHandlers() {
  const notFoundHandler = (c: Context) => {
    return c.json(
      {
        success: false,
        error: 'Not found',
        message: 'The requested endpoint does not exist'
      },
      404
    )
  }

  const errorHandler = (err: Error, c: Context) => {
    console.error('Unhandled error:', err)

    return c.json(
      {
        success: false,
        error: 'Internal server error',
        message: 'An unexpected error occurred'
      },
      500
    )
  }

  return { notFoundHandler, errorHandler }
}
