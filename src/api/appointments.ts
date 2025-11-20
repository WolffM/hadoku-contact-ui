import type {
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse,
  AppointmentError,
  TimeSlotDuration
} from '../types'
import {
  mockFetchAvailableSlots,
  mockSubmitContactWithAppointment,
  shouldUseMockAPI
} from './mockAppointments'

const API_BASE_URL = '/contact/api'

export class AppointmentAPIError extends Error {
  constructor(
    public type: AppointmentError['type'],
    message: string,
    public retryable: boolean = false,
    public updatedSlots?: AppointmentError['updatedSlots']
  ) {
    super(message)
    this.name = 'AppointmentAPIError'
  }
}

/**
 * Fetch available appointment slots for a given date and duration
 */
export async function fetchAvailableSlots(
  date: string,
  duration: TimeSlotDuration
): Promise<FetchSlotsResponse> {
  // Use mock API in development
  if (shouldUseMockAPI()) {
    return mockFetchAvailableSlots(date, duration)
  }

  try {
    const params = new URLSearchParams({
      date,
      duration: duration.toString()
    })

    const response = await fetch(`${API_BASE_URL}/appointments/slots?${params}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      if (response.status === 429) {
        throw new AppointmentAPIError(
          'rate_limit',
          'Too many requests. Please try again later.',
          true
        )
      }

      const errorData = await response.json().catch(() => ({}))
      throw new AppointmentAPIError(
        'network',
        errorData.message || `Failed to fetch slots: ${response.statusText}`,
        true
      )
    }

    const data: FetchSlotsResponse = await response.json()
    return data
  } catch (error) {
    if (error instanceof AppointmentAPIError) {
      throw error
    }

    throw new AppointmentAPIError(
      'network',
      'Network error. Please check your connection and try again.',
      true
    )
  }
}

/**
 * Submit contact form with optional appointment booking
 */
export async function submitContactWithAppointment(
  request: SubmitContactRequest
): Promise<SubmitContactResponse> {
  // Use mock API in development
  if (shouldUseMockAPI()) {
    return mockSubmitContactWithAppointment(request)
  }

  try {
    const response = await fetch(`${API_BASE_URL}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    })

    const data: SubmitContactResponse = await response.json()

    // Handle 409 Conflict (slot was taken)
    if (response.status === 409 && data.conflict) {
      throw new AppointmentAPIError(
        'conflict',
        data.conflict.reason === 'slot_taken'
          ? 'Sorry, this time slot was just booked. Please select another time.'
          : data.message || 'Conflict occurred',
        true,
        data.conflict.updatedSlots
      )
    }

    // Handle rate limiting
    if (response.status === 429) {
      throw new AppointmentAPIError(
        'rate_limit',
        data.message || 'Too many booking attempts. Please try again later.',
        false
      )
    }

    // Handle validation errors
    if (!response.ok && response.status === 400) {
      throw new AppointmentAPIError(
        'validation',
        data.message || data.errors?.join(', ') || 'Validation error',
        false
      )
    }

    // Handle other errors
    if (!response.ok) {
      throw new AppointmentAPIError(
        'network',
        data.message || data.error || 'Failed to submit contact form',
        true
      )
    }

    return data
  } catch (error) {
    if (error instanceof AppointmentAPIError) {
      throw error
    }

    throw new AppointmentAPIError(
      'network',
      'Network error. Please check your connection and try again.',
      true
    )
  }
}
