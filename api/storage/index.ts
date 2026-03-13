/**
 * Storage layer exports
 */

export {
  type StoredSubmission,
  type CreateSubmissionParams,
  type SubmissionStats,
  createSubmission,
  getAllSubmissions,
  getSubmissionById,
  updateSubmissionStatus,
  deleteSubmission,
  restoreSubmission,
  purgeOldDeletedSubmissions,
  getSubmissionStats,
  archiveOldSubmissions
} from './submissions'

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
  getAppointmentConfig,
  updateAppointmentConfig,
  createAppointment,
  isSlotAvailable,
  getAppointmentsByDate,
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
