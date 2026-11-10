/**
 * Svix webhook signature verification — the scheme Resend signs webhooks with.
 *
 * signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 * signature      = base64(HMAC-SHA256(base64decode(secret minus "whsec_"), content))
 * header         = space-separated `v1,<signature>` entries (more than one
 *                  while a secret is being rotated on Svix's side)
 *
 * The comparison goes through `crypto.subtle.verify`, which is constant-time,
 * rather than comparing base64 strings. The timestamp bound is what stops a
 * captured delivery being replayed later.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60

export type SvixVerdict = 'ok' | 'missing-headers' | 'stale' | 'bad-signature'

export interface SvixHeaders {
  id: string | null
  timestamp: string | null
  signature: string | null
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))
  } catch {
    return null
  }
}

export async function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SvixVerdict> {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return 'missing-headers'

  const sent = Number(timestamp)
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - sent) > SVIX_TOLERANCE_SECONDS) {
    return 'stale'
  }

  const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''))
  if (!keyBytes || keyBytes.length === 0) return 'bad-signature'
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`)

  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2)
    if (version !== 'v1' || !value) continue
    const candidate = base64ToBytes(value)
    if (candidate && (await crypto.subtle.verify('HMAC', key, candidate, content))) return 'ok'
  }
  return 'bad-signature'
}
