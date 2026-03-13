/**
 * Validation utilities for contact form submissions
 */

import {
  VALIDATION_CONSTRAINTS,
  APPOINTMENT_CONFIG,
  SITE_CONFIG,
  type AppointmentPlatform
} from './constants'

export interface ContactSubmission {
  name: string
  email: string
  message: string
  recipient?: string
  website?: string
}

export interface ValidationError {
  path: string[]
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  sanitized?: ContactSubmission
}

function sanitizeString(value: string, maxLength: number): string {
  return value.trim().substring(0, maxLength)
}

function isHoneypotFilled(website?: string): boolean {
  return !!website && website.trim().length > 0
}

export function validateContactSubmission(data: unknown): ValidationResult {
  const errors: ValidationError[] = []

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: [{ path: ['body'], message: 'Invalid submission data' }] }
  }

  const submission = data as Record<string, unknown>

  if (isHoneypotFilled(submission.website as string | undefined)) {
    return {
      valid: false,
      errors: [{ path: ['website'], message: 'Submission rejected - bot detected' }]
    }
  }

  if (
    !submission.name ||
    typeof submission.name !== 'string' ||
    submission.name.trim().length === 0
  ) {
    errors.push({ path: ['name'], message: 'Name is required' })
  }

  if (
    !submission.email ||
    typeof submission.email !== 'string' ||
    submission.email.trim().length === 0
  ) {
    errors.push({ path: ['email'], message: 'Email is required' })
  }

  if (
    !submission.message ||
    typeof submission.message !== 'string' ||
    submission.message.trim().length === 0
  ) {
    errors.push({ path: ['message'], message: 'Message is required' })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const nameStr = submission.name as string
  const emailStr = submission.email as string
  const messageStr = submission.message as string

  let recipient: string | undefined
  if (submission.recipient) {
    if (typeof submission.recipient !== 'string') {
      errors.push({ path: ['recipient'], message: 'Recipient must be a string' })
    } else {
      recipient = submission.recipient.trim()
      if (!VALIDATION_CONSTRAINTS.EMAIL_REGEX.test(recipient)) {
        errors.push({ path: ['recipient'], message: 'Invalid recipient email format' })
      }
      const domain = recipient.split('@')[1]
      if (domain && !['hadoku.me'].includes(domain.toLowerCase())) {
        errors.push({ path: ['recipient'], message: 'Recipient must be from hadoku.me domain' })
      }
    }
  }

  if (nameStr.trim().length > VALIDATION_CONSTRAINTS.NAME_MAX_LENGTH) {
    errors.push({
      path: ['name'],
      message: `Name must not exceed ${VALIDATION_CONSTRAINTS.NAME_MAX_LENGTH} characters`
    })
  }

  if (emailStr.trim().length > VALIDATION_CONSTRAINTS.EMAIL_MAX_LENGTH) {
    errors.push({
      path: ['email'],
      message: `Email must not exceed ${VALIDATION_CONSTRAINTS.EMAIL_MAX_LENGTH} characters`
    })
  }

  if (messageStr.trim().length > VALIDATION_CONSTRAINTS.MESSAGE_MAX_LENGTH) {
    errors.push({
      path: ['message'],
      message: `Message must not exceed ${VALIDATION_CONSTRAINTS.MESSAGE_MAX_LENGTH} characters`
    })
  }

  const name = sanitizeString(nameStr, VALIDATION_CONSTRAINTS.NAME_MAX_LENGTH)
  const email = sanitizeString(emailStr, VALIDATION_CONSTRAINTS.EMAIL_MAX_LENGTH)
  const message = sanitizeString(messageStr, VALIDATION_CONSTRAINTS.MESSAGE_MAX_LENGTH)

  if (name.length < VALIDATION_CONSTRAINTS.NAME_MIN_LENGTH) {
    errors.push({
      path: ['name'],
      message: `Name must be at least ${VALIDATION_CONSTRAINTS.NAME_MIN_LENGTH} characters`
    })
  }

  if (email.length < VALIDATION_CONSTRAINTS.EMAIL_MIN_LENGTH) {
    errors.push({
      path: ['email'],
      message: `Email must be at least ${VALIDATION_CONSTRAINTS.EMAIL_MIN_LENGTH} characters`
    })
  }

  if (message.length < VALIDATION_CONSTRAINTS.MESSAGE_MIN_LENGTH) {
    errors.push({
      path: ['message'],
      message: `Message must be at least ${VALIDATION_CONSTRAINTS.MESSAGE_MIN_LENGTH} characters`
    })
  }

  if (!VALIDATION_CONSTRAINTS.EMAIL_REGEX.test(email)) {
    errors.push({ path: ['email'], message: 'Email format is invalid' })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    errors: [],
    sanitized: {
      name,
      email,
      message,
      recipient,
      website: ''
    }
  }
}

export function extractClientIP(request: Request): string | null {
  const cfIP = request.headers.get('CF-Connecting-IP')
  if (cfIP) return cfIP

  const xForwardedFor = request.headers.get('X-Forwarded-For')
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim()
  }

  const xRealIP = request.headers.get('X-Real-IP')
  if (xRealIP) return xRealIP

  return null
}

export function extractReferrer(request: Request): string | null {
  return request.headers.get('Referer') ?? request.headers.get('Referrer') ?? null
}

