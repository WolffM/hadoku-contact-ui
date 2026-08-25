import type {
  AvailabilityResponse,
  BookingWindowConfig,
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse,
  AppointmentError,
  TimeSlotDuration
} from '../types'
import {
  mockFetchAvailability,
  mockFetchAvailableSlots,
  mockFetchBookingWindow,
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
 * Fetch the booking window the server enforces.
 *
 * The calendar needs it to know which dates are offerable at all. Failing this
 * is not fatal: the caller falls back to showing every future date, which is
 * what the form did before the endpoint existed.
 */
export async function fetchBookingWindow(): Promise<BookingWindowConfig> {
  if (shouldUseMockAPI()) {
    return mockFetchBookingWindow()
  }

  const response = await fetch(`${API_BASE_URL}/appointments/config`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new AppointmentAPIError(
      'network',
      `Failed to load booking window: ${response.statusText}`,
      true
    )
  }

  return (await response.json()) as BookingWindowConfig
}

/**
 * Which dates in `[from, to]` still have a slot free, and how many.
 *
 * The calendar greys out everything this does not name. It is the only question
 * whose answer is "can the user click this day" — the booking window alone
 * cannot tell you, because a day can clear every rule and still be full.
 */
export async function fetchAvailability(
  duration: TimeSlotDuration,
  from: string,
  to: string
): Promise<AvailabilityResponse> {
  if (shouldUseMockAPI()) {
    return mockFetchAvailability(duration, from, to)
  }

  const params = new URLSearchParams({ duration: duration.toString(), from, to })
  const response = await fetch(`${API_BASE_URL}/appointments/availability?${params}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new AppointmentAPIError(
      'network',
      `Failed to load availability: ${response.statusText}`,
      true
    )
  }

  return (await response.json()) as AvailabilityResponse
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

      // A 400 here is the day itself being refused — outside the notice window,
      // past the far bound, or not a working day. That is not something to show
      // the user: the calendar should already have greyed the date, so the
      // caller treats this as "nothing on this day" and refreshes the greying
      // rather than surfacing a rule they cannot act on.
      throw new AppointmentAPIError(
        response.status === 400 ? 'validation' : 'network',
        errorData.message || `Failed to fetch slots: ${response.statusText}`,
        response.status !== 400
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
