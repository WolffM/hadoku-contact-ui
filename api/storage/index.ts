/**
 * Storage layer exports
 */

export {
  type StoredSubmission,
  type CreateSubmissionParams,
  type SubmissionStats,
  type FilteredReason,
  createSubmission,
  adoptSubmissionForResendId,
  getAllSubmissions,
  getSubmissionById,
  updateSubmissionStatus,
  deleteSubmission,
  restoreSubmission,
  purgeOldDeletedSubmissions,
  purgeOldSpamSubmissions,
  releaseQuarantinedSubmissions,
  getSubmissionStats,
  archiveOldSubmissions
} from './submissions'

export {
  type BlockKind,
  type BlocklistEntry,
  domainOf,
  normalizeBlockPattern,
  findBlockRule,
  getAllBlocklistEntries,
  addToBlocklist,
  applyBlockToExistingMail,
  removeFromBlocklist,
  restoreBlockedMail
} from './blocklist'

export {
  type InboundSource,
  type InboundOutcome,
  type InboundLedgerEntry,
  recordInboundEmail,
  getSeenEmailIds,
  getLedgerEntry
} from './inbound-ledger'

export {
  type WhitelistEntry,
  isEmailWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  getAllWhitelistedEmails
} from './whitelist'

export {
  type AppointmentConfig,
  type StoredAppointment,
  type CreateAppointmentParams,
  toBookingWindow,
  parseIntList,
  getAppointmentConfig,
  updateAppointmentConfig,
  createAppointment,
  isSlotAvailable,
  getAppointmentsByDate,
  getAppointmentsBySubmissionIds,
  getBookedSlotIdsInRange,
  getAllAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  markConfirmationSent,
  markReminderSent
} from './appointments'

export {
  type EmailTemplate,
  type ChatbotPrompt,
  type TemplateVersion,
  getEmailTemplate,
  getChatbotPrompt,
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
  getTemplateVersionHistory
} from './templates'

export { type DatabaseSize, getDatabaseSize, isDatabaseNearCapacity } from './database'
