/**
 * Who may read the scoped mail feed, and exactly which senders they may see.
 *
 * The feed exists because an ecosystem service (jobplatform) needs the mail one
 * class of senders writes to this mailbox, and needs it without holding a
 * credential that could read the rest of it. The admission rule in AGENTS.md
 * ("Admin and service surfaces") forbids a service route from DISCLOSING for a
 * concrete reason: service tier is held by every worker key in the fleet, so a
 * disclosing route there is a route behind any of them. This module is what
 * makes a narrow exception to that rule safe — the tier is necessary but no
 * longer sufficient, because the caller must ALSO be a named identity with a
 * named sender allowlist.
 *
 * The identity comes from `X-User-Id`, which edge-router strips from the client
 * and re-injects from the KV key registry (`injectUserId` on the /mailfeed
 * mount). Its presence under a valid `X-Edge-Auth` is therefore proof of
 * identity, in the same way `X-Hadoku-Tier` is proof of tier.
 *
 * EVERYTHING HERE FAILS CLOSED. An absent binding, unparseable JSON, an unknown
 * caller, an entry with no domains — each denies. There is deliberately no way
 * to express "all senders": the scope is the whole security property, so a
 * configuration mistake must cost the feed, never the mailbox.
 */

/** One caller's grant. */
export interface MailfeedScope {
  /** Human label for logs and the /scope route. Not an identity. */
  label: string
  /**
   * Registrable domains the caller may see mail FROM. A sender matches a domain
   * exactly, or as a subdomain of it — `greenhouse.io` admits
   * `no-reply@greenhouse.io` and `x@us.greenhouse.io`, and refuses
   * `x@notgreenhouse.io` and `x@greenhouse.io.example.com`.
   */
  senderDomains: string[]
}

/**
 * A domain is `label(.label)+`, lowercase alnum/hyphen only.
 *
 * This validation is LOAD-BEARING, not hygiene. The SQL builds a LIKE pattern
 * by concatenating the domain onto `'%.'`, so a `%` or `_` reaching that point
 * is a wildcard inside the one predicate that separates this caller from the
 * operator's private mail — `%` alone would match every sender there is. A
 * domain that fails this test invalidates its whole entry rather than being
 * skipped: silently narrowing a grant to the survivors would hide the typo
 * behind a feed that looks like it is working.
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export type ScopeDenial =
  | 'not_configured'
  | 'unconfigured_caller'
  | 'unidentified_caller'
  | 'invalid_scope'

export type ScopeResolution =
  | { allowed: true; scope: MailfeedScope }
  | { allowed: false; reason: ScopeDenial }

/**
 * Parse the `MAILFEED_SCOPES` binding: a JSON object keyed by the caller's
 * registry userId.
 *
 *   { "<userId>": { "label": "jobplatform", "senderDomains": ["greenhouse.io"] } }
 *
 * Plain `[vars]` rather than a secret, on purpose. A userId is not a
 * credential — it is the thing edge-router resolves a credential INTO — and the
 * domain list is a policy statement that belongs in a reviewable diff next to
 * the worker it governs. Nothing here is usable without a key that resolves to
 * the userId, which is the part that stays in the vault.
 *
 * Returns an empty map for any malformed binding, which denies every caller.
 */
export function parseMailfeedScopes(raw: string | undefined | null): Map<string, MailfeedScope> {
  const scopes = new Map<string, MailfeedScope>()
  if (!raw || !raw.trim()) return scopes

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('[mailfeed] MAILFEED_SCOPES is not valid JSON — the feed is closed to everyone')
    return scopes
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('[mailfeed] MAILFEED_SCOPES must be a JSON object keyed by userId')
    return scopes
  }

  for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!userId.trim()) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      console.error(`[mailfeed] scope for ${userId} is not an object — entry dropped`)
      continue
    }

    const entry = value as { label?: unknown; senderDomains?: unknown }
    const domainsRaw = entry.senderDomains
    if (!Array.isArray(domainsRaw) || domainsRaw.length === 0) {
      console.error(`[mailfeed] scope for ${userId} names no senderDomains — entry dropped`)
      continue
    }

    const domains = domainsRaw.map(d => (typeof d === 'string' ? d.trim().toLowerCase() : ''))
    const bad = domains.filter(d => !DOMAIN_RE.test(d))
    if (bad.length > 0) {
      console.error(
        `[mailfeed] scope for ${userId} has invalid domain(s) ${JSON.stringify(bad)} — entry dropped`
      )
      continue
    }

    scopes.set(userId, {
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : userId,
      senderDomains: [...new Set(domains)]
    })
  }

  return scopes
}

/**
 * Resolve the caller's grant, or say precisely why there is none.
 *
 * The denial reasons are distinguished for the OPERATOR's benefit — a caller
 * that is merely unlisted and a binding that failed to parse produce the same
 * 403 body, but very different fixes, and the one that reads as "jobplatform is
 * misconfigured" is not the one where the whole feed is dark.
 */
export function resolveMailfeedScope(
  rawScopes: string | undefined | null,
  userId: string | null | undefined
): ScopeResolution {
  const scopes = parseMailfeedScopes(rawScopes)
  if (scopes.size === 0) return { allowed: false, reason: 'not_configured' }
  if (!userId || !userId.trim()) return { allowed: false, reason: 'unidentified_caller' }

  const scope = scopes.get(userId.trim())
  if (!scope) return { allowed: false, reason: 'unconfigured_caller' }
  // parseMailfeedScopes cannot produce one of these, and this is the backstop
  // that keeps that true if it ever grows a path that can.
  if (scope.senderDomains.length === 0) return { allowed: false, reason: 'invalid_scope' }

  return { allowed: true, scope }
}
