/**
 * `GET /export` — the whole mailbox, oldest first, a page at a time.
 *
 * For a consumer that keeps a second copy of the mail. What it returns and why
 * nothing is filtered out is in storage/export.ts. Mounted twice, each mount
 * with its own gate: /admin/export, and /internal/export for mgmt-api's cron
 * key (handler.ts).
 */

import { Hono } from 'hono'
import { badRequest, serverError } from '../../utils/responses'
import { BadExportCursor, exportSubmissions } from '../../storage'
import { adminOk } from './index'
import type { AppContext } from '../../types'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

export function createExportRoutes() {
  const app = new Hono<AppContext>()

  app.get('/export', async c => {
    const rawLimit = c.req.query('limit')
    const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return badRequest(c, `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`)
    }

    // An unparseable floor is refused: ignoring it would answer with the whole
    // history and look like it worked.
    const rawSince = c.req.query('since')
    let since: number | null = null
    if (rawSince !== undefined) {
      since = Number(rawSince)
      if (rawSince.trim() === '' || !Number.isFinite(since)) {
        return badRequest(c, '`since` must be epoch millis')
      }
    }

    try {
      const page = await exportSubmissions(c.env.DB, {
        since,
        cursor: c.req.query('cursor') ?? null,
        limit
      })
      return adminOk(c, page)
    } catch (error) {
      if (error instanceof BadExportCursor) {
        return badRequest(c, '`cursor` must be one this route returned')
      }
      console.error('Error exporting submissions:', error)
      return serverError(c, 'Failed to export submissions')
    }
  })

  return app
}
