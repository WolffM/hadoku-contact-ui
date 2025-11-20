import { format } from 'date-fns'
import type { AppointmentSlot } from '../types'

interface TimeSlotPickerProps {
  slots: AppointmentSlot[]
  selectedSlot: AppointmentSlot | null
  onSlotSelect: (slot: AppointmentSlot) => void
  loading?: boolean
  error?: string
}

export default function TimeSlotPicker({
  slots,
  selectedSlot,
  onSlotSelect,
  loading = false,
  error
}: TimeSlotPickerProps) {
  if (loading) {
    return (
      <div className="time-slot-picker">
        <div className="time-slot-picker__loading">Loading available times...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="time-slot-picker">
        <div className="time-slot-picker__error">{error}</div>
      </div>
    )
  }

  if (slots.length === 0) {
    return (
      <div className="time-slot-picker">
        <div className="time-slot-picker__empty">
          No available time slots for this date. Please select another date.
        </div>
      </div>
    )
  }

  const formatSlotTime = (slot: AppointmentSlot) => {
    try {
      const startDate = new Date(slot.startTime)
      return format(startDate, 'h:mm a')
    } catch {
      return slot.startTime
    }
  }

  return (
    <div className="time-slot-picker">
      <div className="time-slot-picker__label">Available Times</div>
      <div className="time-slot-grid">
        {slots.map(slot => (
          <button
            key={slot.id}
            type="button"
            className={`time-slot ${selectedSlot?.id === slot.id ? 'time-slot--selected' : ''} ${!slot.available ? 'time-slot--disabled' : ''}`}
            onClick={() => slot.available && onSlotSelect(slot)}
            disabled={!slot.available}
            aria-pressed={selectedSlot?.id === slot.id}
            aria-disabled={!slot.available}
          >
            {formatSlotTime(slot)}
          </button>
        ))}
      </div>
    </div>
  )
}
