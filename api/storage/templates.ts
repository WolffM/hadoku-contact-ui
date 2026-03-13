/**
 * Template storage operations (hybrid D1 + KV)
 */

import {
  TEMPLATE_CONFIG,
  PAGINATION_DEFAULTS,
  type TemplateType,
  type TemplateStatus
} from '../constants'

export interface EmailTemplate {
  id: string
  name: string
  type: TemplateType
  subject: string | null
  body: string
  language: string
  version: number
  status: TemplateStatus
  created_at: number
  updated_at: number
  created_by: string | null
  metadata: string | null
}

export interface ChatbotPrompt {
  id: string
  name: string
  system_prompt: string
  user_prompt: string | null
  context_window: number
  temperature: number
  max_tokens: number
  model: string
  language: string
  version: number
  status: TemplateStatus
  created_at: number
  updated_at: number
  created_by: string | null
  metadata: string | null
}

export interface TemplateVersion {
  id: string
  template_type: 'email' | 'chatbot'
  template_id: string
  version: number
  content: string
  changed_by: string | null
  changed_at: number
  change_notes: string | null
}

async function loadTemplate<T>(
  db: D1Database,
  kv: KVNamespace,
  tableName: string,
  kvPrefix: string,
  name: string,
  language = TEMPLATE_CONFIG.DEFAULT_LANGUAGE
): Promise<T | null> {
  const kvKey = `${kvPrefix}:${name}:${language}`
  const cached = await kv.get(kvKey, 'json')
  if (cached) {
    return cached as T
  }

  const template = await db
    .prepare(
      `SELECT * FROM ${tableName}
			 WHERE name = ? AND language = ? AND status = 'active'
			 ORDER BY version DESC LIMIT 1`
    )
    .bind(name, language)
    .first<T>()

  if (template) {
    await kv.put(kvKey, JSON.stringify(template), {
      expirationTtl: TEMPLATE_CONFIG.KV_CACHE_TTL_SECONDS
    })
  }

  return template
}

export async function getEmailTemplate(
  db: D1Database,
  kv: KVNamespace,
  name: string,
  language = TEMPLATE_CONFIG.DEFAULT_LANGUAGE
): Promise<EmailTemplate | null> {
  return loadTemplate<EmailTemplate>(db, kv, 'email_templates', 'template:email', name, language)
}

export async function getChatbotPrompt(
  db: D1Database,
  kv: KVNamespace,
  name: string,
  language = TEMPLATE_CONFIG.DEFAULT_LANGUAGE
): Promise<ChatbotPrompt | null> {
  return loadTemplate<ChatbotPrompt>(db, kv, 'chatbot_prompts', 'template:chatbot', name, language)
}

export async function listEmailTemplates(
  db: D1Database,
  filters?: {
    status?: TemplateStatus
    language?: string
    limit?: number
    offset?: number
  }
): Promise<EmailTemplate[]> {
  const {
    status,
    language,
    limit = PAGINATION_DEFAULTS.LIMIT,
    offset = PAGINATION_DEFAULTS.OFFSET
  } = filters ?? {}

  let query = `SELECT * FROM email_templates WHERE 1=1`
  const bindings: (string | number)[] = []

  if (status) {
    query += ` AND status = ?`
    bindings.push(status)
  }

  if (language) {
    query += ` AND language = ?`
    bindings.push(language)
  }

  query += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  bindings.push(limit, offset)

  const { results } = await db
    .prepare(query)
    .bind(...bindings)
    .all<EmailTemplate>()
  return results
}

export async function upsertEmailTemplate(
  db: D1Database,
  kv: KVNamespace,
  template: Omit<EmailTemplate, 'id' | 'created_at' | 'updated_at' | 'version'> & {
    id?: string
  },
  changedBy?: string
): Promise<EmailTemplate> {
  const now = Date.now()
  const id = template.id ?? `tpl_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

  const existing = await db
    .prepare(`SELECT id, version FROM email_templates WHERE id = ?`)
    .bind(id)
    .first<{ id: string; version: number }>()

  const version = existing ? existing.version + 1 : 1

  const result = await db
    .prepare(
      `INSERT INTO email_templates
			 (id, name, type, subject, body, language, version, status, created_at, updated_at, created_by, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   subject = excluded.subject,
			   body = excluded.body,
			   status = excluded.status,
			   version = excluded.version,
			   updated_at = excluded.updated_at,
			   metadata = excluded.metadata`
    )
    .bind(
      id,
      template.name,
      template.type,
      template.subject,
      template.body,
      template.language,
      version,
      template.status,
      existing ? existing.id : now,
      now,
      changedBy ?? template.created_by,
      template.metadata
    )
    .run()

  if (!result.success) {
    throw new Error('Failed to save email template')
  }

  const saved = await db
    .prepare(`SELECT * FROM email_templates WHERE id = ?`)
    .bind(id)
    .first<EmailTemplate>()

  if (!saved) {
    throw new Error('Failed to retrieve saved template')
  }

  const kvKey = `template:email:${template.name}:${template.language}`
  await kv.put(kvKey, JSON.stringify(saved), {
    expirationTtl: TEMPLATE_CONFIG.KV_CACHE_TTL_SECONDS
  })

  await db
    .prepare(
      `INSERT INTO template_versions
			 (id, template_type, template_id, version, content, changed_by, changed_at, change_notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `ver_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      'email',
      id,
      version,
      JSON.stringify(saved),
      changedBy,
      now,
      null
    )
    .run()

  return saved
}

export async function deleteEmailTemplate(
  db: D1Database,
  kv: KVNamespace,
  id: string
): Promise<boolean> {
  const template = await db
    .prepare(`SELECT name, language FROM email_templates WHERE id = ?`)
    .bind(id)
    .first<{ name: string; language: string }>()

  if (!template) {
    return false
  }

  const result = await db
    .prepare(`UPDATE email_templates SET status = 'archived', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run()

  if (result.success) {
    const kvKey = `template:email:${template.name}:${template.language}`
    await kv.delete(kvKey)
  }

  return result.success
}

export async function getTemplateVersionHistory(
  db: D1Database,
  templateId: string,
  templateType: 'email' | 'chatbot' = 'email',
  limit = PAGINATION_DEFAULTS.MAX_VERSION_HISTORY
): Promise<TemplateVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM template_versions
			 WHERE template_id = ? AND template_type = ?
			 ORDER BY version DESC LIMIT ?`
    )
    .bind(templateId, templateType, limit)
    .all<TemplateVersion>()

  return results
}
