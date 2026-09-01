# @wolffm/contact-ui

Dual-export npm package: React micro-frontend + Hono API sub-router for the hadoku.me contact/appointment system.

## Exports

| Export path | Entry           | Builds with             | Produces                          |
| ----------- | --------------- | ----------------------- | --------------------------------- |
| `.` (UI)    | `src/entry.tsx` | Vite (`pnpm build:ui`)  | `dist/index.js`, `dist/style.css` |
| `./api`     | `api/index.ts`  | tsup (`pnpm build:api`) | `dist/api/index.js`               |

- UI exports `mount(el, props)` and `unmount(el)` — standard hadoku micro-frontend contract
- API exports `createContactHandler()` — returns a Hono app mounted as sub-router in the parent Worker

## Contracts

- Peer deps: `react`, `react-dom`, `@wolffm/themes`, `@wolffm/task-ui-components`
- CSS export: `@wolffm/contact-ui/style.css` (parent must import)
- Publish: GitHub Packages (`@wolffm` scope)
- On publish: dispatches `packages_updated` to `WolffM/hadoku_site`

## Inbound gate

Inbound mail passes two independent tiers before it becomes an Inbox row:

| Tier          | Failing it means                    | Switchable?                                   |
| ------------- | ----------------------------------- | --------------------------------------------- |
| **Blocklist** | `blocked` → Spam, purged after 90d  | No, and never should be                       |
| **Whitelist** | `not_whitelisted` → Filtered folder | Yes — `INBOUND_WHITELIST_MODE=accept-all` var |

`INBOUND_WHITELIST_MODE` is a plain Worker `[vars]` entry, not a secret. It is
**opt-out**: unset, or any value other than the exact string `accept-all`,
enforces the whitelist — so upgrading the package never changes what reaches an
existing deployment, and a typo fails toward the cautious answer.

Everything that consults the whitelist tier reads it through
`isWhitelistEnforced(env)` (`api/services/inbound-ingest.ts`). That includes
`restoreBlockedMail`, which re-evaluates the gate when a sender is unblocked and
takes the answer as a parameter — pass `isWhitelistEnforced(env)` there and
nothing else, or an unblock will file mail somewhere the sender's next message
never appears.

The switch governs future INGEST only — turning a gate off says nothing about
mail already behind it. Daily maintenance closes that gap:
`releaseQuarantinedSubmissions` clears every lingering `not_whitelisted` stamp
while the mode is `accept-all`, so storage converges on the policy instead of
keeping a fossil of the previous one. It runs once, reports 0 forever after, and
never touches `blocked` rows. Switching the gate back on does not re-stamp what
it released.

## Booking window

A date is offerable only if some slot on it clears three bounds: the minimum
notice (`min_advance_hours`), the far bound (`max_advance_days`), and the
operator's working days (`available_days`).

