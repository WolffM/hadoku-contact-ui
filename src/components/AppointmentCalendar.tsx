import { useMemo } from 'react'
import { format } from 'date-fns'
import Calendar from 'react-calendar'
import 'react-calendar/dist/Calendar.css'
// The booking rule lives with the API half of this package because the API is
// what enforces it. Importing it here rather than restating it is the point:
// this calendar used to carry its own "tomorrow at local midnight" version and
// offered dates the server then refused with a 400 the user could not act on.
import { isDateBookable, type BookingWindow } from '../../api/utils/booking-window'
import type { BookingWindowConfig, TimeSlotDuration } from '../types'

interface AppointmentCalendarProps {
  selectedDate: Date | null
  onDateChange: (date: Date) => void
  /** The server's window. Null while it loads, or if the fetch failed. */
  bookingWindow: BookingWindowConfig | null
  /** Slot length being booked — it moves the last bookable start of each day. */
  duration: TimeSlotDuration
  disabled?: boolean
}

/** Local midnight `days` from today — react-calendar compares tiles this way. */
const dayFromToday = (days: number): Date => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date
}

export default function AppointmentCalendar({
  selectedDate,
  onDateChange,
  bookingWindow,
  duration,
  disabled = false
}: AppointmentCalendarProps) {
  const handleDateChange = (value: Date | [Date | null, Date | null] | null) => {
    // react-calendar can return Date, array of Dates, or null
    // We only handle single Date selection
    if (value && value instanceof Date && !disabled) {
      onDateChange(value)
    }
  }

  const bookable = useMemo(() => {
    if (!bookingWindow) return null
    // `now` is captured once per render rather than read inside the predicate so
    // every tile in a month is judged against the same instant. A cutoff that
    // moved mid-render could grey out one day and not its identical neighbour.
    const now = new Date()
    const window: BookingWindow = bookingWindow
    return (date: Date) => isDateBookable(format(date, 'yyyy-MM-dd'), duration, window, now)
  }, [bookingWindow, duration])

  // Until the window arrives, offer nothing but the past-guard. Greying out
  // dates from a guess is what caused the bug this replaced; showing them
  // briefly and then greying the unbookable ones is the honest order.
  const tileDisabled = ({ date }: { date: Date }) =>
    bookable ? !bookable(date) : date < dayFromToday(1)

  return (
    <div className={`appointment-calendar ${disabled ? 'appointment-calendar--disabled' : ''}`}>
      <Calendar
        value={selectedDate}
        onChange={handleDateChange}
        minDate={dayFromToday(0)}
        maxDate={bookingWindow ? dayFromToday(bookingWindow.maxAdvanceDays) : undefined}
        tileDisabled={tileDisabled}
        showNeighboringMonth={false}
        locale="en-US"
        className="calendar"
      />
    </div>
  )
}
