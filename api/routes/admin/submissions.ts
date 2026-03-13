/**
 * Admin submission management routes
 *
 * CRUD operations, stats, archival, rate limit reset
 */

import { Hono } from 'hono'
import { badRequest, notFound, serverError } from '../../utils/responses'
import {
  getAllSubmissions,
  getSubmissionById,
  updateSubmissionStatus,
  deleteSubmission,
  restoreSubmission,
  purgeOldDeletedSubmissions,
  getSubmissionStats,
  getDatabaseSize,
  archiveOldSubmissions
} from '../../storage'
import { resetRateLimit } from '../../rate-limit'
import { RETENTION_CONFIG } from '../../constants'
import { adminOk } from './index'
import type { AppContext } from '../../types'

export function createSubmissionRoutes() {
  const app = new Hono<AppContext>()

  app.get('/submissions', async c => {
    try {
      const limit = Number(c.req.query('limit')) || 100
      const offset = Number(c.req.query('offset')) || 0

      const submissions = await getAllSubmissions(c.env.DB, limit, offset)
      const stats = await getSubmissionStats(c.env.DB)

      return adminOk(c, {
        submissions,
        stats,
        pagination: {
          limit,
          offset,
          total: stats.total
        }
      })
    } catch (error) {
      console.error('Error fetching submissions:', error)
      return serverError(c, 'Failed to fetch submissions')
    }
  })

  app.get('/submissions/:id', async c => {
    try {
      const id = c.req.param('id')
      const submission = await getSubmissionById(c.env.DB, id)

      if (!submission) {
        return notFound(c, 'Submission not found')
      }

      return adminOk(c, { submission })
    } catch (error) {
      console.error('Error fetching submission:', error)
      return serverError(c, 'Failed to fetch submission')
    }
  })

  app.patch('/submissions/:id/status', async c => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()

      if (!body.status || !['unread', 'read', 'archived'].includes(body.status)) {
        return badRequest(c, 'Invalid status. Must be: unread, read, or archived')
      }

      const success = await updateSubmissionStatus(
        c.env.DB,
        id,
        body.status as 'unread' | 'read' | 'archived'
      )

      if (!success) {
        return notFound(c, 'Submission not found')
      }

      return adminOk(c, { success: true, message: 'Status updated successfully' })
    } catch (error) {
      console.error('Error updating submission status:', error)
      return serverError(c, 'Failed to update submission status')
    }
  })

  app.delete('/submissions/:id', async c => {
    try {
      const id = c.req.param('id')

      const success = await deleteSubmission(c.env.DB, id)

      if (!success) {
        return notFound(c, 'Submission not found')
      }

      return adminOk(c, { success: true, message: 'Submission moved to trash' })
    } catch (error) {
      console.error('Error deleting submission:', error)
      return serverError(c, 'Failed to delete submission')
    }
  })

  app.post('/submissions/:id/restore', async c => {
    try {
      const id = c.req.param('id')

      const success = await restoreSubmission(c.env.DB, id)

      if (!success) {
        return notFound(c, 'Submission not found')
      }

      return adminOk(c, { success: true, message: 'Submission restored successfully' })
    } catch (error) {
      console.error('Error restoring submission:', error)
      return serverError(c, 'Failed to restore submission')
    }
  })

  app.post('/purge-deleted', async c => {
    try {
      const purgedCount = await purgeOldDeletedSubmissions(c.env.DB)

      return adminOk(c, {
        success: true,
        message: `Permanently deleted ${purgedCount} submission(s) from trash`,
        purgedCount
      })
    } catch (error) {
      console.error('Error purging deleted submissions:', error)
      return serverError(c, 'Failed to purge deleted submissions')
    }
  })

  app.get('/stats', async c => {
    try {
      const stats = await getSubmissionStats(c.env.DB)
      const dbSize = await getDatabaseSize(c.env.DB)

      return adminOk(c, {
        submissions: stats,
        database: {
          sizeBytes: dbSize.sizeBytes,
          sizeMB: (dbSize.sizeBytes / (1024 * 1024)).toFixed(2),
          percentUsed: dbSize.percentUsed.toFixed(2),
          warning: dbSize.warning
        }
      })
    } catch (error) {
      console.error('Error fetching stats:', error)
      return serverError(c, 'Failed to fetch statistics')
    }
  })

  app.post('/archive', async c => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { daysOld?: number }
      const daysOld = body.daysOld ? Number(body.daysOld) : RETENTION_CONFIG.ARCHIVE_AFTER_DAYS

      if (daysOld < 1 || daysOld > 365) {
        return badRequest(c, 'daysOld must be between 1 and 365')
      }

      const archivedCount = await archiveOldSubmissions(c.env.DB, daysOld)

      return adminOk(c, {
        success: true,
        message: `Archived ${archivedCount} submission(s)`,
        archivedCount
      })
    } catch (error) {
      console.error('Error archiving submissions:', error)
      return serverError(c, 'Failed to archive submissions')
    }
  })

  app.post('/rate-limit/reset', async c => {
    try {
      const body = await c.req.json()

      if (!body.ipAddress || typeof body.ipAddress !== 'string') {
        return badRequest(c, 'ipAddress is required')
      }

      await resetRateLimit(c.env.RATE_LIMIT_KV, body.ipAddress)

      return adminOk(c, {
        success: true,
        message: `Rate limit reset for IP: ${body.ipAddress}`
      })
    } catch (error) {
      console.error('Error resetting rate limit:', error)
      return serverError(c, 'Failed to reset rate limit')
    }
  })

  return app
}
