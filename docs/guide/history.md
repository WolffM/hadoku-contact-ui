# Contact & Booking: history

## A form with a theme (November 2025)

The first commit was a plain contact form (`4ff4559`); within a day it had
its own date-picker appointment calendar and was declared "full UI complete"
(`5285adc`). None of it was backed by a real server yet — the calendar's
slots, conflicts and even its rate limiting were simulated in the browser,
behind a mock API switched on by an environment flag.

## From a mock to a real backend (March 2026)

Four months later, one commit replaced the simulation with a real one: a
Cloudflare D1-backed API, exported as a second entry point of the same
package (`api/index.ts`, alongside the UI's `src/entry.tsx`), with contact
submissions and appointments as actual stored rows, a rate limiter, email
confirmations, and meeting links on Jitsi and Discord (`f65ec64`). The mock
API stayed in the tree as the UI's offline/dev stand-in, mirroring the same
defaults the real backend's own migration sets.

Google Meet followed in April, as a third platform alongside Jitsi and
Discord, through the Google Calendar API (`b3ac356`); Microsoft Teams was
considered and dropped, since it needs a paid account the operator does not
run.

## Hardening the tiers (August 2026)

A new tier appeared in the platform's own tier ladder, ranked above this
app's service tier and below admin. One gate here had been written as an
exact-match allowlist (`userType !== 'admin' && userType !== 'service'`)
rather than a rank check, so the new tier — which is supposed to reach
everything a service reaches — would have been silently refused. Every gate
in this package moved to a shared rank comparison the same day, so a tier
added above admin in the future cannot repeat the mistake (`61ed96a`). The
admin and service surfaces were also split onto separate URL prefixes around
the same time, because a disclosing route is never allowed to sit at service
tier, only an acting one (`66ba360`).

## Making the mailbox trustworthy (August–September 2026)

Three changes in quick succession turned the inbox from "whatever the
webhook delivered" into a mailbox that could be trusted:

- **Reconciliation.** The inbound webhook had been the only way mail reached
  the inbox, and it discarded anything it could not process, always
  answering success regardless. A sweep was added that reads the provider's
  own record directly and ingests whatever the webhook missed, sharing the
  same ingest logic the webhook now only adapts into (`16c4209`).
- **Blocklist and spam.** A sender or a whole domain can be blocked, filing
  its mail to a 90-day Spam folder instead of the inbox — and a submission
  from a blocked sender is never auto-whitelisted, so a block cannot be
  silently undone by the sender simply using the form instead of email
  (`a55de99`).
- **A scoped read feed.** A third, narrower surface (`/mailfeed`) let one
  named caller read mail from one sender domain only, for a service that
  needed independent proof a message had actually arrived — gated by tier
  _and_ a per-caller grant, since the service tier alone is held by every
  worker key on the platform (`b3aac46`).

The booking window was also corrected in this window: it had rejected an
entire day the moment its earliest slot fell inside the minimum-notice
window, even when the rest of the day was clear, so asking for tomorrow in
the afternoon could lose hours that were never actually blocked. The check
now runs per slot (`9b75429`).

## Meetings that actually end (September 2026)

Deleting a message used to stop at the database row: the appointment it had
booked stayed `confirmed`, so its slot stayed blocked with nothing in the
inbox showing why, the task-calendar entry stayed, and a guest's Discord
invite kept working. A single function now retracts everything a booking
created — slot, calendar mirror, and the Discord space — whenever a meeting
is cancelled or its message is deleted (`4133991`). Each booking's Discord
space also became its own private category and channel pair that same month,
rather than one shared space for every meeting (`3786682`).

A silent failure was closed alongside it: a Google Meet booking had been
producing no link at all, with nothing recording the failure anywhere a
person would see, from the feature's launch until the underlying calendar
credential was finally provisioned on 2026-08-27. A daily check now exchanges
that credential and fails loudly — by throwing, which is the one path that
reaches a human — if it ever goes dead again (`8ea57cb`).

## Since

- **One design, not a private one.** This app's own theme system — its own
  list of themes, its own labels, its own picker — was removed in favor of
  the platform's shared theme root and header (`710b19d`).
- **Live notice of new mail** (`9db4ae5`): an open admin inbox tab is told
  over a dedicated connection the moment mail arrives, instead of polling.

## Trivia

The contact API's own source tree went untyped for over four months: the
build tool that bundles it strips types without checking them, so a plain
syntax error could pass `pnpm typecheck` and surface only when a test
happened to import the file. Eighteen pre-existing errors came out once the
gap was closed (`8a7a8a4`).
