import Calendar from 'react-calendar'
import 'react-calendar/dist/Calendar.css'

interface AppointmentCalendarProps {
  selectedDate: Date | null
  onDateChange: (date: Date) => void
  minDate?: Date
  maxDate?: Date
  disabled?: boolean
}

// Helper function to get tomorrow's date at midnight (24hr notice requirement)
const getTomorrowDate = (): Date => {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  return tomorrow
}

export default function AppointmentCalendar({
  selectedDate,
  onDateChange,
  minDate,
  maxDate,
  disabled = false
}: AppointmentCalendarProps) {
  // Set default minDate to tomorrow (24hr notice)
  const effectiveMinDate = minDate || getTomorrowDate()

  const handleDateChange = (value: Date | [Date | null, Date | null] | null) => {
    // react-calendar can return Date, array of Dates, or null
    // We only handle single Date selection
    if (value && value instanceof Date && !disabled) {
      onDateChange(value)
    }
  }

  // Disable dates in the past (minimum 24hr notice)
  const tileDisabled = ({ date }: { date: Date }) => {
    return date < getTomorrowDate()
  }

  return (
    <div className={`appointment-calendar ${disabled ? 'appointment-calendar--disabled' : ''}`}>
      <Calendar
        value={selectedDate}
        onChange={handleDateChange}
        minDate={effectiveMinDate}
        maxDate={maxDate}
        tileDisabled={tileDisabled}
        showNeighboringMonth={false}
        locale="en-US"
        className="calendar"
      />
    </div>
  )
}
