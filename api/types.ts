/**
 * Contact API types
 */

export interface ContactEnv {
  DB: D1Database
  RATE_LIMIT_KV: KVNamespace
  TEMPLATES_KV: KVNamespace
  ANALYTICS_ENGINE?: AnalyticsEngineDataset
  // Edge provenance secret — createEdgeAuth verifies inbound X-Edge-Auth.
  EDGE_AUTH_SECRET?: string
  EMAIL_PROVIDER?: string
  // Display name on outbound mail. Overrides EMAIL_CONFIG.DEFAULT_FROM_NAME
  // so the name can change without republishing the package.
  EMAIL_FROM_NAME?: string
  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string
  // Inbound forwarding — scraper (pickleball waitlist trigger, etc.)
  SCRAPER_API_URL?: string
  SCRAPER_API_KEY?: string
  // task-calendar bridge — registered key identifying the calendar owner and an
  // optional endpoint override. See services/task-calendar.ts.
  CONTACTUI_SERVICE_KEY?: string
  TASK_CALENDAR_BOARD?: string
  TASK_API_URL?: string
  // Meeting-link generation (services/meeting-links.ts, services/google-meet.ts).
  // These were READ but never declared, which is why generateMeetingLink took
  // `Record<string, unknown>` — an escape hatch that also removed every
  // guarantee about the bindings it reads. Declaring them is what lets that
  // parameter be ContactEnv and a typo in a binding name be a compile error.
  JITSI_DOMAIN?: string
  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REFRESH_TOKEN?: string
  GOOGLE_CALENDAR_ID?: string
}

export interface ContactHandlerOptions {
  rateLimit?: {
    maxSubmissionsPerHour?: number
    windowDurationSeconds?: number
  }
  additionalOrigins?: string[]
}

export interface HadokuAuthContext {
  userType: 'admin' | 'wife' | 'service' | 'friend' | 'public'
  credential: string | null
}

export interface AppContext {
  Bindings: ContactEnv
  Variables: {
    authContext: HadokuAuthContext
  }
}
