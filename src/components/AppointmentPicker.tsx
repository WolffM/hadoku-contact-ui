import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { addMonths, endOfMonth, format, isAfter, startOfMonth } from 'date-fns'
import AppointmentCalendar from './AppointmentCalendar'
import TimeSlotPicker from './TimeSlotPicker'
import DurationSelector from './DurationSelector'
import MeetingPlatformSelector from './MeetingPlatformSelector'
import {
  fetchAvailability,
  fetchAvailableSlots,
  fetchBookingWindow,
  AppointmentAPIError
} from '../api/appointments'
import { isDateBookable } from '../../api/utils/booking-window'
import type {
  AppointmentSlot,
  AvailabilityResponse,
  BookingWindowConfig,
  AppointmentSelection,
  TimeSlotDuration,
  MeetingPlatform
} from '../types'

/** `'2026-08-26'` -> that day at LOCAL midnight, which is how react-calendar
 *  compares tiles and how `format(date, 'yyyy-MM-dd')` reads them back. */
const parseLocalDate = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Identifies which month and duration a set of counts describes. */
const availabilityKey = (month: Date, duration: TimeSlotDuration) =>
  `${format(month, 'yyyy-MM')}|${duration}`

/**
 * How long a cached answer is trusted before it is fetched again.
 *
 * Switching 15 -> 30 -> 60 fired two round trips EVERY time, so the times
 * blanked to a spinner on a question the page had already asked. The durations
 * are not derived on the client from the 15-minute grid, tempting as that is:
 * the grid, the business-hours edge and the advance window are the server's
 * rules, and this file already exists because the calendar once kept its own
 * copy of one of them and drifted. Asking early is the same answer without the
 * second source of truth.
 *
 * Staleness is bounded rather than eliminated. A slot list going out of date is
 * not a correctness problem — the booking itself is settled by an overlap check
 * inside the submit transaction, which answers 409 no matter what the page
 * believed — so this only has to be short enough that the list on screen still
 * looks like the truth.
 */
const CACHE_TTL_MS = 60_000

interface CacheEntry<T> {
  at: number
  value: T
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

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
    // Stamped with the month and duration it describes. Without the stamp, paging
    // to a new month would grey out every date in it — none of them appear in the
    // PREVIOUS month's counts — until the fetch landed, which reads as "nothing is
    // available here" for as long as the request takes.
    const [availability, setAvailability] = useState<{
      key: string
      dates: AvailabilityResponse['dates']
    } | null>(null)
    const [visibleMonth, setVisibleMonth] = useState<Date>(
      () => initialSelection?.date ?? new Date()
    )
    // Answers already fetched, so changing the duration does not re-ask for what
    // is on screen. Refs, not state: a cache hit must not itself cause a render.
    const slotCache = useRef(new Map<string, CacheEntry<AppointmentSlot[]>>())
    const availabilityCache = useRef(new Map<string, CacheEntry<AvailabilityResponse['dates']>>())
    // Bumped when the slots endpoint refuses a day the calendar still offered,
    // which forces the counts to be refetched.
    const [staleAvailability, setStaleAvailability] = useState(0)
    // Whether the date on screen was chosen by the picker rather than clicked.
    // The form reads it to know that a defaulted date is not someone trying to
    // book, so a plain message is not held up waiting for a time slot.
    const [dateAutoSelected, setDateAutoSelected] = useState(false)
    // The opening choice is made once. Without this the picker would drag the
    // user back to the default every time they paged to a month and its counts
    // arrived, and would undo a deliberate choice they then cleared.
    const [hasOpened, setHasOpened] = useState(Boolean(initialSelection?.date))

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

    // Free-slot counts for the month on screen, refetched when the user pages or
    // changes the duration. This — not the window rules — is what greys dates
    // out, because a day can clear every rule and still be booked solid.
    const fetchMonthCounts = useCallback(async (month: Date, slotDuration: TimeSlotDuration) => {
      const key = availabilityKey(month, slotDuration)
      const cached = readCache(availabilityCache.current, key)
      if (cached) return cached

      const response = await fetchAvailability(
        slotDuration,
        format(startOfMonth(month), 'yyyy-MM-dd'),
        format(endOfMonth(month), 'yyyy-MM-dd')
      )
      availabilityCache.current.set(key, { at: Date.now(), value: response.dates })
      return response.dates
    }, [])

