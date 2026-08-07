/**
 * PUBLIC_RECIPIENTS invariants.
 *
 * A mailbox missing from this list cannot receive mail from anyone who has not
 * been emailed first — before 2026-08-07 that meant silent discard, and now it
 * means quarantine in the Filtered folder. Either way the failure is invisible
 * at the point it happens, so it is worth pinning rather than trusting review.
 */
import { describe, it, expect } from 'vitest'
import { EMAIL_CONFIG } from '../../constants'

const PUBLIC = EMAIL_CONFIG.PUBLIC_RECIPIENTS as readonly string[]

describe('EMAIL_CONFIG.PUBLIC_RECIPIENTS', () => {
  it('includes the primary mailbox', () => {
    // DEFAULT_FROM is the address the operator sends FROM, so it is the address
    // strangers reply TO. It was missing until 2026-08-07 and every cold email
    // to it was discarded.
    expect(PUBLIC).toContain(EMAIL_CONFIG.DEFAULT_FROM)
  })

  it('includes every mailbox that has actually received mail', () => {
    // Observed in production on 2026-08-07, all of it previously discarded.
    for (const mailbox of [
      'wolffm@hadoku.me',
      'pypi@hadoku.me',
      'deadlock@hadoku.me',
      'geico@hadoku.me'
    ]) {
      expect(PUBLIC).toContain(mailbox)
    }
  })

  it('includes the DMARC rua target', () => {
    // Aggregate reports arrive from arbitrary receiving domains (Google, Yahoo,
    // Microsoft…), so no whitelist entry can ever cover them. If this address
    // is not public, DMARC reporting is silently unreadable — which is exactly
    // what happened: zero reports were visible for the life of the record.
    expect(PUBLIC).toContain('dmarc@hadoku.me')
  })

  it('is all lowercase — the inbound path lowercases before comparing', () => {
    // ingestInboundEmail lowercases the recipient, so a capitalised entry here
    // would never match and would fail closed.
    for (const mailbox of PUBLIC) {
      expect(mailbox).toBe(mailbox.toLowerCase())
    }
  })

  it('has no duplicates', () => {
    expect(new Set(PUBLIC).size).toBe(PUBLIC.length)
  })

  it('only contains addresses on a domain this deployment owns', () => {
    // A typo'd domain here would silently open the gate for a mailbox that is
    // not ours.
    for (const mailbox of PUBLIC) {
      const domain = mailbox.split('@')[1]
      expect(EMAIL_CONFIG.VALID_DOMAINS as readonly string[]).toContain(domain)
    }
  })
})
