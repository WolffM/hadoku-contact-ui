import { logger } from '@wolffm/task-ui-components'
import type {
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse,
  AppointmentSlot,
  TimeSlotDuration
} from '../types'

/**
 * Mock API responses for development and testing
 * Enable by setting VITE_USE_MOCK_API=true in .env
 */

// Mock API configuration constants
const MOCK_DELAY_MS = 800
const BUSINESS_START_HOUR = 9 // 9 AM
const BUSINESS_END_HOUR = 17 // 5 PM
const SLOT_UNAVAILABLE_PROBABILITY = 0.2 // 20% chance slot is unavailable
const CONFLICT_PROBABILITY = 0.1 // 10% chance of slot conflict on submit
const RATE_LIMIT_PROBABILITY = 0.05 // 5% chance of rate limit on submit

/**
 * Generate mock time slots for a given date
 */
function generateMockSlots(date: string, duration: TimeSlotDuration): AppointmentSlot[] {
  const slots: AppointmentSlot[] = []
  const baseDate = new Date(date)

  for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
    for (let minute = 0; minute < 60; minute += duration) {
      if (hour === BUSINESS_END_HOUR - 1 && minute + duration > 60) break

      const startTime = new Date(baseDate)
      startTime.setHours(hour, minute, 0, 0)

      const endTime = new Date(startTime)
      endTime.setMinutes(endTime.getMinutes() + duration)

      // Randomly mark some slots as unavailable
      const available = Math.random() > SLOT_UNAVAILABLE_PROBABILITY

      slots.push({
        id: `slot-${date}-${hour}-${minute}-${duration}`,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        available
      })
    }
  }

  return slots
}

/**
 * Mock fetch available slots
 */
export async function mockFetchAvailableSlots(
  date: string,
  duration: TimeSlotDuration
): Promise<FetchSlotsResponse> {
  logger.apiRequest('GET', '/appointments/slots', { date, duration })

  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, MOCK_DELAY_MS))

  const slots = generateMockSlots(date, duration)

  const response: FetchSlotsResponse = {
    date,
    duration,
    slots,
    timezone: 'America/Los_Angeles' // PST/PDT
  }

  logger.apiResponse('GET', '/appointments/slots', 200, { slotsCount: slots.length })
  return response
}

/**
 * Mock submit contact form with appointment
 */
export async function mockSubmitContactWithAppointment(
  request: SubmitContactRequest
): Promise<SubmitContactResponse> {
  logger.apiRequest('POST', '/submit', {
    hasAppointment: !!request.appointment,
    name: request.name,
    email: request.email
  })

  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, MOCK_DELAY_MS))

  // Simulate honeypot check
  if (request.website) {
    logger.warn('[MOCK API] Honeypot triggered, rejecting spam')
    logger.apiResponse('POST', '/submit', 400, { reason: 'spam' })
    return {
      success: false,
      error: 'Spam detected'
    }
  }

  // Simulate chance of slot conflict
  if (request.appointment && Math.random() < CONFLICT_PROBABILITY) {
    logger.warn('[MOCK API] Simulating slot conflict')

    // Generate new available slots
    const updatedSlots = generateMockSlots(request.appointment.date, request.appointment.duration)

    logger.apiResponse('POST', '/submit', 409, { reason: 'slot_taken' })
    return {
      success: false,
      message: 'This time slot was just booked',
      conflict: {
        reason: 'slot_taken',
        updatedSlots: updatedSlots.filter(s => s.available)
      }
    }
  }

  // Simulate chance of rate limit
  if (Math.random() < RATE_LIMIT_PROBABILITY) {
    logger.warn('[MOCK API] Simulating rate limit')
    logger.apiResponse('POST', '/submit', 429, { reason: 'rate_limit' })
    return {
      success: false,
      message: 'Too many booking attempts. Please try again later.',
      conflict: {
        reason: 'rate_limit'
      }
    }
  }

  // Success
  logger.info('[MOCK API] Contact form submitted successfully')
  logger.apiResponse('POST', '/submit', 200, { hasAppointment: !!request.appointment })
  return {
    success: true,
    message: request.appointment
      ? 'Your message has been sent and appointment booked!'
      : 'Your message has been sent!'
  }
}

/**
 * Check if mock API should be used
 */
export function shouldUseMockAPI(): boolean {
  // Check if running in development mode
  const isDev = import.meta.env.DEV

  // Check if mock API is explicitly enabled
  const mockEnabled = import.meta.env.VITE_USE_MOCK_API === 'true'

  // Use mock API if in dev mode OR explicitly enabled
  return isDev || mockEnabled
}
