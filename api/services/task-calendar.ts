/**
 * Task-calendar bridge
 *
 * Writes contact-api events into the owner's unified hadoku task calendar as
 * Tasks, ONCE at creation time. task-api is the source of truth after that — we
 * never re-push or sync, so the owner's local edits always win.
 *
 * Two event sources, one contract:
 *   - appointments (booked meetings)  → timed events,   source "contact"
 *   - admin outbound mail             → all-day events,  source "admin-mail"
 *
 * Routing: we POST to the task-api create endpoint over the public edge as
 * OURSELVES (`X-User-Key: <CONTACTUI_SERVICE_KEY>`, this worker's own
 * service-tier identity). The target board is DISCOVERED, not configured: we
 * ask task-api which boards we can see and take the one shared with us.
 * task-api then confirms the grant and writes into the OWNER's rows.
 *
 * This replaced a dedicated `CONTACT_SYNC_KEY` (2026-07-26). That key existed
 * only because the create endpoint had no way to address someone else's board:
 * storage followed the presented credential, so mirroring into the owner's
 * calendar meant BEING the owner — which is why a contact form worker ended up
 * holding an admin-tier credential. Shared boards removed the reason, so the
 * key was deleted rather than downgraded.
 *
 * Why discovery rather than a configured board id: a shared board is
 * addressable only by its globally-unique handle — a plain name like "main"
 * resolves to OUR OWN board of that name, so a human-readable value in config
 * would silently mirror into an empty board of ours and read as a typo rather
 * than a routing bug. Rather than pin an opaque handle in config and hope it
 * stays correct, we read it from `GET /boards`, where a shared board's `id` IS
 * its handle. Selection is by the `access` field, never by display name.
 */

import type { StoredAppointment } from '../storage/appointments'
import type { StoredSubmission } from '../storage/submissions'

// Production create endpoint, reachable from a Worker subrequest via the edge.
const DEFAULT_TASK_API_URL = 'https://hadoku.me/task/api'

export interface TaskCalendarEnv {
  // This worker's OWN service-tier key, sent as X-User-Key. It needs no special
  // tier — only a board_shares grant from the calendar owner. When unset the
  // push is skipped so the originating action still succeeds (calendar
  // mirroring is best-effort, never load-bearing).
  CONTACTUI_SERVICE_KEY?: string
  // Optional tiebreak, only needed if more than one board is ever shared with
  // this worker. Normally unset — the board is discovered.
  TASK_CALENDAR_BOARD?: string
  // Override for the create endpoint (tests / local). Defaults to the edge route.
  TASK_API_URL?: string
}

