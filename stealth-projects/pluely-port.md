How the pluely app works : Here's a deep-dive into how Pluely is hidden from screenshots, screen recordings, and screen shares.

## Short answer

Pluely does not implement a custom ScreenCaptureKit (SCK) `SCContentFilter` exclusion. The invisibility comes from a stack of native macOS window flags applied to every Pluely window, with a Tauri-level `contentProtected` toggle that maps to those flags on each OS. The two pieces that actually make the window disappear from captures are:

1. `NSWindow.sharingType = NSWindowSharingNone` (raw Objective‑C `msg_send`).
2. Tauri's built-in `content_protected: true` on every WebviewWindowBuilder, which on Windows maps to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` and on macOS to the same `NSWindowSharingNone` path.

Everything else (translucent overlay, click-through, hidden dock icon, hidden cursor, `NSPanel` conversion) is supporting stealth, but the actual capture exclusion is those two flags.

## Architecture map

The invisibility logic lives in `src-tauri/src/`:

- `lib.rs` — defines the privacy primitives and converts the main window into an `NSPanel`.
- `window.rs` — applies privacy mode + `content_protected` to the dashboard window, plus click-through and ignore-cursor toggles.
- `capture.rs` — applies the same privacy mode to every transient screenshot-selection overlay it spawns.
- `shortcuts.rs` — exposes `set_app_icon_visibility` (dock hiding) and `set_always_on_top`.
- `tauri.conf.json` — declares the main window with `contentProtected: true`, `transparent: true`, `decorations: false`, `skipTaskbar: true`, plus `macOSPrivateApi: true` (required for transparency + private NSPanel APIs).

## The core primitive

In `src-tauri/src/lib.rs`:

```rust
pub(crate) unsafe fn apply_privacy_mode_to_window(ns_window: tauri_nspanel::cocoa::base::id) {
    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use objc::{msg_send, sel, sel_impl};

    let _: () = msg_send![ns_window, setSharingType: 0u64];

    let existing_behavior: NSWindowCollectionBehavior = msg_send![ns_window, collectionBehavior];
    let privacy_behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle;
    let _: () = msg_send![ns_window, setCollectionBehavior: existing_behavior | privacy_behavior];
}
```

What each line does:

- `setSharingType: 0` — `0` is `NSWindowSharingNone`. AppKit promises that windows with this sharing type are not visible to other processes, including the screen capture pipeline. SCK and the legacy CGWindow APIs both honor this flag, so the window is invisible to Zoom, Meet, Teams, Slack Huddles, QuickTime, the macOS screenshot tool, and most third-party recorders.
- `NSWindowCollectionBehaviorTransient` — keeps the window from showing up in Mission Control / Exposé / window cycling, so it's not enumerable as a "shareable window" in pickers.
- `NSWindowCollectionBehaviorIgnoresCycle` — excludes it from `Cmd+\`` window cycling.

The Tauri wrapper just resolves the NSWindow handle and calls into the unsafe primitive:

```rust
pub(crate) fn apply_privacy_mode_to_webview_window<R>(window: &tauri::WebviewWindow<R>) {
    if let Ok(ns_window) = window.ns_window() {
        unsafe { apply_privacy_mode_to_window(ns_window as id); }
    }
}
```

## Where it gets applied

Three call sites, covering every window the app ever creates:

1. Main overlay panel (`lib.rs::init`, runs in `setup`):

```rust
let panel = window.to_panel()?;
panel.set_level(NSFloatWindowLevel);                              // 4 — above normal apps
panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);        // 1<<7 — won't steal focus
panel.set_collection_behaviour(
    NSWindowCollectionBehaviorFullScreenAuxiliary
    | NSWindowCollectionBehaviorCanJoinAllSpaces,                 // floats over fullscreen apps
);
let raw_panel: id = std::mem::transmute_copy(&panel);
apply_privacy_mode_to_window(raw_panel);
```

The conversion from a normal NSWindow to an `NSPanel` (via `tauri-nspanel`) is what allows the overlay to coexist with fullscreen Zoom/Keynote sessions and not become the key window. Privacy mode is then layered on top.

2. Dashboard window (`window.rs::create_dashboard_window`):

```rust
.content_protected(true)
.visible(false)
...
let window = base_builder.build()?;
#[cfg(target_os = "macos")]
crate::apply_privacy_mode_to_webview_window(&window);
```

3. Per-monitor screenshot selection overlays (`capture.rs::start_screen_capture`):

```rust
WebviewWindowBuilder::new(&app, &window_label, ...)
    .transparent(true)
    .always_on_top(true)
    .content_protected(true)   // belt
    ...
    .build()?;

#[cfg(target_os = "macos")]
crate::apply_privacy_mode_to_webview_window(&overlay);  // suspenders
```

