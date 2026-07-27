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
 * service-tier identity) and address the owner's calendar by its shared-board
 * HANDLE. task-api resolves the handle against `board_shares`, confirms this
 * caller is a grantee, and writes into the OWNER's rows.
 *
 * This replaced a dedicated `CONTACT_SYNC_KEY` (2026-07-26). That key existed
 * only because the create endpoint had no way to address someone else's board:
 * storage followed the presented credential, so mirroring into the owner's
 * calendar meant BEING the owner — which is why a contact form worker ended up
 * holding an admin-tier credential. Shared boards removed the reason, so the
 * key was deleted rather than downgraded.
 *
 * A shared board is addressable ONLY by handle: a plain slug always resolves
 * inside the caller's own namespace (that is the security invariant in
 * board-sharing.ts), so `TASK_CALENDAR_BOARD` must be the handle, not "main".
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
  // Handle of the owner's calendar board, shared with us as contributor. MUST be
  // the handle (e.g. MRY93H8LG7ZCSK998165RCUBHW), never a slug like "main" —
  // slugs resolve inside the caller's own namespace, so a slug here would
  // silently mirror into this worker's own empty board instead of the owner's.
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
  const board = env.TASK_CALENDAR_BOARD
  if (!board) {
    console.warn('[task-calendar] TASK_CALENDAR_BOARD not set; skipping calendar push')
    return { ok: false, skipped: true }
  }

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
