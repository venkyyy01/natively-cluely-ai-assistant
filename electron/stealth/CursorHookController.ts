import { BrowserWindow, screen } from 'electron';

/**
 * Wires the native `CursorHook` (CGEventTap on macOS, WH_MOUSE_LL on Windows)
 * to the overlay window's lifecycle events.
 *
 * Behaviour summary:
 *   1. While disabled or the overlay is hidden, the native hook is inactive
 *      and zero events are intercepted — no perf cost, no permission grab.
 *   2. When the overlay becomes visible AND the feature is enabled, we push
 *      the overlay's screen rect into the native hook and call setActive(true).
 *      The hook then swallows mouse events that land inside the rect,
 *      freezing the OS cursor at the overlay edge.
 *   3. The native module emits virtual cursor events as JSON strings via a
 *      thread-safe N-API callback; we forward them to the overlay renderer
 *      as `virtual-mouse-event` IPC messages so React can paint a software
 *      cursor and synthesize hover / click hits inside the DOM.
 *   4. Permission denial does not crash anything — we log a warning, mark
 *      the controller as "permission-denied" (recoverable), and the
 *      renderer falls back to displaying the OS cursor as before. A
 *      subsequent `enable()` after the user grants the permission retries
 *      the start path.
 *
 * Compatibility:
 *   - macOS 10.14+ and Windows 10+. On other platforms `enable()` is a no-op.
 *   - Hook is created lazily on the first enable() call so we don't grab the
 *     OS permission prompt at app startup.
 */
type Unavailability = 'never-tried' | 'module-missing' | 'permission-denied';

export class CursorHookController {
  private readonly overlayWindow: BrowserWindow;
  private hook: NativeCursorHook | null = null;
  /**
   * Tri-state availability cache.
   *   - 'never-tried'      → next enable() will probe the native module.
   *   - 'module-missing'   → require('natively-audio') failed or symbol
   *     absent; the binary is mismatched / not bundled. STICKY for
   *     process lifetime — re-trying never recovers.
   *   - 'permission-denied' → module loaded but `start()` rejected (most
   *     commonly Accessibility on macOS). RECOVERABLE — once the user
   *     grants the permission, the next `enable()` retries cleanly.
   */
  private unavailability: Unavailability = 'never-tried';
  private boundsListenersAttached = false;
  private displayListenersAttached = false;
  private overlayShowListener: (() => void) | null = null;
  private overlayHideListener: (() => void) | null = null;
  private overlayMoveListener: (() => void) | null = null;
  private overlayResizeListener: (() => void) | null = null;
  private overlayClosedListener: (() => void) | null = null;
  private displayMetricsListener: (() => void) | null = null;
  private displayAddedListener: (() => void) | null = null;
  private displayRemovedListener: (() => void) | null = null;
  private enabled = false;
  private active = false;

  constructor(overlayWindow: BrowserWindow) {
    this.overlayWindow = overlayWindow;
  }

  /**
   * Enable the cursor hook. Idempotent — safe to call repeatedly.
   * Returns true if the hook is now installed (or was already installed),
   * false if the OS permission was denied or the native binding
   * is unavailable in the current build.
   *
   * If the previous attempt failed with "permission denied" (recoverable),
   * a subsequent call will retry the native start so a freshly-granted
   * Accessibility permission takes effect without an app restart.
   * "Module missing" is sticky for the process lifetime.
   */
  public enable(): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
    if (this.unavailability === 'module-missing') return false;
    if (this.enabled) return true;

    const hook = this.ensureHook();
    if (!hook) return false;

