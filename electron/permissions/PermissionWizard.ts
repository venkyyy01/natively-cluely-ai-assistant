// electron/permissions/PermissionWizard.ts
// Sequential first-launch permission wizard for macOS.
// Guides the user through Microphone, Screen Recording, and Accessibility
// permissions one at a time, persisting state to avoid re-prompting.

import { app, dialog, shell, systemPreferences, Notification, desktopCapturer } from 'electron';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionStatus = 'granted' | 'denied' | 'unknown';
export type PermissionKey = 'microphone' | 'screenRecording' | 'accessibility';

export interface PermissionState {
  wizardCompleted: boolean;
  microphone: PermissionStatus;
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
  lastChecked: string; // ISO 8601
}

export interface PermissionSnapshot {
  microphone: PermissionStatus;
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
  lastChecked: string;
  platform: NodeJS.Platform;
}

export interface PermissionWizardConfig {
  /** Absolute path to the permission-state.json file in userData */
  stateFilePath: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PERMISSION_STATE: PermissionState = {
  wizardCompleted: false,
  microphone: 'unknown',
  screenRecording: 'unknown',
  accessibility: 'unknown',
  lastChecked: new Date().toISOString(),
};

/**
 * Stable deep-link URLs for the macOS System Settings privacy panes.
 * macOS 13+ uses x-apple.systempreferences with these keys; the same
 * URLs work back to macOS 10.15 via legacy Preferences.app fallback.
 */
const MAC_SETTINGS_URL_BY_KEY: Record<PermissionKey, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

// ---------------------------------------------------------------------------
// PermissionWizard Class
// ---------------------------------------------------------------------------

export class PermissionWizard {
  private config: PermissionWizardConfig;

  constructor(config: PermissionWizardConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------------

  /**
   * Load persisted permission state from disk.
   * Returns defaults if the file is missing or corrupt.
   */
  loadState(): PermissionState {
    try {
      if (!fs.existsSync(this.config.stateFilePath)) {
        return { ...DEFAULT_PERMISSION_STATE, lastChecked: new Date().toISOString() };
      }
      const data = fs.readFileSync(this.config.stateFilePath, 'utf8');
      const parsed = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn('[PermissionWizard] State file is not a valid object, resetting.');
        return { ...DEFAULT_PERMISSION_STATE, lastChecked: new Date().toISOString() };
      }
      return this.sanitizeState(parsed);
    } catch (err) {
      console.warn('[PermissionWizard] Failed to load state file, resetting:', err);
      return { ...DEFAULT_PERMISSION_STATE, lastChecked: new Date().toISOString() };
    }
  }

