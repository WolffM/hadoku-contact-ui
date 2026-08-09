/**
 * Shared constants for the contact API
 * Centralizes all magic numbers and strings
 */

// Email configuration
export const EMAIL_CONFIG = {
  DEFAULT_FROM: 'matthaeus@hadoku.me',
  /**
   * Display name on outbound mail — the most prominent thing in a recipient's
   * inbox list, and often the only thing they read before deciding to open.
   *
   * It was the literal 'Hadoku Mail', hardcoded separately in the Resend and
   * MailChannels providers. A reply from a person that announces itself as a
   * brand reads like a ticketing system, which is the opposite of what this
   * domain's mail is for: recruiters and business contacts replying to a human.
   *
   * Overridable per-message via `EmailParams.fromName`, and per-deployment via
   * the `EMAIL_FROM_NAME` binding, so changing it does not need a package
   * release.
   */
  DEFAULT_FROM_NAME: 'Matthaeus Wolff',
  VALID_DOMAINS: ['hadoku.me'],
  // Recipients that bypass the whitelist/referrer checks.
  //
  // "Public" here means "accept mail from anyone", NOT "publicly advertised".
  // The distinction matters: everything below is a real mailbox the operator
  // actually receives at, and until 2026-08-07 a mailbox missing from this list
  // silently discarded every message from an address that had not been emailed
  // first. That cost 26 real emails (GitHub billing, PyPI 2FA, insurance) which
  // were only readable in the Resend dashboard.
  //
  // Mail failing this check is now quarantined rather than dropped, so a
  // missing entry is recoverable — it lands in the Filtered folder instead of
  // the Inbox. The list is still the difference between "arrives" and "arrives
  // somewhere you have to go looking".
  //
  // Deliberately permissive for now; per-sender filtering is the follow-up.
  PUBLIC_RECIPIENTS: [
    'public@hadoku.me',
    'meeting@hadoku.me',
    'test@hadoku.me',
    'alert@hadoku.me',
    // The primary mailbox. It is also DEFAULT_FROM, which made its absence
    // here especially costly: every cold email to the address the operator
    // sends FROM was discarded.
    'matthaeus@hadoku.me',
    // Per-service aliases used for signups. Their senders are transactional
    // no-reply addresses that will never be whitelisted by a reply, so the
    // whitelist gate could only ever reject them.
    'wolffm@hadoku.me',
    'pypi@hadoku.me',
    'deadlock@hadoku.me',
    'geico@hadoku.me',
    // The rua= target in the _dmarc.hadoku.me record. Aggregate reports are
    // machine-generated XML and arrive from arbitrary receiving domains, so
    // the whitelist can never pass them.
    'dmarc@hadoku.me'
  ],
  // No-reply address - replies will use sender's from address
  NO_REPLY_ADDRESS: 'no-reply@hadoku.me'
} as const

// Inbound email routing — recipients whose mail is forwarded to external
// services instead of being stored as a contact submission. Each entry
// maps to the env binding that holds the destination URL + auth key.
export const FORWARD_RECIPIENTS = {
  'pickleball-waitlist@hadoku.me': {
    urlEnv: 'SCRAPER_API_URL',
    keyEnv: 'SCRAPER_API_KEY',
    path: '/api/v1/pickleball/waitlist-trigger',
    label: 'pickleball-waitlist'
  }
} as const

export type ForwardRecipient = keyof typeof FORWARD_RECIPIENTS

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

// Inbound reconciliation — the sweep that makes the mailbox converge on what
// Resend actually holds, instead of on whatever the webhook happened to catch.
export const INBOUND_SYNC_CONFIG = {
  // Must not exceed RETENTION_CONFIG.ARCHIVE_AFTER_DAYS. Mail older than the
  // archive horizon has already been moved out of contact_submissions by daily
  // maintenance; pulling it back in would re-archive it every night forever.
  MAX_AGE_DAYS: RETENTION_CONFIG.ARCHIVE_AFTER_DAYS,
  // Resend caps `limit` at 100.
  PAGE_SIZE: 100,
  // Ceiling on a single sweep. 10 x 100 covers a month of mail an order of
  // magnitude over any plausible volume, and bounds the worst case (a wedged
  // ledger, a clock skew) to a fixed amount of work per run rather than an
  // unbounded walk of the whole account.
  MAX_PAGES: 10,
  // How many NEW emails one run may ingest before stopping and leaving the rest
  // for the next run. This is a WALL-CLOCK bound, not a correctness one.
  //
  // Each ingest costs a sequential Resend retrieve (the list endpoint does not
  // return bodies), so cost scales with the backlog — and mgmt-api's cron
  // dispatch aborts at DISPATCH_TIMEOUT_MS = 15s, with edge-router capping
  // around 30s behind it. The very first production sweep ingested 26 emails,
  // overran the 15s dispatch, and paged "contact api unavailable" for work that
  // had in fact completed: the sweep kept running server-side and wrote all 26.
  // A reconciliation job that pages on success is worse than useless.
  //
  // 10 keeps a full run near ~6s, comfortably inside both caps. Draining is not
  // sacrificed: at one run per 10 minutes that is 1,440 emails/day of catch-up
  // capacity, and steady state is 0-2 per run, so this only ever engages after
  // an outage or on a cold start.
  MAX_INGESTS_PER_RUN: 10
} as const

// Rate limiting
export const RATE_LIMIT_CONFIG = {
  MAX_SUBMISSIONS_PER_HOUR: 5,
  WINDOW_DURATION_SECONDS: 3600, // 1 hour
  KV_TTL_SECONDS: 3600 // 1 hour
} as const

// Appointment configuration
//
// VALID_PLATFORMS = those bookable through the API today. Discord uses a
// static invite; Jitsi constructs a meet.jit.si URL; Google Meet creates a
// link via Google Calendar API (requires GOOGLE_OAUTH_REFRESH_TOKEN +
// GOOGLE_OAUTH_CLIENT_ID/SECRET — falls back to error if not configured).
//
// Microsoft Teams is intentionally excluded — requires paid M365 + Entra ID
// + admin-consented app registration.
//
// STORED_PLATFORMS = platforms that may exist in the D1 `appointments` table
// (historical rows). Wider superset for reading existing data including 'teams'.
export const APPOINTMENT_CONFIG = {
  VALID_DURATIONS: [15, 30, 60] as const,
  VALID_PLATFORMS: ['discord', 'jitsi', 'google'] as const,
  STORED_PLATFORMS: ['discord', 'jitsi', 'google', 'teams'] as const,
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
// AppointmentPlatform = platforms accepted on new bookings (narrow).
// StoredAppointmentPlatform = platforms that may appear in D1 (wide, includes legacy).
export type AppointmentPlatform = (typeof APPOINTMENT_CONFIG.VALID_PLATFORMS)[number]
export type StoredAppointmentPlatform = (typeof APPOINTMENT_CONFIG.STORED_PLATFORMS)[number]
export type TemplateType = (typeof TEMPLATE_CONFIG.TEMPLATE_TYPES)[number]
export type TemplateStatus = (typeof TEMPLATE_CONFIG.TEMPLATE_STATUSES)[number]
export type AppointmentDuration = (typeof APPOINTMENT_CONFIG.VALID_DURATIONS)[number]
