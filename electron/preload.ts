// Barrel re-exports for backwards compatibility

export type { ElectronAPI } from "./preload/api";
export { PROCESSING_EVENTS } from "./preload/api";

// Side-effect: exposes electronAPI in the renderer main world
import "./preload/api";
