/**
 * Abstract email provider interface
 */

export interface EmailParams {
  from: string
  to: string
  subject: string
  text: string
  replyTo?: string
}

export interface EmailResponse {
  success: boolean
  messageId?: string
  error?: string
}

export interface EmailProvider {
  sendEmail(params: EmailParams): Promise<EmailResponse>
}
