export type StealthIsolationMode =
  | 'disabled'
  | 'window-affinity'
  | 'macos-sharing-none'
  | 'macos-private-api'
  | 'virtual-display'
  | 'protected-surface';

export type StealthProject =
  | 'electron-app'
  | 'macos-virtual-display-helper'
  | 'windows-idd-driver'
  | 'windows-protected-render-host'
  | 'integration-harness';

export interface StealthFeatureFlagSnapshot {
  enablePrivateMacosStealthApi: boolean;
  enableCaptureDetectionWatchdog: boolean;
  enableVirtualDisplayIsolation: boolean;
}

export interface DisplayIsolationRequest {
  project: StealthProject;
  mode: StealthIsolationMode;
  sessionId: string;
  windowId: string;
  displayId?: string;
  width: number;
  height: number;
  pixelFormat: 'bgra8' | 'rgba8';
}

export interface DisplayIsolationStatus {
  project: StealthProject;
  sessionId: string;
  ready: boolean;
  mode: StealthIsolationMode;
  surfaceToken?: string;
  reason?: string;
}

export interface CaptureDetectionEvent {
  detectedAt: string;
  toolName: string;
  sourceType: 'window' | 'screen';
  mitigation: 'hide-and-restore' | 'none';
}