export interface CalendarPushResult {
  ok: boolean
  skipped?: boolean
  status?: number
  taskId?: string
  error?: string
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/** Canonical UTC calendar day (YYYY-MM-DD) for an all-day event. */
function toUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/**
 * Map a booked appointment onto a task-api CreateTaskInput body (timed event).
 *
 * The id is DETERMINISTIC (`<source>-<appointmentId>`) so an accidental re-send
 * upserts the same task instead of duplicating it.
 */
export function buildTaskFromAppointment(
  appt: StoredAppointment,
  source = 'contact'
): Record<string, unknown> {
  return {
    id: `${source}-${appt.id}`,
    title: `Meeting: ${appt.name}`,
    startTime: appt.start_time,
    endTime: appt.end_time,
    tag: 'contact',
    source,
    sourceId: appt.id,
    createdAt: toIso(appt.created_at),
    metadata: {
      scheduledBy: appt.email,
      name: appt.name,
      scheduledAt: toIso(appt.created_at),
      message: appt.message ?? undefined,
      platform: appt.platform,
      meetingLink: appt.meeting_link ?? undefined,
      meetingId: appt.meeting_id ?? undefined,
      timezone: appt.timezone,
      duration: appt.duration,
      status: appt.status
    }
  }
}

/**
 * Map an admin outbound-mail submission onto a CreateTaskInput body. Mail has no
 * time slot, so this is an ALL-DAY event: send `date`, omit startTime/endTime
 * (the server keys it to that UTC day). Deterministic id `admin-mail-<id>`.
 */
export function buildTaskFromMail(
  sub: StoredSubmission,
  opts: { source?: string; sentBy?: string } = {}
): Record<string, unknown> {
  const source = opts.source ?? 'admin-mail'
  return {
    id: `${source}-${sub.id}`,
    // `name` carries the email subject for outbound admin mail.
    title: `Mail: ${sub.name}`,
    date: toUtcDate(sub.created_at),
    tag: 'mail',
    source,
    sourceId: sub.id,
    createdAt: toIso(sub.created_at),
    metadata: {
      subject: sub.name,
      to: sub.email,
      from: sub.recipient ?? undefined,
      message: sub.message,
      direction: sub.direction,
      sentBy: opts.sentBy ?? undefined,
      sentAt: toIso(sub.created_at)
    }
  }
}

/**
 * Board reference to write into: the one board SHARED with this worker.
 *
 * `GET /boards` returns every board this caller can see, and a shared board's
 * `id` is its globally-unique handle (task-api routes that to the owner), with
 * `access` set to the grant level — 'owner' means it is our own board. So the
 * selection is: not-owner. Never match on display name; two accounts can both
 * have a "main", which is exactly how a mirror ends up in the wrong calendar.
 *
 * Cached per isolate after the first success. The grant changes about never,
 * and a fetch per appointment would add a round-trip to a best-effort path.
 * A failure is not cached, so a transient error self-heals on the next push.
 */
let cachedBoardRef: string | null = null

interface BoardSummary {
  id?: unknown
  access?: unknown
  name?: unknown
}

export async function resolveCalendarBoard(
  env: TaskCalendarEnv,
  key: string
): Promise<string | null> {
  if (env.TASK_CALENDAR_BOARD) return env.TASK_CALENDAR_BOARD
  if (cachedBoardRef) return cachedBoardRef

  const base = env.TASK_API_URL || DEFAULT_TASK_API_URL
  try {
    const res = await fetch(`${base}/boards`, { headers: { 'X-User-Key': key } })
    if (!res.ok) {
      console.error(`[task-calendar] board discovery failed (HTTP ${res.status})`)
      return null
    }
    const body = (await res.json()) as { boards?: BoardSummary[] }
    const shared = (body.boards ?? []).filter(
      b => typeof b.access === 'string' && b.access !== 'owner' && typeof b.id === 'string'
    )
    if (shared.length === 0) {
      console.warn(
        '[task-calendar] no board is shared with this worker; skipping calendar push. ' +
          'The calendar owner must share their board with us as contributor.'
      )
      return null
    }
    if (shared.length > 1) {
      // Refuse rather than guess: picking the wrong one writes a private
      // appointment into somebody else's calendar.
      console.error(
        `[task-calendar] ${shared.length} boards are shared with this worker ` +
          `(${shared.map(b => String(b.id)).join(', ')}); set TASK_CALENDAR_BOARD to disambiguate`
      )
      return null
    }
    cachedBoardRef = String(shared[0].id)
    console.log(`[task-calendar] using shared board ${cachedBoardRef}`)
    return cachedBoardRef
  } catch (err) {
    console.error('[task-calendar] board discovery errored:', err)
    return null
  }
}

/** Test seam — drop the memoised board so a spec can re-drive discovery. */
export function __resetCalendarBoardCache(): void {
  cachedBoardRef = null
}

/**
 * POST a pre-built CreateTaskInput body to the owner's task calendar. Resolves
 * (never rejects) — a calendar failure must not fail the action it mirrors.
 * Best-effort: callers typically hand the returned promise to
 * `executionCtx.waitUntil`.
 */
export async function postTaskToCalendar(
  body: Record<string, unknown>,
  env: TaskCalendarEnv
): Promise<CalendarPushResult> {
  const key = env.CONTACTUI_SERVICE_KEY
  if (!key) {
    console.warn('[task-calendar] CONTACTUI_SERVICE_KEY not set; skipping calendar push')
    return { ok: false, skipped: true }
  }
  const board = await resolveCalendarBoard(env, key)
  if (!board) return { ok: false, skipped: true }

  const url = env.TASK_API_URL || DEFAULT_TASK_API_URL
  const id = String(body.id)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Key': key
      },
      // The handle routes the write to the owner's board via their share grant.
      body: JSON.stringify({ ...body, boardId: board })
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(
        `[task-calendar] push failed (HTTP ${res.status}) for ${id}: ${text.slice(0, 300)}`
      )
      return { ok: false, status: res.status, error: text.slice(0, 300) }
    }

    console.log(`[task-calendar] created task ${id}`)
    return { ok: true, status: res.status, taskId: id }
  } catch (err) {
    console.error(`[task-calendar] push errored for ${id}:`, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Mirror a booked appointment into the owner's calendar (timed event). */
export function pushAppointmentToCalendar(
  appt: StoredAppointment,
  env: TaskCalendarEnv,
  source = 'contact'
): Promise<CalendarPushResult> {
  return postTaskToCalendar(buildTaskFromAppointment(appt, source), env)
}

/** Mirror an admin outbound-mail submission into the owner's calendar (all-day). */
export function pushMailToCalendar(
  sub: StoredSubmission,
  env: TaskCalendarEnv,
  opts: { source?: string; sentBy?: string } = {}
): Promise<CalendarPushResult> {
  return postTaskToCalendar(buildTaskFromMail(sub, opts), env)
}