    try {
      hook.start((jsonPayload: string) => {
        // Native callback runs on a non-main thread via N-API tsfn dispatch
        // back to the JS event loop. Keep the work here trivial — parse and
        // forward.
        this.dispatchVirtualEvent(jsonPayload);
      });
    } catch (err) {
      // Most common failures:
      //   * macOS: Accessibility permission not granted.
      //   * Windows: SetWindowsHookExW denied (rare; usually elevated apps).
      // We classify as "permission-denied" so a subsequent enable()
      // (after the user grants the OS permission) retries cleanly.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        '[CursorHookController] Failed to start native cursor hook (likely permission denied):',
        reason
      );
      this.unavailability = 'permission-denied';
      // Drop the hook instance so the next enable() rebuilds a fresh one.
      this.hook = null;
      return false;
    }

    this.unavailability = 'never-tried';
    this.enabled = true;
    this.attachOverlayLifecycle();
    // If the overlay is already visible, arm immediately.
    if (!this.overlayWindow.isDestroyed() && this.overlayWindow.isVisible()) {
      this.arm();
    }
    return true;
  }

  /**
   * Disable the cursor hook. Tears down the CGEventTap and detaches
   * lifecycle listeners. Idempotent. Resets the recoverable
   * "permission-denied" state so the next `enable()` will retry the
   * native start path.
   */
  public disable(): void {
    if (this.unavailability === 'permission-denied') {
      // Allow recovery on next enable.
      this.unavailability = 'never-tried';
    }
    if (!this.enabled) return;
    this.enabled = false;
    this.disarm();
    this.detachOverlayLifecycle();
    if (this.hook) {
      try {
        this.hook.stop();
      } catch (err) {
        console.warn('[CursorHookController] hook.stop failed:', err);
      }
      this.hook = null;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Force-refresh the bounds we publish to the native hook. Called whenever
   * the overlay moves / resizes / changes screen / changes displayScaleFactor.
   */
  public refreshOverlayBounds(): void {
    if (!this.enabled || !this.hook) return;
    if (this.overlayWindow.isDestroyed()) return;
    const bounds = this.overlayWindow.getBounds();
    try {
      this.hook.setOverlayBounds(bounds.x, bounds.y, bounds.width, bounds.height);
    } catch (err) {
      console.warn('[CursorHookController] setOverlayBounds failed:', err);
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private ensureHook(): NativeCursorHook | null {
    if (this.hook) return this.hook;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const native = require('natively-audio') as NativeCursorBindings;
      // The Rust binding now exports a unified `CursorHook` class. The old
      // `MacosCursorHook` name is kept as an alias for backwards compat
      // during the transition.
      const Ctor = native?.CursorHook ?? native?.MacosCursorHook;
      if (!Ctor) {
        console.warn('[CursorHookController] Native CursorHook export missing — feature unavailable');
        this.nativeUnavailable = true;
        return null;
      }
      this.hook = new Ctor();
      return this.hook;
    } catch (err) {
      console.warn('[CursorHookController] Failed to load native module:', err);
      this.nativeUnavailable = true;
      return null;
    }
  }

  private arm(): void {
    if (this.active || !this.enabled || !this.hook) return;
    this.refreshOverlayBounds();
    try {
      this.hook.setActive(true);
      this.active = true;
    } catch (err) {
      console.warn('[CursorHookController] setActive(true) failed:', err);
    }
  }

  private disarm(): void {
    if (!this.active || !this.hook) return;
    try {
      this.hook.setActive(false);
    } catch (err) {
      console.warn('[CursorHookController] setActive(false) failed:', err);
    }
    this.active = false;
  }

  private attachOverlayLifecycle(): void {
    if (this.boundsListenersAttached || this.overlayWindow.isDestroyed()) return;
    this.boundsListenersAttached = true;

    this.overlayShowListener = () => this.arm();
    this.overlayHideListener = () => this.disarm();
    this.overlayMoveListener = () => this.refreshOverlayBounds();
    this.overlayResizeListener = () => this.refreshOverlayBounds();
    this.overlayClosedListener = () => this.disable();

    this.overlayWindow.on('show', this.overlayShowListener);
    this.overlayWindow.on('hide', this.overlayHideListener);
    this.overlayWindow.on('move', this.overlayMoveListener);
    this.overlayWindow.on('resize', this.overlayResizeListener);
    this.overlayWindow.on('closed', this.overlayClosedListener);

    if (!this.displayListenersAttached) {
      this.displayMetricsListener = () => this.refreshOverlayBounds();
      screen.on('display-metrics-changed', this.displayMetricsListener);
      this.displayListenersAttached = true;
    }
  }

  private detachOverlayLifecycle(): void {
    if (!this.boundsListenersAttached) return;
    try {
      if (this.overlayShowListener) this.overlayWindow.removeListener('show', this.overlayShowListener);
      if (this.overlayHideListener) this.overlayWindow.removeListener('hide', this.overlayHideListener);
      if (this.overlayMoveListener) this.overlayWindow.removeListener('move', this.overlayMoveListener);
      if (this.overlayResizeListener) this.overlayWindow.removeListener('resize', this.overlayResizeListener);
      if (this.overlayClosedListener) this.overlayWindow.removeListener('closed', this.overlayClosedListener);
    } catch (err) {
      // Window may already be destroyed; that's fine.
      void err;
    }
    this.overlayShowListener = null;
    this.overlayHideListener = null;
    this.overlayMoveListener = null;
    this.overlayResizeListener = null;
    this.overlayClosedListener = null;
    this.boundsListenersAttached = false;

    if (this.displayListenersAttached && this.displayMetricsListener) {
      try {
        screen.removeListener('display-metrics-changed', this.displayMetricsListener);
      } catch {
        // ignore
      }
      this.displayMetricsListener = null;
      this.displayListenersAttached = false;
    }
  }

  private dispatchVirtualEvent(jsonPayload: string): void {
    if (this.overlayWindow.isDestroyed()) return;
    let payload: VirtualMousePayload | null = null;
    try {
      payload = JSON.parse(jsonPayload) as VirtualMousePayload;
    } catch (err) {
      console.warn('[CursorHookController] failed to parse virtual mouse payload:', err);
      return;
    }
    if (!payload) return;

    // Translate from global screen coords to overlay-local coords once,
    // here, so the renderer never has to know about display layout.
    const bounds = this.overlayWindow.getBounds();
    const localX = payload.x - bounds.x;
    const localY = payload.y - bounds.y;

    this.overlayWindow.webContents.send('virtual-mouse-event', {
      kind: payload.kind,
      button: payload.button,
      // Keep both global and local — renderer uses local for layout, global
      // is useful for diagnostics.
      globalX: payload.x,
      globalY: payload.y,
      x: localX,
      y: localY,
      scrollDx: payload.scrollDx ?? 0,
      scrollDy: payload.scrollDy ?? 0,
    });
  }
}

interface NativeCursorHook {
  setOverlayBounds(x: number, y: number, width: number, height: number): void;
  setActive(active: boolean): void;
  start(callback: (jsonPayload: string) => void): void;
  stop(): void;
  isActive(): boolean;
}

interface NativeCursorBindings {
  MacosCursorHook?: new () => NativeCursorHook;
  CursorHook?: new () => NativeCursorHook;
}

interface VirtualMousePayload {
  kind: 'move' | 'down' | 'up' | 'scroll';
  button: number;
  x: number;
  y: number;
  scrollDx?: number;
  scrollDy?: number;
}
