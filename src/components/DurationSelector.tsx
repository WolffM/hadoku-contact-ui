import type { TimeSlotDuration } from '../types'

interface DurationSelectorProps {
  selectedDuration: TimeSlotDuration
  onDurationChange: (duration: TimeSlotDuration) => void
  disabled?: boolean
}

const DURATION_OPTIONS: TimeSlotDuration[] = [15, 30, 60]

export default function DurationSelector({
  selectedDuration,
  onDurationChange,
  disabled = false
}: DurationSelectorProps) {
  return (
    <div className="duration-selector">
      <label className="duration-selector__label">Meeting Duration</label>
      <div className="duration-selector__pills">
        {DURATION_OPTIONS.map(duration => (
          <button
            key={duration}
            type="button"
            className={`duration-pill ${selectedDuration === duration ? 'duration-pill--selected' : ''}`}
            onClick={() => onDurationChange(duration)}
            disabled={disabled}
            aria-pressed={selectedDuration === duration}
          >
            {duration} min
          </button>
        ))}
      </div>
    </div>
  )
}