  /**
   * Save permission state to disk with mkdirSync safety.
   */
  saveState(state: PermissionState): void {
    try {
      const dir = path.dirname(this.config.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this.config.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.config.stateFilePath);
      console.log('[PermissionWizard] State saved successfully.');
    } catch (err) {
      console.error('[PermissionWizard] Failed to save state:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Wizard control
  // -------------------------------------------------------------------------

  /**
   * Determine if the wizard should run (first launch).
   * Returns true if wizardCompleted is not set.
   */
  shouldRunWizard(): boolean {
    const state = this.loadState();
    return !state.wizardCompleted;
  }

  /**
   * Run the full sequential permission wizard.
   * Step 1: Microphone — native dialog + askForMediaAccess
   * Step 2: Screen Recording — native dialog + open System Settings
   * Step 3: Accessibility — native dialog + open System Settings
   * Persists wizardCompleted: true and permission states on completion.
   */
  async runWizard(): Promise<void> {
    console.log('[PermissionWizard] Starting first-launch permission wizard...');

    const state: PermissionState = {
      wizardCompleted: false,
      microphone: 'unknown',
      screenRecording: 'unknown',
      accessibility: 'unknown',
      lastChecked: new Date().toISOString(),
    };

    // Step 1: Microphone
    await dialog.showMessageBox({
      type: 'info',
      title: 'Microphone Access Required',
      message: 'Natively needs microphone access to transcribe audio during meetings.',
      detail: 'You will be prompted by macOS to grant microphone access. Please click "OK" to allow.',
      buttons: ['Continue'],
      defaultId: 0,
    });

    try {
      const micGranted = await systemPreferences.askForMediaAccess('microphone');
      state.microphone = micGranted ? 'granted' : 'denied';
      console.log(`[PermissionWizard] Microphone: ${state.microphone}`);
    } catch (err) {
      console.error('[PermissionWizard] Failed to request microphone access:', err);
      state.microphone = 'denied';
    }

    // Step 2: Screen Recording
    await dialog.showMessageBox({
      type: 'info',
      title: 'Screen Recording Access Required',
      message: 'Natively needs screen recording access to capture on-screen content for context.',
      detail: 'macOS requires you to enable this manually in System Settings. Click "Continue" to open the Screen Recording privacy pane.',
      buttons: ['Continue'],
      defaultId: 0,
    });

    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      );
      // We cannot programmatically detect screen recording status reliably before
      // the user toggles it, so mark as unknown until next check.
      state.screenRecording = this.getScreenRecordingStatus();
      console.log(`[PermissionWizard] Screen Recording: ${state.screenRecording}`);
    } catch (err) {
      console.error('[PermissionWizard] Failed to open Screen Recording settings:', err);
      state.screenRecording = 'unknown';
    }

    // Step 3: Accessibility
    await dialog.showMessageBox({
      type: 'info',
      title: 'Accessibility Access Required',
      message: 'Natively needs accessibility access to interact with system UI elements.',
      detail: 'macOS requires you to enable this manually in System Settings. Click "Continue" to open the Accessibility privacy pane.',
      buttons: ['Continue'],
      defaultId: 0,
    });

    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      );
      state.accessibility = this.getAccessibilityStatus();
      console.log(`[PermissionWizard] Accessibility: ${state.accessibility}`);
    } catch (err) {
      console.error('[PermissionWizard] Failed to open Accessibility settings:', err);
      state.accessibility = 'unknown';
    }

    // Persist completion
    state.wizardCompleted = true;
    state.lastChecked = new Date().toISOString();
    this.saveState(state);

    console.log('[PermissionWizard] Wizard completed successfully.');
  }

  // -------------------------------------------------------------------------
  // Revocation detection
  // -------------------------------------------------------------------------

  /**
   * Check for revoked permissions on subsequent launches.
   * Compares current system status against persisted state.
   * Returns a list of permission names that were previously granted but are now denied.
   */
  async checkRevocations(): Promise<string[]> {
    const state = this.loadState();
    const revoked: string[] = [];

    // Check microphone
    const currentMic = this.getMicrophoneStatus();
    if (state.microphone === 'granted' && currentMic !== 'granted') {
      revoked.push('microphone');
    }

    // Check screen recording
    const currentScreen = this.getScreenRecordingStatus();
    if (state.screenRecording === 'granted' && currentScreen !== 'granted') {
      revoked.push('screenRecording');
    }

    // Check accessibility
    const currentAccessibility = this.getAccessibilityStatus();
    if (state.accessibility === 'granted' && currentAccessibility !== 'granted') {
      revoked.push('accessibility');
    }

    // Update persisted state with current values
    const updatedState: PermissionState = {
      ...state,
      microphone: currentMic,
      screenRecording: currentScreen,
      accessibility: currentAccessibility,
      lastChecked: new Date().toISOString(),
    };
    this.saveState(updatedState);

    // Show warning notifications for revoked permissions
    if (revoked.length > 0) {
      for (const perm of revoked) {
        this.showRevocationWarning(perm);
      }
    }

    return revoked;
  }

  // -------------------------------------------------------------------------
  // Public re-check + targeted request API (used by IPC + focus listener)
  // -------------------------------------------------------------------------

