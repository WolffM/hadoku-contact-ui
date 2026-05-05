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

Operator-only operations (set / lock / audit / grant) use `HADOKU_ADMIN_KEY`. Don't try to escalate by writing to `ADMIN_KEYS` — service tier can't write.

Lost or rotating your key? Operator: `python scripts/administration.py key-generate --tier service --repo ../<repo> --name <your-name>-<repo>` then drop the new UUID in `.devvault.local.json`.