All three live in **one** function — `rejectDate` in `api/utils/booking-window.ts`
— which the `/appointments/slots` route enforces and the contact form imports.
That module is the reason `src/` imports from `api/`, and it is deliberate. The
calendar used to carry its own hardcoded version of the rule ("tomorrow at the
browser's local midnight, weekends included"), so it offered dates the server
then refused with a 400 the user could not act on — ask at 4:59pm under a 24h
notice and a 17:00 close, and all of tomorrow is gone, but the calendar still
let you click it.

**A date with nothing on it is greyed out; it is never explained.** The rules
alone cannot decide that, because a day can clear every bound and still be
booked solid — so the greying is driven by `GET /appointments/availability`
(`?duration&from&to`), which returns free-slot counts and names only dates that
have something left. Anything absent is unclickable: weekends, days inside the
notice window, days past the far bound and full days are one case to the UI, not
four. `GET /appointments/config` publishes the window as well, but only as the
fallback for the moment before counts arrive.

The invariant, pinned by `appointment-slots.test.ts`: no date the availability
map names comes back with an empty slot list. If the slots route ever does
refuse a day the calendar offered — stale counts, a cutoff that rolled past —
the form re-fetches the counts and shows its empty state. It never repeats the
server's rule at the user.

The window is per-SLOT, not per-day: a day is refused only when even its best
case fails, so a morning inside the notice window does not discard that
afternoon. `appointment-slots.test.ts` walks the next 35 days asserting the
calendar predicate and the endpoint agree on every one — that equivalence is the
invariant, not either half on its own.

Widening what a user can book is a config change, not a code change:
`PUT /admin/appointments/config` moves `advance_notice_hours`.

## Admin and service surfaces

**This section is the single source of truth for API tiering. Code comments
point here; they must not restate it.** Two files enforce it and they live in
different repos, so a rule written down twice is a rule that will disagree with
itself.

| Prefix                 | Tier      | Holds                                                      |
| ---------------------- | --------- | ---------------------------------------------------------- |
| `/contact/api/...`     | public    | submit, appointments, slots, availability, inbound, health |
| `/contact/api/admin`   | **admin** | submissions, email, blocklist, templates, appointment CRUD |
| `/contact/api/service` | service   | `PATCH /appointments/:id/status` — and nothing else, yet   |

**The admission rule: a service route may ACT, it may not DISCLOSE.**
`PATCH /appointments/:id/status` qualifies because it takes an id and a status
and answers with a boolean. `GET /appointments` does not, and stays at admin —
it returns names, emails and message bodies. Nor does anything that acts _as_
the operator: `send-email` sends mail over their name. Service tier is held by
every worker key in the ecosystem, so a route here is a route behind any of
those keys, or behind a bug in any of them.

**Two gates, and the edge one is primary.** Every request crosses
`workers/edge-router/src/route-tiers.ts` in `../hadoku_site/` before it reaches
this worker, and edge-router matches `exact` or `prefix` only — it cannot
express a path pattern. That is the whole reason `/service` is a separate
prefix rather than a carve-out inside `/admin`: a service-tier route living
under `/admin` is unreachable unless the edge rule for the entire admin prefix
is lowered, which would put appointment PII behind service tier at the edge and
leave only the worker holding the line. Adding a route to `/service` therefore
means editing both repos; adding one to `/admin` means editing neither.

The worker is the BACKSTOP, not the gate. A 403 shaped
`{"error":"forbidden","required":"admin"}` came from edge-router and never
reached this code; the worker's own denial is
`{"success":false,"error":"Forbidden","message":"... access required"}`. Telling
them apart is how you know which repo to fix.

`PATCH /appointments/:id/status` is mounted at BOTH prefixes from one factory
(`createAppointmentStatusRoutes`) — service tier at `/service`, admin tier at
`/admin`, because the command-station UI calls the admin path and predates the
split. Cancelling through either retracts the mirrored task-calendar entry;
there is no DELETE, and a cancelled row frees its slot because
`isSlotAvailable` and the booked-slot query both filter `status = 'confirmed'`.

Pinned by `api/test/e2e/admin-tier-split.test.ts`, which asserts the split in
both directions: service can cancel, friend cannot (service is rank 2, friend
1 — lowering a gate must not open it), and a service key gets 403 on every
disclosing endpoint.

## Meeting links, and the credential that expires

Three platforms, three failure profiles. Jitsi and Discord need no credential —
Jitsi builds a room from 128 CSPRNG bits (never from `slotId`, which the public
`/appointments/slots` listing publishes), Discord serves `DISCORD_INVITE_URL`.
Google Meet needs OAuth, and that is the only part that can rot.

**A meeting link never fails a booking.** `generateMeetingLink` returning
unsuccessfully still stores the appointment, still sends the confirmation, and
still 201s — with `meeting_link = null` in a column no admin view renders. That
is not a bug to fix; a reserved slot is worth more than a link. It does mean the
failure is invisible by construction, which is how Google Meet shipped in v1.1.9
and produced nothing at all until 2026-08-27 without anyone noticing.

Two things now make it visible:

- `logMeetingLinkFailed` on every failed generation. Note this only reaches
  Workers Logs — `logEvent` writes to `console`, it does **not** write to
  Analytics Engine despite taking an `env`. Findable, not alerting.
- **The canary in `handleScheduled`** — `checkCalendarCredential` exchanges the
  refresh token daily. It is the alerting half, and it works by THROWING: a
  thrown step makes `/internal/run-daily` return 500, mgmt-api records the
  JobExecution as `failed`, and monitoring-api's `job-alerts` pages Discord off
  that state with no per-job wiring. Throwing is the only path here that reaches
  a human.

The canary runs **last** on purpose, after every retention step has committed,
so a dead meeting credential never costs a night of archiving or purging. Its
error message says so explicitly, because the Discord alert is titled with the
job and would otherwise read as a broken purge.

It is also a **keepalive**: Google voids a refresh token after six months
unused, and bookings here are sporadic enough to reach that. A daily exchange
counts as use.

`configured: false` (no Google secrets bound) is a first-class answer, not a
failure — a deployment offering only Jitsi and Discord must not fail its nightly
job over a feature it never enabled, and must not make an outbound call to find
that out.

**What kills the refresh token**, in likelihood order: the OAuth app sitting in
"Testing" publishing status (Google voids tokens after 7 days), six months
unused, an account password change, a manual revoke, or the client being
deleted. Recovery is a re-mint and a secret push — no code change, no republish.
Full procedure: `../hadoku_site/docs/operations/google-meet-setup.md`.

Pinned by `api/test/e2e/credential-canary.test.ts` (dead credential fails the
job; retention still ran) and `api/test/unit/credential-check.test.ts` (the
configuration branching, which the e2e tests cannot reach).

## Mail carries its booking

A contact-form submission that booked a meeting is stored in two tables:
`contact_submissions` for the message, `appointments` for the slot. The admin
submissions endpoints attach the second to the first (`submission.appointment`,
null for the mail that booked nothing), because the Inbox renders them as one
item and used to show the message with no time on it at all.

The join is done in JS, not SQL: the two tables share `id`, `name`, `email`,
`message`, `status` and `created_at`, so a `SELECT *` join silently overwrites
the submission's columns with the appointment's.

## External dependencies

- **Parent repo:** `../hadoku_site/` — mounts both UI and API exports, owns the Cloudflare Worker deployment
- **Sibling repos:** `../hadoku-themes/` (`@wolffm/themes`), task-ui-components (`@wolffm/task-ui-components`)
- **Runtime services:** Cloudflare D1 (SQL storage), Cloudflare KV (rate-limit + templates), Resend (email)

## Commands

```
pnpm build          # build both UI and API
pnpm build:ui       # Vite library build
pnpm build:api      # tsup build
pnpm test:api       # vitest with Cloudflare Workers pool (uses wrangler.test.toml)
pnpm dev            # Vite dev server
pnpm lint:fix       # ESLint auto-fix
pnpm format         # Prettier
```

## Colors

All colors come from `@wolffm/themes` (consumed here as raw CSS `var(--color-*)` in `src/styles/index.css`; `entry.tsx` imports `@wolffm/themes/style.css` — this repo does not use Tailwind color classes).
Read `node_modules/@wolffm/themes/THEME_USAGE_GUIDE.md` before writing styles.

- **A token names a semantic role, not a hue.** Light/dark is automatic — never branch on theme mode or `[data-theme]`.
- `<f>` ∈ `primary | success | warning | danger | neutral`. Every family has exactly six tokens: `--color-<f>`, `-dark`, `-bg`, `-hover`, `--color-on-<f>`, `--color-on-<f>-bg`. If a name isn't in that shape, it doesn't exist (v3 removed `-light`/`-lighter`/`-darker`/`--color-muted-bg`).
- **Filled surface** → `background: var(--color-<f>)` + `color: var(--color-on-<f>)`. **Tint badge/banner/alert** → `background: var(--color-<f>-bg)` + `color: var(--color-on-<f>-bg)` (NOT `var(--color-<f>)` as text — it fails AA in most themes). **Body text** → `var(--color-text)`. **Card** → `var(--color-bg-card)`. **Border** → `var(--color-border)`.
- **Never** `var(--color-x, #hex)` fallbacks (they hide broken tokens) or hex/`white`/`var(--color-bg)` literals as text on a filled background — use `var(--color-on-<f>)`.
- `entry.tsx` must import `style.css` **unlayered** — `layer(...)` makes every color resolve to nothing.
- `--color-text-tertiary` / `--color-text-muted` are decorative-only (fail AA on most backgrounds); any text a user must read takes `--color-text` or `--color-text-secondary`.
- Verify with `pnpm run lint:css` (runs stylelint + `check-usage` from the package). A reference to a token the theme doesn't define renders as nothing — the gate is the only thing that catches it.

## Version management

- Pre-commit hook auto-bumps patch version when `src/`, `api/`, `package.json`, or build config files change
- Patch rolls over at `.20` to bump minor (e.g., `1.1.20` -> `1.2.0`)
- Publish workflow has fallback bump if the hook was bypassed

## Does NOT

- Run as a standalone Cloudflare Worker (see `../hadoku_site/` for the host Worker)
- Have its own `wrangler.toml` for deployment (`wrangler.test.toml` is test-only)
- Include frontend/UI tests (only API tests exist in `api/test/`)
- Use `package-lock.json` (pnpm only)

## Auth & secrets (hadoku ecosystem)

- **Browser fetches** must hit `hadoku.me/{prefix}/*` via edge-router — NEVER `*.hadoku.me` direct subdomains. The `hadoku_session` cookie (`Domain=.hadoku.me`, 30d sliding) is set on `/auth` and resolved server-side by edge-router into `X-User-Key` for the backend.
- **Secrets**: vault-broker model, NO `.env` files. Local dev fetches via `.devvault.json` + `node ../hadoku_site/scripts/secrets/dev-vault.mjs -- <cmd>`. If `pnpm dev` fails, run `node ../hadoku_site/scripts/secrets/dev-vault.mjs --check` for diagnostics. **Tutorial: `../hadoku_site/docs/child-apps/USING_VAULT.md`**. Operational reference: `../hadoku_site/docs/operations/SECRETS.md`.
- **Auth model**: 1:1 named user-keys. `/auth` accepts key + name; whoami returns the name. Admin endpoints `GET/POST/DELETE /session/admin/keys` manage the registry. See `../hadoku_site/docs/planning/next-work.md`.

## Vault — what your service-tier key can and can't do

This repo's vault key lives in `.devvault.local.json` at the repo root (gitignored, mode 0600). `dev-vault.mjs` reads it automatically. Per-key ACL is enforced as of 2026-05-04.

CAN do (no operator needed):

- `GET /api/secrets/status` — sealed/unlocked check
- `GET /api/secrets/get/:key` — fetch a value declared in this repo's `.devvault.json`
  (other repos' secrets return 403 — your key is scoped to THIS repo)
- `GET /api/secrets/acl/me` — see what your key is granted
- Verify with: `node ../hadoku_site/scripts/secrets/dev-vault.mjs --check`

CANNOT do (returns `403` — by design):

- Read secrets NOT in this repo's `.devvault.json`
- `POST /api/secrets/admin/set-many` — adding/changing secrets
- `POST /api/secrets/admin/lock` — sealing the vault
- `GET /api/secrets/list` — enumerating every secret name
- `GET /api/secrets/audit` — dead-key report

If your code reads a new `process.env.X` that isn't in `.devvault.json` yet:

1. Add the mapping to `.devvault.json` (commit-safe, no values).
2. Tell the operator: they grant the new entries via `key-acl-sync --repo ../<this-repo> --key <uuid> [--prune]`.
3. Re-run your dev command.

Operator-only operations (set / lock / audit / grant) use `HADOKU_ADMIN_KEY`. Don't try to escalate: service tier can't write, and there is no key list to add yourself to — auth resolves from the edge-router key registry, which only an admin can write.

Lost or rotating your key? Operator: `python scripts/administration.py key-generate --tier service --repo ../<repo> --name <your-name>-<repo>` then drop the new UUID in `.devvault.local.json`.
