// Form data types
export interface FormData {
  name: string
  email: string
  message: string
  website: string // Honeypot
}

export interface FormErrors {
  name?: string
  email?: string
  message?: string
  appointment?: string
}

export type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error'

// Appointment types
export type TimeSlotDuration = 15 | 30 | 60

export type MeetingPlatform = 'discord' | 'google' | 'teams' | 'jitsi'

export interface AppointmentSlot {
  id: string
  startTime: string // ISO 8601 format
  endTime: string // ISO 8601 format
  available: boolean
}

export interface AppointmentSelection {
  date: Date | null
  duration: TimeSlotDuration
  selectedSlot: AppointmentSlot | null
  meetingPlatform: MeetingPlatform | null
  /**
   * True when the picker chose `date` itself rather than the user clicking it.
   *
   * The calendar opens on the next bookable day so the times are on screen
   * immediately, which means "a date is selected" is now the resting state of
   * the form rather than a sign that someone is trying to book. Sending a plain
   * message must not start demanding a time slot just because the calendar
   * defaulted to one — but a date the user actually picked and then left
   * without a time still should.
   */
  dateAutoSelected?: boolean
}

// API Request/Response types
/**
 * The server's booking window, fetched from `GET /appointments/config`.
 *
 * The calendar greys out dates with this rather than guessing. Its shape is
 * `BookingWindow` from `api/utils/booking-window` — the module both halves of
 * the package share — plus the two lists the pickers render.
 */
export interface BookingWindowConfig {
  timezone: string
  businessHoursStart: string
  businessHoursEnd: string
  availableDays: number[]
  minAdvanceHours: number
  maxAdvanceDays: number
  slotDurations: number[]
  platforms: string[]
}

export interface FetchSlotsRequest {
  date: string // YYYY-MM-DD
  duration: TimeSlotDuration
}

export interface FetchSlotsResponse {
  date: string
  duration: TimeSlotDuration
  slots: AppointmentSlot[]
  timezone: string
}

/**
 * Free-slot counts per date, from `GET /appointments/availability`.
 *
 * Only dates with something left on them appear. The calendar greys out every
 * date absent from `dates` — weekends, days inside the notice window, days past
 * the far bound and days booked solid are all just "not in here", so the UI
 * never has to re-derive the reason a date is unavailable, nor explain it.
 */
export interface AvailabilityResponse {
  duration: number
  from: string
  to: string
  timezone: string
  dates: Record<string, number>
}

export interface SubmitContactRequest {
  name: string
  email: string
  message: string
  website: string
  appointment?: {
    slotId: string
    date: string // YYYY-MM-DD
    startTime: string // ISO 8601
    endTime: string // ISO 8601
    duration: TimeSlotDuration
    platform: MeetingPlatform
  }
}

export interface SubmitContactResponse {
  success: boolean
  message?: string
  error?: string
  errors?: string[]
  // For conflict scenarios
  conflict?: {
    reason: 'slot_taken' | 'rate_limit' | 'invalid_slot'
    updatedSlots?: AppointmentSlot[]
  }
}

// Error types
export interface AppointmentError {
  type: 'conflict' | 'network' | 'validation' | 'rate_limit'
  message: string
  retryable: boolean
  updatedSlots?: AppointmentSlot[]
}

// Component props types
export interface ContactUIProps {
  theme?: string // Theme passed from parent (e.g., 'default', 'ocean', 'forest')
}
