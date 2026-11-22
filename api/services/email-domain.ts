/**
 * Can this email address's domain receive mail at all?
 *
 * The contact form takes whatever address a visitor types, books the meeting,
 * and mails the confirmation there. On 2026-11-21 a guest typed
 * `ruben@foreet-ai.org` for `forest-ai.org`: the domain was never registered,
 * the booking showed `confirmed`, and the confirmation went nowhere. Nothing
 * about the address was wrong in shape, so only DNS can catch it.
 *
 * A Worker has no resolver, so this asks Cloudflare's DNS-over-HTTPS JSON API.
 * The rule follows RFC 5321 §5.1: a domain receives mail if it publishes an MX
 * that is not the RFC 7505 null MX (`0 .`), or, with no MX at all, an A or AAAA
 * record (the implicit MX).
 *
 * Fail open. A lookup that errors or answers SERVFAIL says nothing about the
 * address, and refusing a booking because a resolver hiccupped would be worse
 * than the typo this exists to catch. The caller reports `unknown` to telemetry.
 */

export const DOH_URL = 'https://cloudflare-dns.com/dns-query'

const RCODE_NOERROR = 0
const RCODE_NXDOMAIN = 3
const TYPE_A = 1
const TYPE_MX = 15
const TYPE_AAAA = 28

export type EmailDomainVerdict =
  | { status: 'ok' }
  | { status: 'nonexistent'; domain: string }
  | { status: 'no_mail'; domain: string }
  | { status: 'unknown'; domain: string; error: string }

interface DohAnswer {
  type: number
  data: string
}

interface DohResponse {
  Status: number
  Answer?: DohAnswer[]
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

async function query(fetcher: Fetcher, name: string, type: string): Promise<DohResponse> {
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`
  const res = await fetcher(url, { headers: { Accept: 'application/dns-json' } })
  if (!res.ok) throw new Error(`DoH ${type} HTTP ${res.status}`)
  return (await res.json()) as DohResponse
}

function answersOf(res: DohResponse, type: number): DohAnswer[] {
  return (res.Answer ?? []).filter(a => a.type === type)
}

/** `0 .` — the domain states it accepts no mail (RFC 7505). */
function isNullMx(answer: DohAnswer): boolean {
  const [, host] = answer.data.trim().split(/\s+/)
  return host === '.'
}

export async function checkEmailDomain(
  email: string,
  fetcher: Fetcher = fetch
): Promise<EmailDomainVerdict> {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  try {
    const mx = await query(fetcher, domain, 'MX')
    if (mx.Status === RCODE_NXDOMAIN) return { status: 'nonexistent', domain }
    if (mx.Status !== RCODE_NOERROR) {
      return { status: 'unknown', domain, error: `MX rcode ${mx.Status}` }
    }

    const exchangers = answersOf(mx, TYPE_MX)
    if (exchangers.length > 0) {
      return exchangers.every(isNullMx) ? { status: 'no_mail', domain } : { status: 'ok' }
    }

    for (const [type, code] of [
      ['A', TYPE_A],
      ['AAAA', TYPE_AAAA]
    ] as const) {
      const res = await query(fetcher, domain, type)
      if (res.Status !== RCODE_NOERROR) {
        return { status: 'unknown', domain, error: `${type} rcode ${res.Status}` }
      }
      if (answersOf(res, code).length > 0) return { status: 'ok' }
    }
    return { status: 'no_mail', domain }
  } catch (err) {
    return { status: 'unknown', domain, error: err instanceof Error ? err.message : String(err) }
  }
}
