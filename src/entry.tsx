import { createRoot, type Root } from 'react-dom/client'
import { logger } from '@wolffm/task-ui-components'
import App from './App'
import type { ContactUIProps } from './types'
import '@wolffm/themes/style.css'
import '@wolffm/task-ui-components/theme-picker.css'
import './styles/index.css'

// Re-export all types
export type {
  FormData,
  FormErrors,
  SubmitStatus,
  TimeSlotDuration,
  MeetingPlatform,
  AppointmentSlot,
  AppointmentSelection,
  FetchSlotsRequest,
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse,
  AppointmentError,
  ContactUIProps
} from './types'

// Extend HTMLElement to include __root property
interface ContactUIElement extends HTMLElement {
  __root?: Root
}

// Mount function - called by parent to initialize Contact UI
export function mount(el: HTMLElement, props: ContactUIProps = {}) {
  logger.component('mount', 'ContactUI', {
    element: el.tagName,
    props,
    dimensions: {
      width: el.offsetWidth,
      height: el.offsetHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight
    }
  })

  const root = createRoot(el)
  logger.debug('[entry] React root created, rendering App')
  root.render(<App {...props} />)
  ;(el as ContactUIElement).__root = root
  logger.debug('[entry] App rendered and root stored on element')
}

// Unmount function - called by parent to cleanup Contact UI
export function unmount(el: HTMLElement) {
  logger.component('unmount', 'ContactUI', { element: el.tagName })
  ;(el as ContactUIElement).__root?.unmount()
  logger.debug('[entry] React root unmounted')
}
