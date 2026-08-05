import { useRef } from 'react'
import type { ContactUIProps } from './types'
import ContactForm from './ContactForm'
import { AppHeader } from '@wolffm/task-ui-components'
import { useHadokuTheme } from '@wolffm/themes'
import { HadokuThemeRoot } from '@wolffm/themes'

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
      <ContactApp containerRef={containerRef} />
    </HadokuThemeRoot>
  )
}

function ContactApp({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
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
        <AppHeader title="Contact" />
        <ContactForm />
      </div>
    </div>
  )
}
