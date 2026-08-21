/**
 * INBOUND_WHITELIST_MODE — the switch that turns the whitelist tier of the
 * inbound gate off.
 *
 * The reading of the binding is pinned separately from the gate itself because
 * the failure mode is asymmetric: getting `'accept-all'` wrong means mail sits
 * in Filtered and someone eventually notices, while getting the DEFAULT wrong
 * means every unvouched sender on every other deployment reaches the Inbox and
 * nobody notices at all.
 */
import { describe, it, expect } from 'vitest'
import { isWhitelistEnforced } from '../../services/inbound-ingest'

describe('isWhitelistEnforced', () => {
  it('enforces when the binding is unset', () => {
    // Opt-out, not opt-in: upgrading the package must not change what reaches
    // a deployment that never asked for it.
    expect(isWhitelistEnforced({})).toBe(true)
  })

  it('stops enforcing on the exact opt-out value', () => {
    expect(isWhitelistEnforced({ INBOUND_WHITELIST_MODE: 'accept-all' })).toBe(false)
  })

  it('enforces on an unrecognised value', () => {
    // A typo in a binding that governs what reaches your inbox has to fail
    // toward the cautious answer. `'off'`, `'false'` and `'accept_all'` are all
    // things someone will plausibly type; none of them open the gate.
    for (const value of ['off', 'false', 'none', 'accept_all', 'acceptall', '']) {
      expect(isWhitelistEnforced({ INBOUND_WHITELIST_MODE: value })).toBe(true)
    }
  })

  it('is case-sensitive rather than guessing', () => {
    expect(isWhitelistEnforced({ INBOUND_WHITELIST_MODE: 'Accept-All' })).toBe(true)
  })
})
