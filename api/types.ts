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
  // ADMIN_KEYS/FRIEND_KEYS no longer read inbound (createEdgeAuth replaced the
  // inlined key validation). Kept until Step 5 prunes them from CF secrets.
  ADMIN_KEYS?: string
  FRIEND_KEYS?: string
  EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string
  // Inbound forwarding — scraper (pickleball waitlist trigger, etc.)
  SCRAPER_API_URL?: string
  SCRAPER_API_KEY?: string
  // task-calendar bridge — registered key identifying the calendar owner and an
  // optional endpoint override. See services/task-calendar.ts.
  CONTACT_SYNC_KEY?: string
  TASK_API_URL?: string
}

export interface ContactHandlerOptions {
  rateLimit?: {
    maxSubmissionsPerHour?: number
    windowDurationSeconds?: number
  }
  additionalOrigins?: string[]
}

export interface HadokuAuthContext {
  userType: 'admin' | 'service' | 'friend' | 'public'
  credential: string | null
}

export interface AppContext {
  Bindings: ContactEnv
  Variables: {
    authContext: HadokuAuthContext
  }
}
