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
    lightTheme: 'light',
    darkTheme: 'dark',
    lightLabel: 'Default Light',
    darkLabel: 'Default Dark'
  },
  {
    lightIcon: <WaveIcon />,
    darkIcon: <WaveIcon />,
    lightTheme: 'ocean-light',
    darkTheme: 'ocean-dark',
    lightLabel: 'Ocean Light',
    darkLabel: 'Ocean Dark'
  },
  {
    lightIcon: <LeafIcon />,
    darkIcon: <LeafIcon />,
    lightTheme: 'nature-light',
    darkTheme: 'nature-dark',
    lightLabel: 'Nature Light',
    darkLabel: 'Nature Dark'
  },
  {
    lightIcon: <HeartIcon />,
    darkIcon: <HeartIcon />,
    lightTheme: 'strawberry-light',
    darkTheme: 'strawberry-dark',
    lightLabel: 'Strawberry Light',
    darkLabel: 'Strawberry Dark'
  },
  {
    lightIcon: <ZapIcon />,
    darkIcon: <ZapIcon />,
    lightTheme: 'cyberpunk-light',
    darkTheme: 'cyberpunk-dark',
    lightLabel: 'Cyberpunk Light',
    darkLabel: 'Cyberpunk Dark'
  },
  {
    lightIcon: <FlowerIcon />,
    darkIcon: <FlowerIcon />,
    lightTheme: 'pink-light',
    darkTheme: 'pink-dark',
    lightLabel: 'Pink Light',
    darkLabel: 'Pink Dark'
  },
  {
    lightIcon: <CoffeeIcon />,
    darkIcon: <CoffeeIcon />,
    lightTheme: 'coffee-light',
    darkTheme: 'coffee-dark',
    lightLabel: 'Coffee Light',
    darkLabel: 'Coffee Dark'
  }
]

// Icon map for current theme display
const THEME_ICON_MAP: Record<string, () => ReactElement> = {
  light: () => <SunIcon />,
  dark: () => <MoonIcon />,
  'ocean-light': () => <WaveIcon />,
  'ocean-dark': () => <WaveIcon />,
  'nature-light': () => <LeafIcon />,
  'nature-dark': () => <LeafIcon />,
  'strawberry-light': () => <HeartIcon />,
  'strawberry-dark': () => <HeartIcon />,
  'cyberpunk-light': () => <ZapIcon />,
  'cyberpunk-dark': () => <ZapIcon />,
  'pink-light': () => <FlowerIcon />,
  'pink-dark': () => <FlowerIcon />,
  'coffee-light': () => <CoffeeIcon />,
  'coffee-dark': () => <CoffeeIcon />
}

export default function App(props: ContactUIProps = {}) {
  console.log('[App] Rendering with props:', props)
  console.log('[App] props.theme value:', props.theme, 'type:', typeof props.theme)

  // Initialize theme state - only runs once on mount
  const [theme, setTheme] = useState(() => {
    console.log('[App] Initializing theme state')

    // Detect browser's color scheme preference
    const browserPrefersDark =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false

    console.log('[App] Browser prefers dark mode:', browserPrefersDark)
    console.log('[App] props.theme:', props.theme)

    // If theme is provided in props, use it; otherwise use browser preference
    if (props.theme) {
      console.log('[App] Using props.theme:', props.theme)
      return props.theme
    }

    const autoTheme = browserPrefersDark ? 'dark' : 'light'
    console.log('[App] No props.theme, using auto theme:', autoTheme)
    return autoTheme
  })

  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const hasInitializedFromProps = useRef(false)

  console.log('[App] Current render - theme:', theme, 'isPickerOpen:', isPickerOpen)

  // Track if browser prefers dark mode
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  console.log('[App] isDarkTheme:', isDarkTheme)

  // Listen for browser theme changes
  useEffect(() => {
    console.log('[App] Setting up media query listener')
    if (typeof window === 'undefined' || !window.matchMedia) {
      console.log('[App] No matchMedia support in useEffect')
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      console.log('[App] Browser theme changed to:', e.matches ? 'dark' : 'light')
      setIsDarkTheme(e.matches)
    }

    mediaQuery.addEventListener('change', handler)
    return () => {
      console.log('[App] Cleaning up media query listener')
      mediaQuery.removeEventListener('change', handler)
    }
  }, [])

  // Apply props.theme only on first mount if provided
  useEffect(() => {
    if (props.theme && !hasInitializedFromProps.current) {
      console.log('[App] First mount - applying props.theme:', props.theme)
      setTheme(props.theme)
      hasInitializedFromProps.current = true
    }
  }, [props.theme])

  const handleThemeChange = (newTheme: string) => {
    console.log('[App] handleThemeChange called with:', newTheme)
    console.log('[App] Current theme before change:', theme)
    setTheme(newTheme)
    console.log('[App] setTheme called with:', newTheme)
  }

  const handleToggle = () => {
    console.log('[App] ThemePicker toggle clicked, current isPickerOpen:', isPickerOpen)
    setIsPickerOpen(!isPickerOpen)
  }

  console.log(
    '[App] About to render - theme:',
    theme,
    'isPickerOpen:',
    isPickerOpen,
    'isDarkTheme:',
    isDarkTheme
  )
  console.log('[App] Rendering ThemePicker with:', {
    currentTheme: theme,
    isOpen: isPickerOpen,
    themeFamiliesCount: THEME_FAMILIES.length,
    className: 'theme-picker'
  })

  return (
    <div
      ref={containerRef}
      className="contact-ui-container"
      data-theme={theme}
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <div className="contact-ui">
        <ContactForm
          themePicker={
            <ThemePicker
              currentTheme={theme}
              isOpen={isPickerOpen}
              themeFamilies={THEME_FAMILIES}
              onThemeChange={handleThemeChange}
              onToggle={handleToggle}
              getThemeIcon={(t: string) => {
                const icon = THEME_ICON_MAP[t]?.() || null
                console.log('[App] getThemeIcon called for theme:', t, 'returning icon:', icon)
                return icon
              }}
              className="theme-picker"
            />
          }
        />
      </div>
    </div>
  )
}