export function validateReferrer(request: Request): boolean {
  const referrer = extractReferrer(request)

  if (!referrer) return true

  try {
    const url = new URL(referrer)
    const hostname = url.hostname.toLowerCase()

    return SITE_CONFIG.ALLOWED_REFERRER_DOMAINS.some(
      domain => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}

export interface AppointmentData {
  slotId: string
  date: string
  startTime: string
  endTime: string
  duration: number
  platform: AppointmentPlatform
}

export interface AppointmentValidationResult {
  valid: boolean
  errors: ValidationError[]
  sanitized?: AppointmentData
}

export function validateAppointment(data: unknown): AppointmentValidationResult {
  const errors: ValidationError[] = []

  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      errors: [{ path: ['appointment'], message: 'Invalid appointment data' }]
    }
  }

  const appointment = data as Record<string, unknown>

  if (
    !appointment.slotId ||
    typeof appointment.slotId !== 'string' ||
    appointment.slotId.trim().length === 0
  ) {
    errors.push({ path: ['appointment', 'slotId'], message: 'Slot ID is required' })
  }

  if (!appointment.date || typeof appointment.date !== 'string') {
    errors.push({ path: ['appointment', 'date'], message: 'Date is required' })
  }

  if (!appointment.startTime || typeof appointment.startTime !== 'string') {
    errors.push({ path: ['appointment', 'startTime'], message: 'Start time is required' })
  }

  if (!appointment.endTime || typeof appointment.endTime !== 'string') {
    errors.push({ path: ['appointment', 'endTime'], message: 'End time is required' })
  }

  if (typeof appointment.duration !== 'number') {
    errors.push({ path: ['appointment', 'duration'], message: 'Duration is required' })
  }

  if (!appointment.platform || typeof appointment.platform !== 'string') {
    errors.push({ path: ['appointment', 'platform'], message: 'Platform is required' })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  if (!APPOINTMENT_CONFIG.VALID_DURATIONS.includes(appointment.duration as 15 | 30 | 60)) {
    errors.push({
      path: ['appointment', 'duration'],
      message: `Duration must be one of: ${APPOINTMENT_CONFIG.VALID_DURATIONS.join(', ')} minutes`
    })
  }

  const platformLower = (appointment.platform as string).toLowerCase()
  if (
    !APPOINTMENT_CONFIG.VALID_PLATFORMS.includes(
      platformLower as 'discord' | 'google' | 'teams' | 'jitsi'
    )
  ) {
    errors.push({
      path: ['appointment', 'platform'],
      message: `Platform must be one of: ${APPOINTMENT_CONFIG.VALID_PLATFORMS.join(', ')}`
    })
  }

  if (!VALIDATION_CONSTRAINTS.DATE_FORMAT_REGEX.test(appointment.date as string)) {
    errors.push({ path: ['appointment', 'date'], message: 'Date must be in YYYY-MM-DD format' })
  } else {
    const date = new Date(appointment.date as string)
    if (isNaN(date.getTime())) {
      errors.push({ path: ['appointment', 'date'], message: 'Invalid date' })
    }
  }

  try {
    const startDate = new Date(appointment.startTime as string)
    const endDate = new Date(appointment.endTime as string)

    if (isNaN(startDate.getTime())) {
      errors.push({ path: ['appointment', 'startTime'], message: 'Invalid start time format' })
    }

    if (isNaN(endDate.getTime())) {
      errors.push({ path: ['appointment', 'endTime'], message: 'Invalid end time format' })
    }

    if (startDate.getTime() >= endDate.getTime()) {
      errors.push({ path: ['appointment'], message: 'End time must be after start time' })
    }
  } catch {
    errors.push({ path: ['appointment'], message: 'Invalid time format' })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    errors: [],
    sanitized: {
      slotId: (appointment.slotId as string).trim(),
      date: appointment.date as string,
      startTime: appointment.startTime as string,
      endTime: appointment.endTime as string,
      duration: appointment.duration as number,
      platform: (appointment.platform as string).toLowerCase() as AppointmentPlatform
    }
  }
}

export function validateSlotFetchRequest(
  date: string | null,
  duration: string | null
): {
  valid: boolean
  errors: string[]
  parsedDate?: string
  parsedDuration?: number
} {
  const errors: string[] = []

  if (!date) {
    errors.push('Date parameter is required')
  }

  if (!duration) {
    errors.push('Duration parameter is required')
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  if (!date || !duration) {
    return { valid: false, errors: ['Missing required parameters'] }
  }

  const dateValue = date
  const durationValue = duration

  if (!VALIDATION_CONSTRAINTS.DATE_FORMAT_REGEX.test(dateValue)) {
    errors.push('Date must be in YYYY-MM-DD format')
  } else {
    const parsedDate = new Date(dateValue)
    if (isNaN(parsedDate.getTime())) {
      errors.push('Invalid date')
    }
  }

  const parsedDuration = parseInt(durationValue, 10)
  if (
    isNaN(parsedDuration) ||
    !APPOINTMENT_CONFIG.VALID_DURATIONS.includes(parsedDuration as 15 | 30 | 60)
  ) {
    errors.push(`Duration must be one of: ${APPOINTMENT_CONFIG.VALID_DURATIONS.join(', ')}`)
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    errors: [],
    parsedDate: dateValue,
    parsedDuration: parseInt(durationValue, 10)
  }
}
