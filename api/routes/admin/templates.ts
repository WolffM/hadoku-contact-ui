/**
 * Admin email template routes
 *
 * CRUD operations and version history
 */

import { Hono } from 'hono'
import { badRequest, notFound, serverError } from '../../utils/responses'
import {
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
  getTemplateVersionHistory
} from '../../storage'
import { adminOk } from './index'
import type { AppContext } from '../../types'

export function createTemplateRoutes() {
  const app = new Hono<AppContext>()

  app.get('/templates', async c => {
    try {
      const status = c.req.query('status') as 'active' | 'draft' | 'archived' | undefined
      const language = c.req.query('language')
      const limit = Number(c.req.query('limit')) || 100
      const offset = Number(c.req.query('offset')) || 0

      const templates = await listEmailTemplates(c.env.DB, {
        status,
        language,
        limit,
        offset
      })

      return adminOk(c, {
        templates,
        pagination: { limit, offset, total: templates.length }
      })
    } catch (error) {
      console.error('Error fetching templates:', error)
      return serverError(c, 'Failed to fetch templates')
    }
  })

  app.get('/templates/:id', async c => {
    try {
      const id = c.req.param('id')

      const template = await c.env.DB.prepare(`SELECT * FROM email_templates WHERE id = ?`)
        .bind(id)
        .first()

      if (!template) {
        return notFound(c, 'Template not found')
      }

      return adminOk(c, { template })
    } catch (error) {
      console.error('Error fetching template:', error)
      return serverError(c, 'Failed to fetch template')
    }
  })

  app.post('/templates', async c => {
    try {
      const body = await c.req.json()

      if (!body.name || typeof body.name !== 'string') {
        return badRequest(c, 'name field is required')
      }
      if (!body.body || typeof body.body !== 'string') {
        return badRequest(c, 'body field is required')
      }

      const auth = c.get('authContext')
      const changedBy = auth?.credential ?? 'admin'

      const name = body.name
      const templateBody = body.body
      const type = (typeof body.type === 'string' ? body.type : 'email') as 'email' | 'sms' | 'push'
      const subject = typeof body.subject === 'string' ? body.subject : null
      const language = typeof body.language === 'string' ? body.language : 'en'
      const status = (typeof body.status === 'string' ? body.status : 'active') as
        | 'active'
        | 'draft'
        | 'archived'

      const template = await upsertEmailTemplate(
        c.env.DB,
        c.env.TEMPLATES_KV,
        {
          name,
          type,
          subject,
          body: templateBody,
          language,
          status,
          created_by: changedBy,
          metadata: body.metadata ? JSON.stringify(body.metadata) : null
        },
        changedBy
      )

      return adminOk(c, { template, message: 'Template created successfully' })
    } catch (error) {
      console.error('Error creating template:', error)
      return serverError(c, 'Failed to create template')
    }
  })

  app.put('/templates/:id', async c => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()

      const existing = await c.env.DB.prepare(`SELECT id FROM email_templates WHERE id = ?`)
        .bind(id)
        .first()

      if (!existing) {
        return notFound(c, 'Template not found')
      }

      const auth = c.get('authContext')
      const changedBy = auth?.credential ?? 'admin'

      if (!body.name || typeof body.name !== 'string') {
        return badRequest(c, 'name field is required')
      }
      if (!body.body || typeof body.body !== 'string') {
        return badRequest(c, 'body field is required')
      }

      const name = body.name
      const templateBody = body.body
      const type = (typeof body.type === 'string' ? body.type : 'email') as 'email' | 'sms' | 'push'
      const subject = typeof body.subject === 'string' ? body.subject : null
      const language = typeof body.language === 'string' ? body.language : 'en'
      const status = (typeof body.status === 'string' ? body.status : 'active') as
        | 'active'
        | 'draft'
        | 'archived'

      const template = await upsertEmailTemplate(
        c.env.DB,
        c.env.TEMPLATES_KV,
        {
          id,
          name,
          type,
          subject,
          body: templateBody,
          language,
          status,
          created_by: changedBy,
          metadata: body.metadata ? JSON.stringify(body.metadata) : null
        },
        changedBy
      )

      return adminOk(c, { template, message: 'Template updated successfully' })
    } catch (error) {
      console.error('Error updating template:', error)
      return serverError(c, 'Failed to update template')
    }
  })

  app.delete('/templates/:id', async c => {
    try {
      const id = c.req.param('id')

      const success = await deleteEmailTemplate(c.env.DB, c.env.TEMPLATES_KV, id)

      if (!success) {
        return notFound(c, 'Template not found')
      }

      return adminOk(c, { success: true, message: 'Template archived successfully' })
    } catch (error) {
      console.error('Error deleting template:', error)
      return serverError(c, 'Failed to delete template')
    }
  })

  app.get('/templates/:id/versions', async c => {
    try {
      const id = c.req.param('id')
      const limit = Number(c.req.query('limit')) || 20

      const versions = await getTemplateVersionHistory(c.env.DB, id, 'email', limit)

      return adminOk(c, { versions })
    } catch (error) {
      console.error('Error fetching template versions:', error)
      return serverError(c, 'Failed to fetch template versions')
    }
  })

  return app
}