  /**
   * Re-probe every permission, persist the result, and return a snapshot.
   * Called from:
   *   - The renderer-facing `permissions:get-state` IPC handler.
   *   - The `app.on('browser-window-focus')` hook so a permission granted
   *     in System Settings while the app is running is picked up without a
   *     restart.
   *   - The Settings UI on demand when the user clicks "Refresh".
   *
   * Never throws — TCC lookup failures degrade to `'unknown'`. The returned
   * snapshot always reflects the freshest known truth.
   */
  checkAndUpdate(): PermissionSnapshot {
    const previous = this.loadState();
    const microphone = this.getMicrophoneStatus();
    const screenRecording = this.getScreenRecordingStatus();
    const accessibility = this.getAccessibilityStatus();
    const lastChecked = new Date().toISOString();
    const next: PermissionState = {
      ...previous,
      microphone,
      screenRecording,
      accessibility,
      lastChecked,
    };
    // Only persist when something actually changed; avoids a write storm when
    // browser-window-focus fires repeatedly while permissions are stable.
    if (
      previous.microphone !== microphone ||
      previous.screenRecording !== screenRecording ||
      previous.accessibility !== accessibility
    ) {
      this.saveState(next);
    }
    return {
      microphone,
      screenRecording,
      accessibility,
      lastChecked,
      platform: process.platform,
    };
  }