    const loadAvailability = useCallback(
      async (month: Date, slotDuration: TimeSlotDuration) => {
        try {
          const dates = await fetchMonthCounts(month, slotDuration)
          setAvailability({ key: availabilityKey(month, slotDuration), dates })
        } catch {
          // Leave the previous counts alone rather than greying the whole month on
          // a transient failure. The slots endpoint still refuses what it must.
        }
      },
      [fetchMonthCounts]
    )

    useEffect(() => {
      void loadAvailability(visibleMonth, duration)
    }, [visibleMonth, duration, staleAvailability, loadAvailability])

    // Open on the next bookable day, so the times are on screen without the user
    // having to guess which dates are worth clicking. The counts already say
    // which days have something free; the earliest of them is the answer.
    //
    // When the month on screen has nothing at all — every day booked solid, or
    // the notice window covering the rest of it — step forward a month and let
    // the counts for that one decide, stopping at the far bound so an empty
    // calendar cannot walk forward forever.
    useEffect(() => {
      if (hasOpened || selectedDate) return
      const current =
        availability?.key === availabilityKey(visibleMonth, duration) ? availability.dates : null
      if (!current) return

      const [firstOffered] = Object.keys(current).sort()
      if (firstOffered) {
        setSelectedDate(parseLocalDate(firstOffered))
        setDateAutoSelected(true)
        setHasOpened(true)
        return
      }

      const nextMonth = startOfMonth(addMonths(visibleMonth, 1))
      const farBound = new Date()
      farBound.setDate(farBound.getDate() + (bookingWindow?.maxAdvanceDays ?? 0))
      if (!bookingWindow || isAfter(nextMonth, farBound)) {
        // Nothing bookable anywhere in the window. Leave the calendar where it
        // is; TimeSlotPicker is not rendered without a date, and every tile is
        // greyed, which is the honest picture.
        setHasOpened(true)
        return
      }
      setVisibleMonth(nextMonth)
    }, [availability, visibleMonth, duration, selectedDate, hasOpened, bookingWindow])

    // A longer meeting needs an earlier start, so raising the duration can push
    // the selected date out of the window. Drop it rather than let the slots
    // fetch answer with a whole-day error about a date the calendar has just
    // greyed out underneath the user.
    useEffect(() => {
      if (!selectedDate) return
      const key = format(selectedDate, 'yyyy-MM-dd')
      const current =
        availability?.key === availabilityKey(selectedDate, duration) ? availability.dates : null
      const stillOffered = current
        ? current[key] !== undefined
        : !bookingWindow || isDateBookable(key, duration, bookingWindow)
      if (!stillOffered) {
        setSelectedDate(null)
        setSelectedSlot(null)
        // A longer meeting may not fit the day that was open. Re-arm the opening
        // choice so the picker lands on the next day that CAN hold it, rather
        // than leaving the user on no date at all.
        if (dateAutoSelected) setHasOpened(false)
      }
    }, [availability, bookingWindow, selectedDate, duration, dateAutoSelected])

    // Notify parent of selection changes
    useEffect(() => {
      onAppointmentChange({
        date: selectedDate,
        duration,
        selectedSlot,
        meetingPlatform,
        dateAutoSelected
      })
    }, [
      selectedDate,
      duration,
      selectedSlot,
      meetingPlatform,
      dateAutoSelected,
      onAppointmentChange
    ])

    /**
     * The day's slots at one duration, from cache when it is still fresh.
     *
     * Only successes are cached. A day the server refuses at this duration
     * (400 — the calendar's greying went stale) must reach `loadSlots`, which
     * re-greys the calendar rather than repeating the rule at the user; caching
     * an empty list in its place would swallow that and leave the date clickable.
     */
    const fetchDaySlots = useCallback(async (date: Date, slotDuration: TimeSlotDuration) => {
      const dateStr = format(date, 'yyyy-MM-dd')
      const key = `${dateStr}|${slotDuration}`
      const cached = readCache(slotCache.current, key)
      if (cached) return cached

      const response = await fetchAvailableSlots(dateStr, slotDuration)
      slotCache.current.set(key, { at: Date.now(), value: response.slots })
      return response.slots
    }, [])

