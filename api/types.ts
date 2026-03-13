/**
 * Contact API types
 */

export interface ContactEnv {
  DB: D1Database
  RATE_LIMIT_KV: KVNamespace
  TEMPLATES_KV: KVNamespace
  ANALYTICS_ENGINE?: AnalyticsEngineDataset
  ADMIN_KEYS?: string
  FRIEND_KEYS?: string
  EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string
}

export interface ContactHandlerOptions {
  rateLimit?: {
    maxSubmissionsPerHour?: number
    windowDurationSeconds?: number
  }
  additionalOrigins?: string[]
}

export interface HadokuAuthContext {
  userType: 'admin' | 'friend' | 'public'
  credential: string | null
}

export interface AppContext {
  Bindings: ContactEnv
  Variables: {
    authContext: HadokuAuthContext
  }
}
