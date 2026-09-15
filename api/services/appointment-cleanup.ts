/**
 * What has to happen when a meeting stops being a meeting.
 *
 * A booking is not one row. It is an `appointments` row holding the slot, an
 * event mirrored into the operator's task calendar, and — for Discord — a
 * private space in the guild: a category, two channels, a role, a live invite
 * and a pending reminder. Cancelling by flipping a status column leaves the
 * other three running.
 *
 * This module is the single definition of the teardown, and every path that
 * ends a meeting goes through it. There were two such paths and they did
 * different things:
 *
 *   - `PATCH /appointments/:id/status` with `cancelled` retracted the calendar
 *     event and revoked the space.
 *   - `DELETE /submissions/:id` — what the command station's delete button
 *     calls — soft-deleted the message and stopped there. The appointment
 *     stayed `confirmed`, so the slot stayed blocked; the calendar entry stayed;
 *     and the guest kept a working invite to a private space that outlived the
 *     meeting it was made for, until the 8-day sweep happened to collect it.
 *
 * ## Deleting the message cancels the meeting
 *
 * That is a decision, not a side effect. Trash is reversible for a MESSAGE and
 * cannot be for a meeting: restoring the submission cannot un-revoke a
 * single-use Discord invite or rebuild a category, and pretending otherwise
 * would restore a row pointing at channels that no longer exist. So a restored
 * submission comes back as mail, with its appointment left cancelled and its
 * slot left free — which is also the answer the operator asked for by deleting
 * the thing off their calendar.
 *
 * ## Failures do not block the delete
 *
 * Both side effects are best-effort and logged. The database write is the part
 * that must land: a cancelled row frees the slot, and a slot nobody can book is
 * worse than a category that needs sweeping. The space sweep and the calendar
 * mirror both converge on their own — an orphaned space is collected by TTL,
 * and a stale calendar entry is visible to the one person who owns it.
 */

import {
  getAppointmentById,
  getAppointmentsBySubmissionIds,
  updateAppointmentStatus
} from '../storage'
import { removeAppointmentFromCalendar } from './task-calendar'
import { revokeMeetingSpace, isSpaceId } from './meeting-space'
import type { ContactEnv } from '../types'

/**
 * Retract everything a confirmed booking put OUTSIDE this database.
 *
 * Does not touch the appointment row — the callers differ on what the row
 * should say (`cancelled` from a delete, whatever the operator chose from a
 * status PATCH) and only agree on the teardown.
 */
export async function retractMeetingArtifacts(
  appointmentId: string,
  env: ContactEnv
): Promise<void> {
  await Promise.all([
    removeAppointmentFromCalendar(appointmentId, env).catch(error => {
      console.error(`Failed to retract calendar event for appointment ${appointmentId}:`, error)
    }),
    revokeSpaceForAppointment(appointmentId, env)
  ])
}

/**
 * Revoke the Discord space a booking owns, if it owns one.
 *
 * Three ways to own nothing, all normal: a Jitsi or Meet booking, a Discord
 * booking made before spaces existed (those carry `discord-<slotId>` in
 * meeting_id, which `isSpaceId` rejects), and a booking whose provisioning
 * failed. None of them are errors, and none is sent to the revoke route.
 */
export async function revokeSpaceForAppointment(id: string, env: ContactEnv): Promise<void> {
  const appointment = await getAppointmentById(env.DB, id)
  if (!appointment || appointment.platform !== 'discord') return
  if (!isSpaceId(appointment.meeting_id)) return

  const result = await revokeMeetingSpace(appointment.meeting_id as string, env)
  if (!result.ok) {
    console.error(`Failed to revoke meeting space for appointment ${id}:`, result.error)
  }
}

/**
 * Cancel whatever meeting a submission booked, and tear its space down.
 *
 * A no-op for the mail that booked nothing, which is most of it — and for one
 * already cancelled, so deleting a submission twice does not fire a second
 * revoke at a space that is already gone.
 *
 * Returns the appointment id it acted on, for the caller's log.
 */
export async function cancelAppointmentForSubmission(
  submissionId: string,
  env: ContactEnv
): Promise<string | null> {
  const bySubmission = await getAppointmentsBySubmissionIds(env.DB, [submissionId])
  const appointment = bySubmission.get(submissionId)
  if (!appointment) return null
  if (appointment.status !== 'confirmed') return null

  await updateAppointmentStatus(env.DB, appointment.id, 'cancelled')
  await retractMeetingArtifacts(appointment.id, env)
  return appointment.id
}
