// Barrel re-exports for backwards compatibility
export { PROCESSING_EVENTS } from './preload/api'
export type { ElectronAPI } from './preload/api'

// Side-effect: exposes electronAPI in the renderer main world
import './preload/api'
