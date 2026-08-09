/**
 * Abstract email provider interface
 */

export interface EmailParams {
  from: string
  to: string
  subject: string
  text: string
  replyTo?: string
  /**
   * Display name shown in the recipient's inbox list, e.g.
   * `Matthaeus Wolff <matthaeus@hadoku.me>`.
   *
   * Defaults to `EMAIL_CONFIG.DEFAULT_FROM_NAME` when omitted. Every provider
   * must honour it: the name used to be the hardcoded literal 'Hadoku Mail' in
   * BOTH implementations, so changing it meant editing two files that could
   * silently disagree.
   */
  fromName?: string
}

export interface EmailResponse {
  success: boolean
  messageId?: string
  error?: string
}

export interface EmailProvider {
  sendEmail(params: EmailParams): Promise<EmailResponse>
}
