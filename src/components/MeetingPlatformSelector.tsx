import type { MeetingPlatform } from '../types'
import { DiscordIcon, GoogleMeetIcon, JitsiIcon } from './PlatformIcons'

interface MeetingPlatformSelectorProps {
  selectedPlatform: MeetingPlatform | null
  onPlatformChange: (platform: MeetingPlatform) => void
  disabled?: boolean
}

// Microsoft Teams is intentionally excluded (paid M365 + Entra ID required).
// Google Meet works via Google Calendar API + hangoutsMeet conferenceData.
const PLATFORMS: {
  value: MeetingPlatform
  label: string
  Icon: React.ComponentType<{ className?: string }>
}[] = [
  { value: 'jitsi', label: 'Jitsi Meet', Icon: JitsiIcon },
  { value: 'discord', label: 'Discord', Icon: DiscordIcon },
  { value: 'google', label: 'Google Meet', Icon: GoogleMeetIcon }
]

export default function MeetingPlatformSelector({
  selectedPlatform,
  onPlatformChange,
  disabled = false
}: MeetingPlatformSelectorProps) {
  return (
    <div className="meeting-platform-selector">
      <label className="meeting-platform-selector__label">Meeting Platform</label>
      <div className="meeting-platform-selector__grid">
        {PLATFORMS.map(platform => {
          const Icon = platform.Icon
          return (
            <button
              key={platform.value}
              type="button"
              className={`platform-button ${selectedPlatform === platform.value ? 'platform-button--selected' : ''}`}
              onClick={() => onPlatformChange(platform.value)}
              disabled={disabled}
              aria-pressed={selectedPlatform === platform.value}
            >
              <Icon className="platform-button__icon" />
              <span className="platform-button__label">{platform.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
