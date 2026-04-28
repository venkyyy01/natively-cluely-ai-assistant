import type { StealthCapableWindow, ManagedWindowRecord } from './stealthTypes';
import type { StealthWindowRole, StealthApplyOptions } from './StealthManager';

export function defaultHideFromSwitcher(role: StealthWindowRole): boolean {
  return role === 'auxiliary';
}

export function isWindowDestroyed(win: StealthCapableWindow): boolean {
  return typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
}

export function safeGetMediaSourceId(
  win: StealthCapableWindow,
  logger?: Pick<Console, 'warn'>,
): string | null {
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
    return null;
  }

  try {
    return win.getMediaSourceId?.() ?? null;
  } catch (error) {
    logger?.warn('[StealthManager] Failed to read media source id from managed window:', error);
    return null;
  }
}

export function createManagedWindowRecord(
  win: StealthCapableWindow,
  options: StealthApplyOptions,
  managedWindows: Set<ManagedWindowRecord>,
  managedWindowLookup: WeakMap<object, ManagedWindowRecord>,
): ManagedWindowRecord {
  const existing = managedWindowLookup.get(win as object);
  if (existing) {
    return existing;
  }

  const record: ManagedWindowRecord = {
    win,
    role: options.role ?? 'primary',
    hideFromSwitcher: options.hideFromSwitcher ?? defaultHideFromSwitcher(options.role ?? 'primary'),
    allowVirtualDisplayIsolation: options.allowVirtualDisplayIsolation ?? false,
    listenersAttached: false,
    virtualDisplayRequestId: 0,
    virtualDisplayIsolationStarted: false,
    privateMacosStealthApplied: false,
  };
  managedWindows.add(record);
  managedWindowLookup.set(win as object, record);
  return record;
}

export interface LifecycleListenerCallbacks {
  reapplyAfterShow: (win: StealthCapableWindow) => void;
  onClosed: (record: ManagedWindowRecord) => void;
}

export function attachLifecycleListeners(
  record: ManagedWindowRecord,
  callbacks: LifecycleListenerCallbacks,
): void {
  if (record.listenersAttached || typeof record.win.on !== 'function') {
    return;
  }

  const reapply = () => callbacks.reapplyAfterShow(record.win);
  record.win.on('restore', reapply);
  record.win.on('unminimize', reapply);
  record.win.on('move', reapply);
  record.win.on('show', reapply);
  record.win.on('closed', () => callbacks.onClosed(record));
  record.listenersAttached = true;
}
