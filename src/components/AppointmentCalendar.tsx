import { format } from 'date-fns'
import Calendar from 'react-calendar'
import 'react-calendar/dist/Calendar.css'
// The booking rule lives with the API half of this package because the API is
// what enforces it. Importing it here rather than restating it is the point:
// this calendar used to carry its own "tomorrow at local midnight" version and
// offered dates the server then refused with a 400 the user could not act on.
import { isDateBookable } from '../../api/utils/booking-window'
import type { AvailabilityResponse, BookingWindowConfig, TimeSlotDuration } from '../types'

interface AppointmentCalendarProps {
  selectedDate: Date | null
  onDateChange: (date: Date) => void
  /** The server's window. Null while it loads, or if the fetch failed. */
  bookingWindow: BookingWindowConfig | null
  /**
   * Free-slot counts for the visible month. Null while they load — the window
   * rules stand in until then. A date absent from `dates` is unclickable.
   */
  availability: AvailabilityResponse['dates'] | null
  /** Slot length being booked — it moves the last bookable start of each day. */
  duration: TimeSlotDuration
  /** Fires when the user pages to another month, so its counts can be fetched. */
  onVisibleMonthChange: (month: Date) => void
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
  availability,
  duration,
  onVisibleMonthChange,
  disabled = false
}: AppointmentCalendarProps) {
  const handleDateChange = (value: Date | [Date | null, Date | null] | null) => {
    // react-calendar can return Date, array of Dates, or null
    // We only handle single Date selection
    if (value && value instanceof Date && !disabled) {
      onDateChange(value)
    }
  }

  /**
   * A date is clickable only if the server says something is actually free on
   * it. There is no second answer and no message: a day with nothing on it is
   * greyed, which is the whole point — the user should never be able to pick a
   * date and be told afterwards that it was never available.
   *
   * The window rules are the fallback for the moment before the counts land.
   * They are a superset of the real answer (they know nothing about what is
   * already booked), so the calendar can only ever get stricter as it loads,
   * never looser — a tile never becomes clickable after the user has read it as
   * disabled.
   */
  const tileDisabled = ({ date, view }: { date: Date; view: string }) => {
    if (view !== 'month') return false
    const key = format(date, 'yyyy-MM-dd')
    if (availability) return availability[key] === undefined
    if (bookingWindow) return !isDateBookable(key, duration, bookingWindow)
    return date < dayFromToday(1)
  }

  return (
    <div className={`appointment-calendar ${disabled ? 'appointment-calendar--disabled' : ''}`}>
      <Calendar
        value={selectedDate}
        onChange={handleDateChange}
        onActiveStartDateChange={({ activeStartDate }) => {
          if (activeStartDate) onVisibleMonthChange(activeStartDate)
        }}
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
