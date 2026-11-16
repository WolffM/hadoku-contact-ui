# Contact & Booking: features

What each part does and how to use it. How it is built is in
[contributing.md](contributing.md).

## Contact form

**What it does.** A name, an email address and a message, sent straight to
the operator. A hidden `website` field (a honeypot: a real visitor never
fills it in) and a same-site referrer check on the request keep most
automated spam out before it is even validated.

**How to use it.** Fill in the three fields at
[hadoku.me/contact](https://hadoku.me/contact) and submit. You get a plain
"message submitted" response; there is no reply inside the app — the operator
answers by email.

**What it does not do.** No attachments, no subject line, no account or
history of your own past messages.

## Booking a meeting

**What it does.** The same form can also book a slot: pick a duration (15,
30 or 60 minutes), then a date and a time. The calendar only ever shows a
date if at least one slot on it is still free. A day inside the minimum
notice window, past the far booking horizon, outside the operator's working
days, or booked solid does not appear as an option at all — it is never
clickable and then refused.

**How to use it.** Open the date picker in the form, choose a duration, a
day, a time and a video platform, then submit alongside your message. A slot
someone else takes in the few seconds before you submit comes back as a
conflict with the day's remaining open times, so you can pick again without
reloading.

**What it does not do.** No rescheduling or cancelling your own booking from
the form — ask the operator. No recurring bookings.

## Meeting links

**What it does.** Every booking gets a video link on the platform you chose:

- **Discord** opens a private space (its own category and channels) that
  exists only around the meeting and expires afterward.
- **Jitsi** builds a room from a random token, never from anything about the
  booking itself, so the link cannot be guessed from public information.
- **Google Meet** creates a calendar event with a Meet link attached.

**How to use it.** Pick a platform when booking; the link is in your
confirmation email and, for Discord and Jitsi, needs nothing further from
you. Google Meet needs the operator's calendar connected on their end — if it
is not, the booking still goes through and the operator follows up by hand.

**What it does not do.** Microsoft Teams is not offered (it needs a paid
account the operator does not run). A meeting link never blocks a booking:
if generating one fails for any reason, the slot is still reserved and the
confirmation still sends, just without a link.

## The inbox

**What it does.** Every message and every booking lands in one admin inbox,
with a booking's time and platform shown alongside its message rather than
as a separate record. Messages can be marked read, trashed and restored.
Trashing a message that booked a meeting cancels the meeting too: it frees
the slot, revokes the Discord invite and drops the task-calendar entry,
because that is what clearing a message off the inbox means to the person
doing it. Restoring the message afterward brings the mail back, but leaves
the meeting cancelled — an expired invite and a torn-down Discord space
cannot be un-revoked.

**How to use it.** The operator's admin screen elsewhere on the platform
calls this app's admin API; there is no separate login here.

**What it does not do.** Nothing here is reachable without admin tier.

## Blocklist and spam

**What it does.** An address or a whole domain can be blocked, either from
the list editor or with one click on a message already in the inbox.
Clicking from a message derives the right pattern automatically, rather
than asking anyone to type an email pattern by hand. Blocked mail is filed
to a Spam folder and
purged automatically after 90 days; unblocking a sender does not restore
mail that was already filed there.

**How to use it.** From a message, block its sender or its domain in one
step; from the blocklist screen, add or remove a rule directly.

**What it does not do.** A blocked sender cannot still reach you by the
contact form instead of email — the same block applies to both, and a
blocked submission is never auto-added to the whitelist that would otherwise
re-admit it.

## New-mail notice

**What it does.** An open admin inbox tab is told the moment new mail
arrives over a live connection, instead of having to reload or poll. The
notice carries no detail — not even which message — so the tab re-reads the
inbox itself rather than trusting anything riding along on the wire.

**How to use it.** Automatic once an admin inbox tab is open; nothing to
configure.

**What it does not do.** It cannot tell you what arrived, only that
something did, and it only reaches tabs that were already open when the mail
came in.

## Scoped mail feed

**What it does.** A read-only feed another part of the platform can poll, to
confirm mail from one sender domain really arrived. It is built for a
service that needs independent proof a message from a specific kind of
sender reached this mailbox, without being able to read anyone else's mail.
Each caller is
individually named and limited to a list of sender domains chosen by the
operator; a caller with no grant gets the same refusal as someone with no
access at all.

**How to use it.** Not user-facing: a platform service is granted a scope by
the operator and polls the feed with its own credential.

**What it does not do.** It never discloses outbound mail (what the operator
wrote), blocked mail, or deleted mail — only inbound messages from a granted
sender that are still live in the inbox.

## Trivia

The scoped mail feed admits no wildcard sender: every grant names real
domains one at a time, so a typo in the list fails by refusing everyone
rather than by quietly admitting everyone (`b3aac46`).