The selection overlays specifically need this because they cover the whole screen during screenshot region selection. Without it, the user's region-select UI would itself appear in any concurrent screen recording.

## Tauri-level `contentProtected`

In `tauri.conf.json` the main window is declared:

```json
{
  "macOSPrivateApi": true,
  "windows": [{
    "transparent": true,
    "decorations": false,
    "alwaysOnTop": false,
    "skipTaskbar": true,
    "contentProtected": true,
    "focus": false,
    "shadow": false,
    "acceptFirstMouse": true
  }]
}
```

`contentProtected: true` is Tauri's cross-platform abstraction:

- macOS — calls `setSharingType: NSWindowSharingNone` (same effect as the manual `msg_send`, applied early in window creation; the explicit Rust call is a redundant guarantee in case the window is rebuilt or the panel conversion resets it).
- Windows — `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`, which excludes the window from `BitBlt`, DWM thumbnails, and the modern Graphics Capture API used by Teams/OBS/etc. on Win10 2004+.
- Linux — no-op (X11/Wayland have no equivalent), which is why the README and cursor-type code path explicitly disable the "invisible" cursor mode on Linux and the `apply_main_window_click_through_for_app` Linux branch is empty.

`macOSPrivateApi: true` is also required — it unlocks Tauri's transparent windows + the private NSPanel conversion. Without it the overlay can't be both translucent and a non-activating panel.

## Supporting stealth features

These don't hide the window from capture, but they make the window forensically unobtrusive:

- Non-activating panel (`NSWindowStyleMaskNonActivatingPanel`) — Pluely never steals focus, so it doesn't appear in `Cmd+Tab`, doesn't move app focus during meetings, and doesn't make the active app lose first-responder status.
- `NSFloatWindowLevel` + `CanJoinAllSpaces` + `FullScreenAuxiliary` — overlay floats above fullscreen apps without forcing a Space switch.
- Dock icon hide via `set_app_icon_visibility` (`shortcuts.rs`):
  ```rust
  let policy = if visible { ActivationPolicy::Regular } else { ActivationPolicy::Accessory };
  app.set_activation_policy(policy)?;
  ```
  `Accessory` makes the app behave like a menu bar utility — no dock icon, no `Cmd+Tab` entry. On Windows/Linux it falls back to `set_skip_taskbar`.
- Click-through (`window.rs::apply_main_window_click_through_for_app`) — `panel.set_ignore_mouse_events(true) + set_accepts_mouse_moved_events(false) + set_becomes_key_only_if_needed(true) + window.set_ignore_cursor_events(true)`. Lets the cursor pass through the overlay so users don't accidentally interact with it during screen sharing demos.
- Invisible cursor (`src/contexts/app.context.tsx`) — sets `--cursor-type: none` via CSS when the user picks "invisible". Prevents the cursor from telegraphing the overlay's location to viewers (cursors are drawn by the compositor, separate from window content, and remain visible in screen shares).
- `skipTaskbar: true`, `decorations: false`, `transparent: true`, `shadow: false`, no title — nothing for a screenshare audience to notice if a stray pixel were ever captured.
- Conditional PostHog telemetry (`lib.rs`) — only registers when an API key is baked in, with session recording / pageviews / pageleaves all disabled.

## What's notably not used

There is no explicit ScreenCaptureKit `SCContentFilter` with `excludingApplications:` or `excludingWindows:` self-exclusion. SCK actually consults the same `NSWindow.sharingType` for its default filters, so when other apps capture via SCK they don't see Pluely. The only `cidre`/SCK-adjacent code in the repo is in `src-tauri/src/speaker/macos.rs`, which uses CoreAudio process taps (`ca::TapDesc::with_mono_global_tap_excluding_processes`) for system audio capture — that's process tap exclusion, not window/screen exclusion.

## End-to-end flow

1. App launches → Tauri reads `tauri.conf.json` → main window created with `contentProtected: true`, `transparent: true`, `macOSPrivateApi: true`.
2. `setup()` → `setup_main_window` positions it top-center → on macOS, `init()` runs:
   - `window.to_panel()` reclassifies the NSWindow as an NSPanel.
   - Panel level / style mask / collection behavior set.
   - `apply_privacy_mode_to_window(raw_panel)` reasserts `NSWindowSharingNone` + transient/ignores-cycle.