  /**
   * Trigger the OS prompt for a single permission. macOS-only. Behaviour:
   *   - microphone: calls `askForMediaAccess('microphone')`. Triggers the
   *     OS prompt the first time; resolves to the post-prompt status.
   *   - screenRecording: opens a tiny `desktopCapturer.getSources` request.
   *     macOS treats this as the "first attempted capture" and fires the
   *     consent prompt. Subsequent calls are silent. We then poll the
   *     status; if still not granted, we open the System Settings pane.
   *   - accessibility: there is no programmatic prompt API. We open the
   *     System Settings → Accessibility pane and poll status.
   *
   * Returns the post-attempt status. Persists state via `checkAndUpdate()`.
   */
  async requestPermission(key: PermissionKey): Promise<PermissionStatus> {
    if (process.platform !== 'darwin') {
      // Other platforms either don't gate (Linux microphone via ALSA/PA) or
      // gate at install time (Windows mic capability). Return current state.
      return this.snapshotByKey(key);
    }

    try {
      switch (key) {
        case 'microphone': {
          const status = systemPreferences.getMediaAccessStatus('microphone');
          if (status === 'not-determined' || status === 'unknown') {
            const granted = await systemPreferences.askForMediaAccess('microphone');
            console.log(`[PermissionWizard] askForMediaAccess(microphone) → ${granted}`);
          } else if (status !== 'granted') {
            // 'denied' / 'restricted' — System Settings is the only path.
            await this.openSystemSettings(key);
          }
          break;
        }
        case 'screenRecording': {
          // Trigger the OS consent prompt by attempting a token capture.
          // `desktopCapturer.getSources` is the documented Electron-side
          // way to invoke the macOS Screen Recording prompt without
          // actually capturing anything sensitive.
          try {
            await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: { width: 1, height: 1 },
            });
          } catch (err) {
            console.warn('[PermissionWizard] desktopCapturer probe failed (expected on first run with no consent):', err);
          }
          const status = systemPreferences.getMediaAccessStatus('screen');
          if (status !== 'granted') {
            // Pre-consent or post-deny: System Settings pane is the next step.
            await this.openSystemSettings(key);
          }
          break;
        }
        case 'accessibility': {
          // No programmatic prompt API. Open the pane and rely on user.
          await this.openSystemSettings(key);
          break;
        }
        default: {
          // Exhaustiveness guard.
          const _exhaustive: never = key;
          void _exhaustive;
        }
      }
    } catch (err) {
      console.warn(`[PermissionWizard] requestPermission(${key}) failed:`, err);
    }

    // Re-probe after the prompt / settings open.
    this.checkAndUpdate();
    return this.snapshotByKey(key);
  }

  /**
   * Open the System Settings privacy pane for a given permission. Only
   * meaningful on macOS — other platforms get a best-effort fallback.
   */
  async openSystemSettings(key: PermissionKey): Promise<void> {
    if (process.platform !== 'darwin') {
      return;
    }
    const url = MAC_SETTINGS_URL_BY_KEY[key];
    if (!url) return;
    try {
      await shell.openExternal(url);
    } catch (err) {
      console.warn(`[PermissionWizard] openSystemSettings(${key}) failed:`, err);
    }
  }

  /** Read just one permission's current status without persisting. */
  snapshotByKey(key: PermissionKey): PermissionStatus {
    switch (key) {
      case 'microphone': return this.getMicrophoneStatus();
      case 'screenRecording': return this.getScreenRecordingStatus();
      case 'accessibility': return this.getAccessibilityStatus();
    }
  }

  // -------------------------------------------------------------------------
  // Permission status helpers
  // -------------------------------------------------------------------------

  private getMicrophoneStatus(): PermissionStatus {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return 'granted';
      if (status === 'denied') return 'denied';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private getScreenRecordingStatus(): PermissionStatus {
    try {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'granted') return 'granted';
      if (status === 'denied') return 'denied';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private getAccessibilityStatus(): PermissionStatus {
    try {
      // systemPreferences.isTrustedAccessibilityClient(false) checks without prompting
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      return trusted ? 'granted' : 'denied';
    } catch {
      return 'unknown';
    }
  }

  // -------------------------------------------------------------------------
  // Notification helpers
  // -------------------------------------------------------------------------

  private showRevocationWarning(permission: string): void {
    const permissionLabels: Record<string, string> = {
      microphone: 'Microphone',
      screenRecording: 'Screen Recording',
      accessibility: 'Accessibility',
    };

    const label = permissionLabels[permission] || permission;

    try {
      const notification = new Notification({
        title: `${label} Permission Revoked`,
        body: `Natively requires ${label} access to function properly. Please re-enable it in System Settings > Privacy & Security > ${label}.`,
      });
      notification.show();
    } catch (err) {
      // Fallback to dialog if Notification is not available
      console.warn(`[PermissionWizard] ${label} permission has been revoked.`);
      void dialog.showMessageBox({
        type: 'warning',
        title: `${label} Permission Revoked`,
        message: `Natively requires ${label} access to function properly.`,
        detail: `Please re-enable it in System Settings > Privacy & Security > ${label}.`,
        buttons: ['OK'],
      });
    }
  }

  // -------------------------------------------------------------------------
  // State sanitization
  // -------------------------------------------------------------------------

  private sanitizeState(raw: Record<string, unknown>): PermissionState {
    const validStatuses: PermissionStatus[] = ['granted', 'denied', 'unknown'];

    return {
      wizardCompleted: typeof raw.wizardCompleted === 'boolean' ? raw.wizardCompleted : false,
      microphone: validStatuses.includes(raw.microphone as PermissionStatus)
        ? (raw.microphone as PermissionStatus)
        : 'unknown',
      screenRecording: validStatuses.includes(raw.screenRecording as PermissionStatus)
        ? (raw.screenRecording as PermissionStatus)
        : 'unknown',
      accessibility: validStatuses.includes(raw.accessibility as PermissionStatus)
        ? (raw.accessibility as PermissionStatus)
        : 'unknown',
      lastChecked: typeof raw.lastChecked === 'string' ? raw.lastChecked : new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create a PermissionWizard instance using the default userData path.
 * Must be called after app.whenReady().
 */
export function createPermissionWizard(): PermissionWizard {
  const stateFilePath = path.join(app.getPath('userData'), 'permission-state.json');
  return new PermissionWizard({ stateFilePath });
}
