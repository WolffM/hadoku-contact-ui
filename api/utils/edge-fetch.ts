/**
 * fetch() that reaches edge-router for any URL on hadoku.me itself.
 *
 * monitoring-api measured that a Worker's global fetch() to its own zone can
 * skip every Worker route and land on the zone's DNS origin, a 522 since
 * hadoku_site#530 (its services/edge-fetch.ts). The binding takes that
 * question off the table for this worker's own calls to hadoku.me.
 *
 * It is NOT established that contact-api was hit by it. The 2026-11-21
 * booking's calendar mirror left no /task/api row, but jobplatform-api's
 * plain fetch() to /contact/api/mailfeed from inside a request reaches the
 * edge fine (2026-11-22 18:30). The mirror's outcome is now reported to
 * telemetry (`calendar_mirror`), which is how the cause gets found.
 *
 * The consuming worker binds edge-router as `EDGE_ROUTER` (a `[[services]]`
 * entry). Unbound (tests, a deployment without it) falls back to the global
 * fetch. Any other host keeps the global fetch.
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
