import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ContactUIProps } from './entry'
import ContactForm from './ContactForm'
import {
  ThemePicker,
  SunIcon,
  MoonIcon,
  WaveIcon,
  LeafIcon,
  HeartIcon,
  ZapIcon,
  FlowerIcon,
  CoffeeIcon,
  type ThemeFamily
} from '@wolffm/task-ui-components'

// Theme families configuration
const THEME_FAMILIES: ThemeFamily[] = [
  {
    lightIcon: <SunIcon />,
    darkIcon: <MoonIcon />,
    lightTheme: 'default',
    darkTheme: 'default-dark',
    lightLabel: 'Default Light',
    darkLabel: 'Default Dark'
  },
  {
    lightIcon: <WaveIcon />,
    darkIcon: <WaveIcon />,
    lightTheme: 'ocean',
    darkTheme: 'ocean-dark',
    lightLabel: 'Ocean Light',
    darkLabel: 'Ocean Dark'
  },
  {
    lightIcon: <LeafIcon />,
    darkIcon: <LeafIcon />,
    lightTheme: 'forest',
    darkTheme: 'forest-dark',
    lightLabel: 'Forest Light',
    darkLabel: 'Forest Dark'
  },
  {
    lightIcon: <HeartIcon />,
    darkIcon: <HeartIcon />,
    lightTheme: 'berry',
    darkTheme: 'berry-dark',
    lightLabel: 'Berry Light',
    darkLabel: 'Berry Dark'
  },
  {
    lightIcon: <ZapIcon />,
    darkIcon: <ZapIcon />,
    lightTheme: 'electric',
    darkTheme: 'electric-dark',
    lightLabel: 'Electric Light',
    darkLabel: 'Electric Dark'
  },
  {
    lightIcon: <FlowerIcon />,
    darkIcon: <FlowerIcon />,
    lightTheme: 'cherry',
    darkTheme: 'cherry-dark',
    lightLabel: 'Cherry Light',
    darkLabel: 'Cherry Dark'
  },
  {
    lightIcon: <CoffeeIcon />,
    darkIcon: <CoffeeIcon />,
    lightTheme: 'mocha',
    darkTheme: 'mocha-dark',
    lightLabel: 'Mocha Light',
    darkLabel: 'Mocha Dark'
  }
]

// Icon map for current theme display
const THEME_ICON_MAP: Record<string, () => ReactElement> = {
  default: () => <SunIcon />,
  'default-dark': () => <MoonIcon />,
  ocean: () => <WaveIcon />,
  'ocean-dark': () => <WaveIcon />,
  forest: () => <LeafIcon />,
  'forest-dark': () => <LeafIcon />,
  berry: () => <HeartIcon />,
  'berry-dark': () => <HeartIcon />,
  electric: () => <ZapIcon />,
  'electric-dark': () => <ZapIcon />,
  cherry: () => <FlowerIcon />,
  'cherry-dark': () => <FlowerIcon />,
  mocha: () => <CoffeeIcon />,
  'mocha-dark': () => <CoffeeIcon />
}

export default function App(props: ContactUIProps = {}) {
  const { theme: initialTheme = 'default' } = props
  const [theme, setTheme] = useState(initialTheme)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Detect and sync with browser's color scheme preference
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  // Listen for browser theme changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDarkTheme(e.matches)

    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  // Sync theme with props changes
  useEffect(() => {
    if (initialTheme !== theme) {
      setTheme(initialTheme)
    }
  }, [initialTheme, theme])

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme)
  }

  return (
    <div
      ref={containerRef}
      className="contact-ui-container"
      data-theme={theme}
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <div className="contact-ui">
        <div className="contact-ui__header-bar">
          <ThemePicker
            currentTheme={theme}
            isOpen={isPickerOpen}
            themeFamilies={THEME_FAMILIES}
            onThemeChange={handleThemeChange}
            onToggle={() => setIsPickerOpen(!isPickerOpen)}
            getThemeIcon={(t: string) => THEME_ICON_MAP[t]?.() || null}
            className="theme-picker"
          />
        </div>
        <ContactForm />
      </div>
    </div>
  )
}