    // Fetch slots when date or duration changes
    const loadSlots = useCallback(
      async (date: Date, slotDuration: TimeSlotDuration) => {
        // Only show the spinner for a question we actually have to ask. A cache
        // hit repaints in the same frame, so flashing "Loading..." at it would
        // invent the wait this cache exists to remove.
        const warm = readCache(slotCache.current, `${format(date, 'yyyy-MM-dd')}|${slotDuration}`)
        if (!warm) setLoading(true)
        setError(null)

        try {
          const slots = await fetchDaySlots(date, slotDuration)

          setAvailableSlots(slots)

          // Clear selected slot if it's no longer available
          setSelectedSlot(prev => {
            if (prev) {
              const stillAvailable = slots.find(s => s.id === prev.id && s.available)
              return stillAvailable ? prev : null
            }
            return null
          })
        } catch (err) {
          const dayRefused = err instanceof AppointmentAPIError && err.type === 'validation'
          if (dayRefused) {
            // The calendar's greying was stale — the day filled up, or the notice
            // cutoff rolled past it, while the user was looking at it. Re-grey it
            // rather than repeating the server's rule at someone who cannot act
            // on it; TimeSlotPicker's empty state says the useful half.
            //
            // Emptied here rather than in an effect on `staleAvailability`: the
            // effect that refetches the counts is declared first and would run
            // first, so the "refetch" would be served by the entry that just
            // turned out to be wrong. Every cached answer is suspect, not only
            // this duration's — the server has contradicted the whole picture.
            slotCache.current.clear()
            availabilityCache.current.clear()
            setStaleAvailability(n => n + 1)
          } else if (err instanceof AppointmentAPIError) {
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
      [fetchDaySlots]
    )

    useEffect(() => {
      if (selectedDate) {
        loadSlots(selectedDate, duration)
      } else {
        setAvailableSlots([])
        setSelectedSlot(null)
      }
    }, [selectedDate, duration, loadSlots])

    /**
     * Warm the OTHER durations for what is on screen.
     *
     * This is the whole point: the durations are three buttons sitting above the
     * times, so the next thing a user does is very often press one, and the two
     * requests that answer it can be in flight long before then. Fired after the
     * visible duration has been asked for, so it never competes with it.
     *
     * Failures are swallowed on purpose. Nothing on screen depends on a warmed
     * entry — a miss just means the switch pays for its own fetch, which is what
     * every switch used to do.
     */
    useEffect(() => {
      const durations = bookingWindow?.slotDurations
      if (!durations) return

      let cancelled = false
      const others = durations.filter(d => d !== duration) as TimeSlotDuration[]

      const warm = window.setTimeout(() => {
        for (const other of others) {
          if (cancelled) continue
          void fetchMonthCounts(visibleMonth, other).catch(() => {})
          if (selectedDate) void fetchDaySlots(selectedDate, other).catch(() => {})
        }
      }, 150)

      return () => {
        cancelled = true
        window.clearTimeout(warm)
      }
    }, [
      bookingWindow,
      duration,
      visibleMonth,
      selectedDate,
      staleAvailability,
      fetchMonthCounts,
      fetchDaySlots
    ])

    const handleDateChange = (date: Date) => {
      setSelectedDate(date)
      setDateAutoSelected(false)
      setHasOpened(true)
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
    //
    // Empties both caches first. This is called when the server has just told
    // the form its picture was wrong — a 409 on submit — so every cached answer
    // is suspect, not only the one for the duration on screen.
    const refreshSlots = useCallback(() => {
      slotCache.current.clear()
      availabilityCache.current.clear()
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
              availability={
                availability?.key === availabilityKey(visibleMonth, duration)
                  ? availability.dates
                  : null
              }
              duration={duration}
              onVisibleMonthChange={setVisibleMonth}
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
