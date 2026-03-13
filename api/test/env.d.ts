declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    RATE_LIMIT_KV: KVNamespace
    TEMPLATES_KV: KVNamespace
    ADMIN_KEYS: string
    FRIEND_KEYS: string
    EMAIL_PROVIDER: string
    RESEND_API_KEY: string
  }
}

declare module '*.sql' {
  const sql: string
  export default sql
}
