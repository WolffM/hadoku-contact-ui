/**
 * Shared constants for the contact API
 * Centralizes all magic numbers and strings
 */

// Email configuration
export const EMAIL_CONFIG = {
  DEFAULT_FROM: 'matthaeus@hadoku.me',
  VALID_DOMAINS: ['hadoku.me'],
  // Recipients that bypass whitelist/referrer checks (public-facing mailboxes)
  PUBLIC_RECIPIENTS: ['public@hadoku.me', 'meeting@hadoku.me', 'test@hadoku.me', 'alert@hadoku.me'],
  // No-reply address - replies will use sender's from address
  NO_REPLY_ADDRESS: 'no-reply@hadoku.me'
} as const

// Site configuration
export const SITE_CONFIG = {
  ALLOWED_REFERRER_DOMAINS: ['hadoku.me']
} as const

// Database configuration
export const DATABASE_CONFIG = {
  // D1 paid plan: 5 GB included
  FREE_TIER_LIMIT_BYTES: 5 * 1024 * 1024 * 1024,
  CAPACITY_WARNING_THRESHOLD: 0.8, // Warn at 80% capacity
  DEFAULT_PAGE_SIZE: 4096
} as const

// Archival and retention
export const RETENTION_CONFIG = {
  TRASH_RETENTION_DAYS: 7,
  ARCHIVE_AFTER_DAYS: 30
} as const

// Rate limiting
export const RATE_LIMIT_CONFIG = {
  MAX_SUBMISSIONS_PER_HOUR: 5,
  WINDOW_DURATION_SECONDS: 3600, // 1 hour
  KV_TTL_SECONDS: 3600 // 1 hour
} as const

// Appointment configuration
export const APPOINTMENT_CONFIG = {
  VALID_DURATIONS: [15, 30, 60] as const,
  VALID_PLATFORMS: ['discord', 'google', 'teams', 'jitsi'] as const,
  DEFAULT_TIMEZONE: 'America/Los_Angeles'
} as const

// Template configuration
export const TEMPLATE_CONFIG = {
  KV_CACHE_TTL_SECONDS: 3600, // 1 hour
  DEFAULT_LANGUAGE: 'en',
  TEMPLATE_TYPES: ['email', 'sms', 'push'] as const,
  TEMPLATE_STATUSES: ['active', 'draft', 'archived'] as const
} as const

// Validation constraints
export const VALIDATION_CONSTRAINTS = {
  NAME_MIN_LENGTH: 2,
  NAME_MAX_LENGTH: 100,
  EMAIL_MIN_LENGTH: 5,
  EMAIL_MAX_LENGTH: 100,
  MESSAGE_MIN_LENGTH: 10,
  MESSAGE_MAX_LENGTH: 5000,
  EMAIL_REGEX: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  DATE_FORMAT_REGEX: /^\d{4}-\d{2}-\d{2}$/
} as const

// Pagination defaults
export const PAGINATION_DEFAULTS = {
  LIMIT: 100,
  OFFSET: 0,
  MAX_VERSION_HISTORY: 20
} as const

// Type helpers
export type AppointmentPlatform = (typeof APPOINTMENT_CONFIG.VALID_PLATFORMS)[number]
export type TemplateType = (typeof TEMPLATE_CONFIG.TEMPLATE_TYPES)[number]
export type TemplateStatus = (typeof TEMPLATE_CONFIG.TEMPLATE_STATUSES)[number]
export type AppointmentDuration = (typeof APPOINTMENT_CONFIG.VALID_DURATIONS)[number]
