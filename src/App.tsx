import { useRef } from 'react'
import type { ContactUIProps } from './types'
import ContactForm from './ContactForm'
import { AppHeader } from '@wolffm/task-ui-components'
import { useHadokuTheme, HadokuThemeRoot } from '@wolffm/themes'
/**
 * Theming is the platform's, not this app's.
 *
 * This file used to carry ~150 lines of it: its own THEME_FAMILIES list (with
 * its own labels — "Default Light" where every other app said "Light", so this
 * app's picker genuinely offered a different set of themes), its own
 * THEME_ICON_MAP, its own theme state, media-query listener, prefs hydration
 * and save path, and a raw <ThemePicker> with hand-managed open state and a
 * debug logger inside getThemeIcon. It also never wrote localStorage, so the
 * theme did not survive a browser restart.
 *
 * All of it is now <HadokuThemeRoot> plus an <AppHeader> that renders the
 * shared picker itself. There is nothing left here to drift.
 */
export default function App(props: ContactUIProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <HadokuThemeRoot theme={props.theme} containerRef={containerRef}>
      <ContactApp containerRef={containerRef} appName={props.appName} />
    </HadokuThemeRoot>
  )
}

function ContactApp({
  containerRef,
  appName
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  appName?: string
}) {
  // isDarkTheme now follows the ACTIVE theme rather than the browser
  // preference, which is what the attribute was always meant to describe —
  // someone on `ocean-dark` under a light OS was previously reported as light.
  const { isDarkTheme } = useHadokuTheme()

  return (
    <div
      ref={containerRef}
      className="contact-ui-container"
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <div className="contact-ui">
        {/* DERIVED, never written here: `appName` is the platform's answer from
            spec/categories.json (registry props -> mount), and __HADOKU_APP_NAME__ is
            the standalone fallback vite fills in from @wolffm/catalogue. Do not put a
            string back. */}
        <AppHeader title={appName ?? __HADOKU_APP_NAME__} />
        <ContactForm />
      </div>
    </div>
  )
}
