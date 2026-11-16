# Contact & Booking: contributing

How to run it, where things live, and what a change must pass. What it does
for a visitor or an admin is in [features.md](features.md). Read
[`AGENTS.md`](../../AGENTS.md) first — it is the full map of the API's tier
boundaries, the mail-delivery invariants and the meeting-link model, and this
page only points into it rather than repeating it.

## What this package is

A **dual-export npm package**, not a standalone service: a React
micro-frontend (`src/entry.tsx`, exporting `mount`/`unmount`) and a Hono API
sub-router (`api/index.ts`, exporting `createContactHandler()`), each built
separately and mounted by the parent site that hosts `hadoku.me`. Nothing
here runs on its own; a parent Worker binds the API export and a parent page
mounts the UI export.

## Run it locally

```sh
pnpm install          # needs read access to the private @wolffm/* packages
pnpm dev               # Vite dev server for the UI
pnpm build             # builds both the UI (Vite) and the API (tsup)
pnpm test              # api (Workers pool) then ui (vitest)
pnpm typecheck         # the src/ tree, then the api/ tree, separately
pnpm lint:fix          # ESLint
pnpm lint:css          # stylelint + the theme package's token-usage check
pnpm format            # prettier, including this docs/guide/ tree
```

`pnpm dev` and the API's own tests need secrets (an email-provider key, a
webhook secret, …) pulled through the platform's own secrets tooling rather
than a `.env` file; running `pnpm dev` with no secrets configured will fail
with a pointer to the diagnostic command.

## Layout

```
src/            React UI: ContactForm, the appointment calendar and pickers, entry.tsx
api/            Hono sub-router: routes, services, storage, email, telemetry
api/routes/     submit, appointments (public); admin/* and mailfeed (gated)
api/services/   meeting-links, meeting-space, google-meet, task-calendar, inbound-ingest
api/storage/    D1 queries: submissions, appointments, blocklist, whitelist, mailfeed
api/test/       vitest against the Cloudflare Workers pool (unit/ and e2e/)
src/test/       vitest for the UI
```

## Tiering

Every route is gated by the caller's hadoku tier, stamped by the edge and
read as a **rank**, never an exact match (`tierAtLeast`, `api/utils/auth.ts`)
— an exact-match gate is what let a tier added above `service` slip past a
check meant to admit it (`61ed96a`).

| Prefix                  | Tier                         | Holds                                                           |
| ----------------------- | ---------------------------- | --------------------------------------------------------------- |
| `/contact/api/`         | public                       | submit, appointment slots/availability, the inbound webhook     |
| `/contact/api/admin`    | admin                        | the inbox, blocklist, templates, appointment admin, push ticket |
| `/contact/api/service`  | service                      | one route: setting an appointment's status                      |
| `/contact/api/mailfeed` | service + a per-caller scope | the scoped read feed, see features.md                           |

The admin and service surfaces are separate URL prefixes rather than one
prefix with exceptions, because the edge in front of this app matches a
prefix exactly and cannot express a narrower rule inside it — see "Admin and
service surfaces" in `AGENTS.md` for the reasoning in full, including why
`/mailfeed` needed a third prefix rather than living under `/service`.

## The booking window

`rejectDate` in `api/utils/booking-window.ts` is the single definition of
which dates and slots can be booked (minimum notice, the far horizon, the
operator's working days), and it is evaluated per-slot, not per-day — a day
is refused only when every slot on it fails (`9b75429`). The UI's calendar
and the `/appointments/*` endpoints both call it, so neither can offer a date
the other refuses; `appointment-slots.test.ts` pins the two agreeing across
the next 35 days.

## Ending a meeting

Cancelling or deleting a booking has to undo four things together — the
slot, the task-calendar mirror, and (for Discord) a private space and its
invite — and `retractMeetingArtifacts` (`api/services/appointment-cleanup.ts`)
is the one place that does all four. Before this existed, deleting a message
cancelled nothing: the slot stayed blocked invisibly and a guest kept a
working Discord invite (`4133991`).

## Checks a change must pass

`pnpm typecheck`, `pnpm lint`, `pnpm lint:css` and `pnpm test` (unit, e2e
against the Workers pool, and the UI suite); CI runs all four on every pull
request. `pnpm format:check` is the formatting gate.

## Deploying

A push to `main` publishes `@wolffm/contact-ui` to GitHub Packages and
notifies the parent site, which bumps its own lockfile and rebuilds the UI
bundle it serves; a Worker that depends on this package always pulls the
latest version at its own deploy, independent of that notification. The
version itself is set by CI from the registry's current latest plus one
patch — nobody edits it by hand, and no hook needs to bump it for a docs-only
change.

## Trivia

Nothing here typechecked the API's own source tree for over four months: the
root `tsconfig.json` only ever covered `src/`, and `tsconfig.api.json` was
consumed solely by the bundler, which strips types without checking them. A
plain syntax error in a route file passed `pnpm typecheck` cleanly and only
ever surfaced when a test happened to import it. Eighteen pre-existing type
errors came out when the gap was finally closed (`8a7a8a4`).
