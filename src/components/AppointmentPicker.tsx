import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'
import { format } from 'date-fns'
import AppointmentCalendar from './AppointmentCalendar'
import TimeSlotPicker from './TimeSlotPicker'
import DurationSelector from './DurationSelector'
import MeetingPlatformSelector from './MeetingPlatformSelector'
import { fetchAvailableSlots, fetchBookingWindow, AppointmentAPIError } from '../api/appointments'
import { isDateBookable } from '../../api/utils/booking-window'
import type {
  AppointmentSlot,
  BookingWindowConfig,
  AppointmentSelection,
  TimeSlotDuration,
  MeetingPlatform
} from '../types'

interface AppointmentPickerProps {
  onAppointmentChange: (selection: AppointmentSelection) => void
  disabled?: boolean
  initialSelection?: AppointmentSelection
}

export interface AppointmentPickerRef {
  refreshSlots: () => void
}

const AppointmentPicker = forwardRef<AppointmentPickerRef, AppointmentPickerProps>(
  ({ onAppointmentChange, disabled = false, initialSelection }, ref) => {
    const [selectedDate, setSelectedDate] = useState<Date | null>(initialSelection?.date || null)
    const [duration, setDuration] = useState<TimeSlotDuration>(initialSelection?.duration || 15)
    const [availableSlots, setAvailableSlots] = useState<AppointmentSlot[]>([])
    const [selectedSlot, setSelectedSlot] = useState<AppointmentSlot | null>(
      initialSelection?.selectedSlot || null
    )
    const [meetingPlatform, setMeetingPlatform] = useState<MeetingPlatform | null>(
      initialSelection?.meetingPlatform || 'jitsi' // Default to Jitsi Meet
    )
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [bookingWindow, setBookingWindow] = useState<BookingWindowConfig | null>(null)

    // Load the server's booking window once. A failure is deliberately silent:
    // the calendar falls back to offering every future date and the slots
    // endpoint still refuses what it must, which is exactly the behaviour that
    // existed before this fetch. Blocking the whole picker on it would be worse.
    useEffect(() => {
      let cancelled = false
      fetchBookingWindow()
        .then(window => {
          if (!cancelled) setBookingWindow(window)
        })
        .catch(() => {
          /* fall back to the unfiltered calendar */
        })
      return () => {
        cancelled = true
      }
    }, [])

    // A longer meeting needs an earlier start, so raising the duration can push
    // the selected date out of the window. Drop it rather than let the slots
    // fetch answer with a whole-day error about a date the calendar has just
    // greyed out underneath the user.
    useEffect(() => {
      if (!bookingWindow || !selectedDate) return
      if (!isDateBookable(format(selectedDate, 'yyyy-MM-dd'), duration, bookingWindow)) {
        setSelectedDate(null)
        setSelectedSlot(null)
      }
    }, [bookingWindow, selectedDate, duration])

    // Notify parent of selection changes
    useEffect(() => {
      onAppointmentChange({
        date: selectedDate,
        duration,
        selectedSlot,
        meetingPlatform
      })
    }, [selectedDate, duration, selectedSlot, meetingPlatform, onAppointmentChange])

    // Fetch slots when date or duration changes
    const loadSlots = useCallback(
      async (date: Date, slotDuration: TimeSlotDuration) => {
        setLoading(true)
        setError(null)

        try {
          const dateStr = format(date, 'yyyy-MM-dd')
          const response = await fetchAvailableSlots(dateStr, slotDuration)

          setAvailableSlots(response.slots)

          // Clear selected slot if it's no longer available
          setSelectedSlot(prev => {
            if (prev) {
              const stillAvailable = response.slots.find(s => s.id === prev.id && s.available)
              return stillAvailable ? prev : null
            }
            return null
          })
        } catch (err) {
          if (err instanceof AppointmentAPIError) {
            setError(err.message)
          } else {
            setError('Failed to load available time slots. Please try again.')
          }
          setAvailableSlots([])
          setSelectedSlot(null)
        } finally {
          setLoading(false)
        }
      },
      [] // No dependencies - we use setters with callbacks
    )

    useEffect(() => {
      if (selectedDate) {
        loadSlots(selectedDate, duration)
      } else {
        setAvailableSlots([])
        setSelectedSlot(null)
      }
    }, [selectedDate, duration, loadSlots])

    const handleDateChange = (date: Date) => {
      setSelectedDate(date)
      setSelectedSlot(null) // Clear slot selection when date changes
    }

    const handleDurationChange = (newDuration: TimeSlotDuration) => {
      setDuration(newDuration)
      setSelectedSlot(null) // Clear slot selection when duration changes
    }

    const handleSlotSelect = (slot: AppointmentSlot) => {
      // Toggle selection: if clicking the same slot, unselect it
      if (selectedSlot?.id === slot.id) {
        setSelectedSlot(null)
      } else {
        setSelectedSlot(slot)
      }
    }

    const handleClearAppointment = () => {
      setSelectedSlot(null)
      // Keep the user's selected platform - don't reset it
    }

    // Public method for parent to refresh slots (e.g., after conflict)
    const refreshSlots = useCallback(() => {
      if (selectedDate) {
        loadSlots(selectedDate, duration)
      }
    }, [selectedDate, duration, loadSlots])

    // Expose refresh method via ref
    useImperativeHandle(
      ref,
      () => ({
        refreshSlots
      }),
      [refreshSlots]
    )

    return (
      <div className="appointment-picker">
        <div className="appointment-picker__header">
          <h2 className="appointment-picker__title">Schedule a Meeting</h2>
          <p className="appointment-picker__subtitle">
            Select a date, choose a duration, and pick an available time slot
          </p>
        </div>

        <div className="appointment-picker__content">
          <div className="appointment-picker__calendar">
            <AppointmentCalendar
              selectedDate={selectedDate}
              onDateChange={handleDateChange}
              bookingWindow={bookingWindow}
              duration={duration}
              disabled={disabled}
            />
          </div>

          <div className="appointment-picker__selectors">
            <div className="appointment-picker__selector-item">
              <DurationSelector
                selectedDuration={duration}
                onDurationChange={handleDurationChange}
                disabled={disabled}
              />
            </div>
            <div className="appointment-picker__selector-item">
              <MeetingPlatformSelector
                selectedPlatform={meetingPlatform}
                onPlatformChange={setMeetingPlatform}
                disabled={disabled}
              />
            </div>
          </div>

          {selectedDate && (
            <div className="appointment-picker__slots">
              <TimeSlotPicker
                slots={availableSlots}
                selectedSlot={selectedSlot}
                onSlotSelect={handleSlotSelect}
                loading={loading}
                error={error || undefined}
              />
            </div>
          )}
        </div>

        {selectedSlot && meetingPlatform && (
          <div className="appointment-picker__summary">
            <div className="appointment-picker__summary-text">
              <strong>Selected:</strong> {format(selectedDate!, 'EEEE, MMMM d, yyyy')} at{' '}
              {format(new Date(selectedSlot.startTime), 'h:mm a')} ({duration} minutes) via{' '}
              {meetingPlatform.charAt(0).toUpperCase() + meetingPlatform.slice(1)}
            </div>
            <button
              type="button"
              onClick={handleClearAppointment}
              className="appointment-picker__clear-btn"
              disabled={disabled}
              aria-label="Clear appointment selection"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    )
  }
)

AppointmentPicker.displayName = 'AppointmentPicker'

export default AppointmentPicker
