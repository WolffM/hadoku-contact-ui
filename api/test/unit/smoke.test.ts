import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('Smoke test - real D1 + KV', () => {
  it('should have D1 tables from migrations', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all()
    const tables = result.results.map((r: Record<string, unknown>) => r.name)
    expect(tables).toContain('contact_submissions')
    expect(tables).toContain('email_whitelist')
    expect(tables).toContain('appointments')
    expect(tables).toContain('appointment_config')
  })

  it('should have default appointment config from migration seed', async () => {
    const config = await env.DB.prepare('SELECT * FROM appointment_config WHERE id = 1').first()
    expect(config).not.toBeNull()
    expect(config!.timezone).toBe('America/Los_Angeles')
    expect(config!.business_hours_start).toBe('09:00')
  })

  it('should respond to health check via SELF', async () => {
    const response = await SELF.fetch('https://test.com/contact/api/health')
    expect(response.status).toBe(200)
    const data = (await response.json()) as Record<string, unknown>
    expect(data.status).toBe('healthy')
    expect(data.service).toBe('contact-api')
  })

  it('should have working KV bindings', async () => {
    await env.RATE_LIMIT_KV.put('test-key', 'test-value')
    const value = await env.RATE_LIMIT_KV.get('test-key')
    expect(value).toBe('test-value')
    await env.RATE_LIMIT_KV.delete('test-key')
  })
})
