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
}

// API Request/Response types
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
