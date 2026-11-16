---
title: Contact & Booking
summary: >-
  The contact form and appointment scheduler at
  [hadoku.me/contact](https://hadoku.me/contact), open to anyone for sending
  a message or booking a meeting with a Discord, Jitsi or Google Meet link,
  with admin screens that need an account to manage what comes in.
features:
  - name: Contact form
    summary: 'Name, email and a message, with a hidden honeypot field and a same-site referrer check.'
    anchor: contact-form
  - name: Booking a meeting
    summary: 'Pick a duration and a free slot; the calendar greys out anything the booking window or an existing booking already rules out.'
    anchor: booking-a-meeting
  - name: Meeting links
    summary: 'Discord gets its own private, expiring space; Jitsi a random room; Google Meet a calendar invite.'
    anchor: meeting-links
  - name: The inbox
    summary: 'Read, trash and restore a message and its booked meeting together.'
    anchor: the-inbox
    tier: admin
  - name: Blocklist and spam
    summary: 'Block one address or a whole domain; blocked mail lands in a 90-day Spam folder instead of the inbox.'
    anchor: blocklist-and-spam
    tier: admin
  - name: New-mail notice
    summary: 'Open inbox tabs learn the moment new mail arrives, with no polling.'
    anchor: new-mail-notice
    tier: admin
  - name: Scoped mail feed
    summary: 'Another hadoku service can read the mail from one sender domain it is explicitly granted, and nothing else.'
    anchor: scoped-mail-feed
    tier: service
trivia:
  - 'The calendar faked its backend for four months: a slot booked at launch in November 2025 saved nowhere until the real API arrived the following March (`5285adc`, `f65ec64`).'
  - "A tier added above this app's own service tier, between it and admin, would have been silently refused by a gate written as an exact-match list rather than a rank check (`61ed96a`)."
  - 'A booked Google Meet produced no link at all, confirmation email included, from the day the feature shipped until the credential was finally provisioned on 2026-08-27 (`8ea57cb`).'
  - 'Deleting a message used to leave its booked meeting on the calendar and its Discord invite live; restoring the message could undo neither (`4133991`).'
---

# Contact & Booking

Send a message, or book time, at [hadoku.me/contact](https://hadoku.me/contact).
No sign-in is needed: the form is open to anyone, and a booking gets a
confirmation email with a meeting link on whichever platform you picked.

![The contact form beside the booking calendar: a date picked, a duration and a meeting platform chosen, and the day's open times listed](images/contact-form.webp)

The same package also ships the admin side: an inbox for the messages and
bookings that come in, a blocklist for mail nobody wants to see again, and a
narrow read surface other parts of the platform can use to confirm a message
really arrived.

- [Features](features.md): what each part does and how to use it.
- [Contributing](contributing.md): running it locally, the architecture, the checks it must pass.
- [History](history.md): from a mocked calendar to a reconciled mailbox.
- [Trivia](trivia.md)

## Trivia

The booking calendar you see today spent its first four months talking to a
fake backend: picking a slot in the November 2025 build saved nothing at all,
anywhere, until the real scheduling API arrived in March 2026
([history](history.md#from-a-mock-to-a-real-backend-march-2026)).
