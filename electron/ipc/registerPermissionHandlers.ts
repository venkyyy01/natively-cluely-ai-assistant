// electron/ipc/registerPermissionHandlers.ts
// IPC handlers for the macOS permission wizard. Lets the renderer:
//   - read the current permission snapshot,
//   - re-trigger the OS prompt for a given permission,
//   - deep-link the System Settings privacy pane.
//
// These handlers never throw at the IPC boundary — failures resolve into
// the standard `{ success: false, error }` envelope so a misbehaving native
// call can never poison the renderer's settings UI.

import type { AppState } from '../main';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';
import {
  type PermissionKey,
  type PermissionSnapshot,
} from '../permissions/PermissionWizard';

type RegisterPermissionHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
};

const VALID_KEYS: readonly PermissionKey[] = [
  'microphone',
  'screenRecording',
  'accessibility',
];

const ok = <T>(data: T) => ({ success: true as const, data });
const fail = (error: string) => ({ success: false as const, error });

function emptySnapshot(): PermissionSnapshot {
  return {
    microphone: 'unknown',
    screenRecording: 'unknown',
    accessibility: 'unknown',
    lastChecked: new Date().toISOString(),
    platform: process.platform,
  };
}

export function registerPermissionHandlers({
  appState,
  safeHandle,
  safeHandleValidated: _safeHandleValidated,
}: RegisterPermissionHandlersDeps): void {
  // Read-only snapshot of every permission. Triggers a fresh probe so
  // the renderer never sees a stale value relative to the OS.
  safeHandle('permissions:get-state', async () => {
    if (process.platform !== 'darwin') {
      // Other platforms: return a hard "n/a" snapshot rather than synthesising
      // 'granted' (which would be a lie). The renderer can decide whether to
      // show the toggle or hide the section entirely.
      return ok(emptySnapshot());
    }
    try {
      const snapshot = appState.getPermissionWizard().checkAndUpdate();
      return ok(snapshot);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(`Permission probe failed: ${reason}`);
    }
  });

  // Trigger the OS-side flow for a single permission key. macOS-only —
  // returns the post-prompt status so the renderer can update its UI.
  safeHandle('permissions:request', async (_event, rawKey: unknown) => {
    if (typeof rawKey !== 'string' || !(VALID_KEYS as readonly string[]).includes(rawKey)) {
      return fail(`Invalid permission key: ${String(rawKey)}`);
    }
    if (process.platform !== 'darwin') {
      // Honor the contract — return current snapshot for the requested key.
      return ok({ key: rawKey as PermissionKey, status: 'unknown' as const });
    }
    try {
      const status = await appState.getPermissionWizard().requestPermission(rawKey as PermissionKey);
      // After the prompt resolves, broadcast the fresh snapshot so any
      // other window in the app can react (e.g. the Settings overlay
      // refreshing the indicator without polling).
      appState.refreshPermissionState();
      return ok({ key: rawKey as PermissionKey, status });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(`Permission request failed: ${reason}`);
    }
  });

  // Open the System Settings privacy pane for a given permission. Useful
  // when the OS won't re-prompt (post-deny path) and the user must toggle
  // the switch manually.
  safeHandle('permissions:open-settings', async (_event, rawKey: unknown) => {
    if (typeof rawKey !== 'string' || !(VALID_KEYS as readonly string[]).includes(rawKey)) {
      return fail(`Invalid permission key: ${String(rawKey)}`);
    }
    if (process.platform !== 'darwin') {
      return ok({ opened: false });
    }
    try {
      await appState.getPermissionWizard().openSystemSettings(rawKey as PermissionKey);
      return ok({ opened: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(`Open settings failed: ${reason}`);
    }
  });
}
