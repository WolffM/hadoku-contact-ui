import { createRoot, type Root } from 'react-dom/client'
import App from './App'
// REQUIRED: Import @wolffm/themes CSS - DO NOT REMOVE
import '@wolffm/themes/themes.css'
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
  const root = createRoot(el)
  root.render(<App {...props} />)
  ;(el as ContactUIElement).__root = root
}

// Unmount function - called by parent to cleanup Contact UI
export function unmount(el: HTMLElement) {
  ;(el as ContactUIElement).__root?.unmount()
}
