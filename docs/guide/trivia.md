# Contact & Booking: trivia

Each fact names the commit it comes from.

## Trivia

- **Four months of talking to nobody.** The appointment calendar shipped and
  was declared "full UI complete" in November 2025 (`5285adc`) with no real
  backend behind it at all. Every slot, conflict and rate limit was
  simulated in the browser until the real API arrived the following March
  (`f65ec64`).
- **A rank, not a name.** A gate written as `userType !== 'admin' && userType
!== 'service'` admitted exactly the right callers for months, purely
  because there happened to be only two tiers above the one it meant to
  exclude. The moment a new tier was ranked between them, the same check
  would have refused the one caller it most needed to admit (`61ed96a`).
- **A link nobody noticed was missing.** A booking on the Google Meet
  platform produced no meeting link at all — not a broken one, none — from
  the day the feature shipped until the underlying calendar credential was
  finally provisioned on 2026-08-27. The booking still succeeded and the
  confirmation still sent every time, which is exactly why nobody saw it
  (`8ea57cb`).
- **Restoring a message couldn't un-delete a meeting.** Deleting a message
  that had booked a meeting used to leave the booking `confirmed` — its slot
  still blocked, its Discord invite still live — with nothing in the inbox
  showing why. Restoring the message brought the mail back; the meeting
  stayed cancelled regardless, since an expired Discord invite cannot be
  un-revoked either way (`4133991`).
- **Eighteen errors with nowhere to surface.** The API's own source tree went
  untyped for over four months: `pnpm typecheck` only ever checked the UI, and
  the bundler that compiles the API strips types without checking them. A
  plain syntax error could pass clean and only ever show up when a test
  happened to import that file. Closing the gap turned up eighteen
  pre-existing type errors in one pass (`8a7a8a4`).
- **The shortest and longest subjects are six and a half months apart.** The
  shortest commit subject in the repository is one word, `go` (`9f5a3db`);
  the longest spells out a CI auth unification and a package manager bump in
  a single sentence (`66a4160`).
