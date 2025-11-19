import React, { useEffect, useRef, useState } from 'react'
import type { ContactUIProps } from './entry'
import ContactForm from './ContactForm'

export default function App(props: ContactUIProps = {}) {
  const { theme = 'default' } = props
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

  // REQUIRED: Apply theme attributes for @wolffm/themes integration
  // These attributes are REQUIRED for theming to work correctly
  useEffect(() => {
    if (containerRef.current) {
      // REQUIRED: data-theme attribute (e.g., 'default', 'ocean', 'forest')
      containerRef.current.setAttribute('data-theme', theme)
      // REQUIRED: data-dark-theme attribute ('true' or 'false')
      containerRef.current.setAttribute('data-dark-theme', isDarkTheme ? 'true' : 'false')
    }
  }, [theme, isDarkTheme])

  return (
    <div ref={containerRef} className="contact-ui-container">
      <div className="contact-ui">
        <ContactForm />
      </div>
    </div>
  )
}
