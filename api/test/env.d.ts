declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    RATE_LIMIT_KV: KVNamespace
    TEMPLATES_KV: KVNamespace
    EMAIL_PROVIDER: string
    RESEND_API_KEY: string
    RESEND_WEBHOOK_SECRET: string
    MAIL_PUSH: DurableObjectNamespace<import('../push/mail-push').MailPushHub>
  }
}

declare module '*.sql' {
  const sql: string
  export default sql
}
