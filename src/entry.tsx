import { createRoot, type Root } from 'react-dom/client'
import App from './App'
import '@wolffm/themes/style.css'
import '@wolffm/task-ui-components/theme-picker.css'
import './styles/index.css'

// Props interface for configuration from parent app
export interface ContactUIProps {
  theme?: string // Theme passed from parent (e.g., 'default', 'ocean', 'forest')
}

// Extend HTMLElement to include __root property
interface ContactUIElement extends HTMLElement {
  __root?: Root
}

// Mount function - called by parent to initialize Contact UI
export function mount(el: HTMLElement, props: ContactUIProps = {}) {
  console.log('[entry] mount() called with element:', el, 'props:', props)
  console.log('[entry] Element dimensions:', {
    width: el.offsetWidth,
    height: el.offsetHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight
  })

  const root = createRoot(el)
  console.log('[entry] React root created, rendering App...')
  root.render(<App {...props} />)
  ;(el as ContactUIElement).__root = root
  console.log('[entry] App rendered and root stored on element')
}

// Unmount function - called by parent to cleanup Contact UI
export function unmount(el: HTMLElement) {
  console.log('[entry] unmount() called for element:', el)
  ;(el as ContactUIElement).__root?.unmount()
  console.log('[entry] React root unmounted')
}
