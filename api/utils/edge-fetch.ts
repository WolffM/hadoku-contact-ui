/**
 * fetch() that reaches edge-router for any URL on hadoku.me itself.
 *
 * This worker runs inside hadoku.me's zone when edge-router invokes it, and a
 * Worker's global fetch() to its own zone skips every Worker route on it and
 * goes to the zone's DNS origin. Since hadoku_site#530 that origin is
 * `AAAA 100::`, which answers 522, so every subrequest to `https://hadoku.me/…`
 * died before edge-router saw it. The calendar mirror is how that showed up:
 * the 2026-11-21 booking left no `/task/api` row in request_logs at all.
 *
 * The consuming worker binds edge-router as `EDGE_ROUTER` (a `[[services]]`
 * entry), which reaches it from any context. Unbound — tests, a deployment
 * without the binding — falls back to the global fetch, which is correct
 * wherever the caller is not in the zone. Any other host keeps the global fetch.
 */

export const EDGE_ORIGIN = 'https://hadoku.me'
const EDGE_HOST = new URL(EDGE_ORIGIN).hostname

export interface EdgeFetchEnv {
  EDGE_ROUTER?: Fetcher
}

export function edgeFetch(env: EdgeFetchEnv, url: string, init?: RequestInit): Promise<Response> {
  if (env.EDGE_ROUTER && new URL(url).hostname === EDGE_HOST) {
    return env.EDGE_ROUTER.fetch(url, init)
  }
  return fetch(url, init)
}
