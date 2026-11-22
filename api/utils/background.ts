/**
 * Hand best-effort work to the platform so it outlives the response.
 *
 * `c.executionCtx` THROWS when the request has no execution context (tests, some
 * dispatch paths), so the property access itself has to sit inside the try.
 * Every caller's promise already handles its own errors, so letting it run
 * unawaited there is safe: the worst case is that it doesn't finish.
 */
export interface BackgroundContext {
  executionCtx: { waitUntil(promise: Promise<unknown>): void }
}

export function runInBackground(ctx: BackgroundContext, work: Promise<unknown>): void {
  try {
    ctx.executionCtx.waitUntil(work)
  } catch {
    void work
  }
}
