export { createContactHandler } from './handler'
// The worker that mounts the handler must also export this class and bind it as
// MAIL_PUSH (a Durable Object, sqlite-backed) — see AGENTS.md, "Mail push".
export { MailPushHub, MAIL_PUSH_PROTOCOL } from './push/mail-push'
export type { ContactEnv, ContactHandlerOptions, HadokuAuthContext, AppContext } from './types'
export type {
  ContactSubmission,
  ValidationError,
  ValidationResult,
  AppointmentData,
  AppointmentValidationResult
} from './validation'
export type { RateLimitConfig, RateLimitResult } from './rate-limit'