3. Dashboard pre-created with `content_protected(true)` + `apply_privacy_mode_to_webview_window`.
4. User hits screenshot shortcut → `start_screen_capture` builds one transparent fullscreen `capture-overlay-N` per monitor → each overlay also gets `content_protected(true)` + `apply_privacy_mode_to_webview_window` before `show()`. Selection UI is invisible to recordings.
5. User toggles "Cursor kill switch" → `set_main_window_click_through` → ignore_mouse_events on the panel + ignore_cursor_events on the window + emits `main-window-click-through-changed` so React can also flip the CSS cursor.
6. User toggles app icon → `set_app_icon_visibility` flips the activation policy to `Accessory`.

That layered approach — `NSWindowSharingNone` + NSPanel + non-activating + click-through + hidden cursor + hidden dock — is what the README markets as "complete invisibility." The actual capture exclusion is one Objective‑C `msg_send` and one Tauri config flag, applied to every window in the app.

pluely is a rust based tauri app : 

port guide : 
Here's a one-to-one port of every stealth primitive from Pluely's Tauri stack into Electron. Electron actually exposes most of this natively, so you don't need raw Objective‑C unless you want the `NSPanel` non-activating behavior on older Electron versions.

## Direct mapping table

| Pluely (Tauri / Rust) | Electron equivalent |
|---|---|
| `setSharingType: NSWindowSharingNone` (msg_send) | `win.setContentProtection(true)` |
| `contentProtected: true` (Tauri config) | `win.setContentProtection(true)` (call after create) |
| `transparent: true` + `macOSPrivateApi` | `new BrowserWindow({ transparent: true })` |
| `decorations: false` | `frame: false` |
| `shadow: false` | `hasShadow: false` |
| `skipTaskbar: true` | `skipTaskbar: true` |
| `to_panel()` + `NSWindowStyleMaskNonActivatingPanel` | `type: 'panel'` (Electron 27+) |
| `NSFloatWindowLevel` + `CanJoinAllSpaces` + `FullScreenAuxiliary` | `setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` |
| `NSWindowCollectionBehaviorTransient/IgnoresCycle` | implied by `type: 'panel'`; otherwise needs objc bridge |
| `set_ignore_mouse_events` + `set_accepts_mouse_moved_events` | `win.setIgnoreMouseEvents(true, { forward: true })` |
| `set_activation_policy(Accessory)` | `app.setActivationPolicy('accessory')` (macOS) |
| `WDA_EXCLUDEFROMCAPTURE` (Windows side of contentProtected) | `setContentProtection(true)` handles this on Win 10 2004+ |
| Per-monitor `capture-overlay-N` windows with privacy mode | one `BrowserWindow` per `screen.getAllDisplays()`, each with `setContentProtection(true)` |

## Drop-in main-process module

Create `electron/stealth-window.ts`. This recreates Pluely's `apply_privacy_mode_to_webview_window` plus the panel conversion:

```ts
import { BrowserWindow, app, screen } from 'electron';

export interface StealthWindowOptions {
  width?: number;
  height?: number;
  url: string; // file://… or http://localhost:5173
}

export function createStealthOverlay(opts: StealthWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width ?? 600,
    height: opts.height ?? 54,
    show: false,
    frame: false,             // decorations: false
    transparent: true,        // transparent: true
    hasShadow: false,         // shadow: false
    resizable: false,
    movable: true,
    skipTaskbar: true,        // skipTaskbar: true
    focusable: false,         // mirrors NSWindowStyleMaskNonActivatingPanel intent
    alwaysOnTop: true,
    acceptFirstMouse: true,
    roundedCorners: false,
    // The single most important line — replaces tauri-nspanel's panel conversion
    // on macOS and gives you NSPanel + NSNonactivatingPanelMask semantics.
    // Requires Electron 27+.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  // ===== The two lines that actually hide it from screen capture =====
  // macOS: setSharingType:NSWindowSharingNone
  // Windows: SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
  win.setContentProtection(true);

  // Float over fullscreen apps, every Space, like NSWindowCollectionBehaviorCanJoinAllSpaces
  // + NSWindowCollectionBehaviorFullScreenAuxiliary
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Belt-and-braces: re-apply protection on each show, in case macOS resets it
  // when the panel becomes key (rare, but cheap insurance — Pluely also does this).
  win.on('show', () => win.setContentProtection(true));

  win.loadURL(opts.url);
  return win;
}
```

## Hiding the dock icon (Pluely's `set_app_icon_visibility`)

```ts
// macOS — full equivalent of ActivationPolicy::Accessory
export function setDockVisible(visible: boolean) {
  if (process.platform === 'darwin') {
    app.setActivationPolicy(visible ? 'regular' : 'accessory');
    // Or the older API: visible ? app.dock.show() : app.dock.hide();
  } else {
    // Windows/Linux taskbar visibility is per-window
    BrowserWindow.getAllWindows().forEach(w => w.setSkipTaskbar(!visible));
  }
}
```

