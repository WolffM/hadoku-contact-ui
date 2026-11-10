/**
 * Signed delivery to the inbound webhook, for the suites that drive it.
 *
 * The route refuses anything not signed with RESEND_WEBHOOK_SECRET (Svix's
 * scheme). `svixSign` is checked against Svix's published reference vector in
 * inbound-webhook.test.ts, so a passing suite means the route verifies what
 * Resend actually sends, not merely what this helper produces.
 */
import { env, SELF } from 'cloudflare:test'

export const TEST_WEBHOOK_SECRET = env.RESEND_WEBHOOK_SECRET as string

export async function svixSign(secret: string, id: string, timestamp: string, body: string) {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), ch => ch.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  )
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`
}

export async function postSigned(
  body: string,
  opts: { secret?: string; timestamp?: string; signature?: string | null } = {}
) {
  const id = `msg_${crypto.randomUUID()}`
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature =
    opts.signature === undefined
      ? await svixSign(opts.secret ?? TEST_WEBHOOK_SECRET, id, timestamp, body)
      : opts.signature
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp
  }
  if (signature !== null) headers['svix-signature'] = signature
  return SELF.fetch('https://test.com/contact/api/inbound', { method: 'POST', headers, body })
}

export async function postWebhook(data: {
  email_id: string
  from: string
  to: string[]
  subject: string
}) {
  return postSigned(
    JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data })
  )
}
