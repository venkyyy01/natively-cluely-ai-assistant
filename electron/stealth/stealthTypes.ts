import type { VirtualDisplayCoordinator } from './MacosVirtualDisplayClient';
import type { NativeStealthBindings, StealthFeatureFlags, StealthWindowRole } from './StealthManager';

export type DisplayBounds = { x: number; y: number; width: number; height: number };
export type DisplayInfo = { id: number; workArea: DisplayBounds };
export type DisplayEventSource = { on: (event: string, listener: () => void) => void };
export type ScreenApi = DisplayEventSource & { getAllDisplays: () => DisplayInfo[] };

export interface StealthManagerDependencies {
  nativeModule?: NativeStealthBindings | null;
  platform?: string;
  powerMonitor?: { on: (event: string, listener: () => void) => void } | null;
  displayEvents?: DisplayEventSource | null;
  screenApi?: ScreenApi | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  featureFlags?: StealthFeatureFlags;
  intervalScheduler?: (callback: () => Promise<void> | void, intervalMs: number) => unknown;
  clearIntervalScheduler?: (handle: unknown) => void;
  timeoutScheduler?: (callback: () => void, delayMs: number) => unknown;
  virtualDisplayCoordinator?: VirtualDisplayCoordinator | null;
  captureToolPatterns?: RegExp[];
  processEnumerator?: (command: string, args: string[]) => Promise<string>;
}

export interface StealthCapableWindow {
  on?: (event: string, listener: () => void) => void;
  setContentProtection: (value: boolean) => void;
  setExcludeFromCapture?: (value: boolean) => void;
  setHiddenInMissionControl?: (value: boolean) => void;
  setExcludedFromShownWindowsMenu?: (value: boolean) => void;
  setSkipTaskbar?: (value: boolean) => void;
  setOpacity?: (value: number) => void;
  setBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void;
  hide?: () => void;
  show?: () => void;
  getNativeWindowHandle?: () => Buffer;
  getMediaSourceId?: () => string;
  getBounds?: () => { x: number; y: number; width: number; height: number };
  isVisible?: () => boolean;
  isDestroyed?: () => boolean;
}

export interface ManagedWindowRecord {
  win: StealthCapableWindow;
  role: StealthWindowRole;
  hideFromSwitcher: boolean;
  allowVirtualDisplayIsolation: boolean;
  listenersAttached: boolean;
  virtualDisplayRequestId: number;
  virtualDisplayIsolationStarted: boolean;
  privateMacosStealthApplied: boolean;
}