Call `setDockVisible(false)` before `app.whenReady()` if you want to launch with no dock icon at all.

## Click-through toggle (Pluely's cursor kill switch)

```ts
export function setClickThrough(win: BrowserWindow, enabled: boolean) {
  // forward: true keeps mouseover events flowing to the renderer so CSS :hover etc. still work
  win.setIgnoreMouseEvents(enabled, { forward: true });
  win.webContents.send('click-through-changed', enabled);
}
```

In the renderer, mirror Pluely's CSS:

```css
html[data-click-through="true"],
html[data-click-through="true"] * { cursor: default !important; }
```

```ts
// preload or renderer
ipcRenderer.on('click-through-changed', (_e, enabled) => {
  document.documentElement.dataset.clickThrough = String(enabled);
});
```

## Per-monitor screenshot selection overlays (Pluely's `capture-overlay-N`)

```ts
export function createCaptureOverlays() {
  const displays = screen.getAllDisplays();
  return displays.map((display, idx) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      closable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      show: false,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    });

    win.setContentProtection(true);                      // <-- the critical bit
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.loadURL(`file://.../capture-overlay.html?monitor=${idx}`);
    win.once('ready-to-show', () => win.show());
    return win;
  });
}
```

Important: in Electron, capture the screenshots first (using `desktopCapturer` or `screen-capturer-rs` or shelling out to `screencapture`) **before** showing your overlay windows, because content-protected windows are also invisible to your own `desktopCapturer` calls. Pluely does the same — `monitor.capture_image()` runs before any overlay is created.

## The fullscreen-coexistence detail

Electron's `type: 'panel'` is the equivalent of Pluely's:

```rust
panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
panel.set_collection_behaviour(
    FullScreenAuxiliary | CanJoinAllSpaces
);
```

If you target Electron < 27 you don't have `type: 'panel'`. Two options:

1. Use `electron-panel-window` (npm) which exposes `setNSPanel(win)` — wraps the same Objective‑C calls Pluely makes via `tauri-nspanel`.
2. Roll your own native module with `NAPI` + `objc` bindings doing exactly what Pluely's `apply_privacy_mode_to_window` does.

For most cases just upgrade to Electron ≥ 27 and use `type: 'panel'`.

## What you do not need to port

- `macOSPrivateApi: true` — Electron's transparent windows don't gate behind it.
- The manual `setCollectionBehavior` `Transient | IgnoresCycle` flags — `type: 'panel'` already excludes the window from Mission Control, Cmd+Tab, and Cmd+\` cycling.
- `cidre` / `objc` / `tauri-nspanel` crates — Electron's high-level APIs cover all of it.

## Verifying it works

After wiring it up, check the same matrix Pluely targets:

- Native screenshot: `Cmd+Shift+3/4` on macOS, `Win+Shift+S` on Windows. Should not capture the window.
- QuickTime screen recording (macOS).
- Zoom/Meet/Teams screen share — share "Entire Screen". Window should be absent.
- OBS / Screen Studio — both modern (SCK / Graphics Capture) and legacy paths respect content protection.
- Your own `desktopCapturer.getSources()` — it should also not see the window, which confirms the kernel-level exclusion is active rather than just a z-order trick.

If a recorder still sees the window, the usual culprits are: forgot to call `setContentProtection` after every `loadURL`/reload, the renderer is HW-accelerated and the OS isn't on a build that supports `WDA_EXCLUDEFROMCAPTURE` (Win 10 2004+ required), or you're on Linux — there is no equivalent on X11/Wayland and Pluely explicitly disables this feature on Linux for the same reason.

## Minimal complete example wiring it all together

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { createStealthOverlay, setClickThrough, setDockVisible } from './stealth-window';

let main: BrowserWindow;

app.whenReady().then(() => {
  setDockVisible(false); // accessory mode from launch

  main = createStealthOverlay({
    url: 'http://localhost:5173',
    width: 600,
    height: 54,
  });
  main.once('ready-to-show', () => main.showInactive()); // showInactive == panel.set_becomes_key_only_if_needed
});

ipcMain.handle('toggle-click-through', (_e, enabled: boolean) => {
  setClickThrough(main, enabled);
});

ipcMain.handle('toggle-dock', (_e, visible: boolean) => {
  setDockVisible(visible);
});
```

That gives you full feature parity with Pluely's invisibility stack: hidden from captures (`setContentProtection`), floats over fullscreen apps without stealing focus (`type: 'panel'` + screen-saver level + all-workspaces), no dock entry (`setActivationPolicy('accessory')`), passes the cursor through on demand (`setIgnoreMouseEvents`), and uses transparent frameless windows so there's nothing visually to catch the eye even if a fragment did leak.