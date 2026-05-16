# Natively Screen Share Stealth Production Plan
### Rust native module · Electron window hardening · staged rollout
**macOS 12+ · Windows 10 2004+ · Electron 28+**

---

## 1  Executive Summary

This document is the single source of truth for the Natively stealth hardening work that can be implemented, verified, and shipped from the current Electron repository. It combines the existing production plan (centralized `StealthManager`, Rust `napi-rs` native module, phased rollout) with a defense-in-depth specification covering the repo-owned layers and feature flags. External native programs that require separate driver, compositor, or kernel delivery are tracked in `stealth-separate-project-blueprint.md` and `electron/stealth/separateProjectContracts.ts`.

The shipping plan is:

- **Phase 1 (ship)** — Layer 0 + Layer 1. Harden the existing multi-window Electron app using a centralized `StealthManager` plus a Rust `napi-rs` native module. Defeats user-space screenshot/screen-share (L1), closes key Chromium-internal capture gaps (L2), and raises the bar against some user-space privileged capture paths without claiming canonical Layer 3.
- **Phase 2 (repo experimental)** — Layer 1B + Layer 5, plus the repo-side control plane for future Layer 2 work. Add feature-gated macOS private API support, capture-detection watchdog behavior, and bounded `CGVirtualDisplay` helper/session orchestration without over-claiming full compositor isolation.
- **External follow-on programs** — Full Layer 2 compositor/driver delivery, Layer 3, and Layer 4 remain separate native programs only if the product truly requires them.

---

## 2  Threat Model

Define what you are defending against before implementing:

| Threat Level | Adversary | Example |
|---|---|---|
| L1 | User-space screenshot / screen-share | Zoom, Teams, OBS, Snipping Tool |
| L2 | Chromium-internal capture | Chrome tab share, Google Meet, WebRTC apps |
| L3 | User-space privileged capture | BitBlt, PrintWindow, DXGI Desktop Duplication |
| L4 | Kernel-mode signed driver capture | ExamSoft, Proctorio kernel agents, DLP software |

Each layer below addresses **cumulative** threat levels.

---

## 3  Support Matrix

| Capture scenario | macOS ship target | Windows ship target | Threat Level | Notes |
|---|---|---|---|---|
| Window picker / window share | Strong | Strong | L1 | Primary Phase 1 goal |
| App-level capture by window enumeration | Strong | Moderate to strong | L1–L2 | Depends on app capture path |
| Screenshot APIs / legacy window imaging | Strong | Strong | L1–L3 | Via native window exclusion + Electron content protection |
| Chromium-internal / WebRTC capture | Strong | Strong | L2 | Direct NSWindowSharingNone / WDA bypass closure |
| Full screen / desktop share | Experimental | Best-effort only | L3–L4 | Windows requires OSR or deeper interception for high confidence |
| Mission Control / Exposé / task switching | Strong | Strong for auxiliary windows | L1 | Product behavior must remain usable |
| Kernel-mode signed driver capture | N/A | Deferred | L4 | Requires Layer 3/4 (separate project) |

Use this matrix in release notes and internal QA. Do not market beyond it.

---

## 4  Protection Layers

### Layer 0 — Electron Baseline (Defeats L1)

Apply to every `BrowserWindow` instance unconditionally.

```js
// main.js
const win = new BrowserWindow({
  show: false,
  webPreferences: { contextIsolation: true }
});

win.setContentProtection(true); // MUST be before show()
win.show();
```

**Rules:**

- Call `setContentProtection(true)` **before** `win.show()` to prevent any capture window between creation and protection activation
- Apply to **all** windows, including secondary/child windows — one unprotected window breaks the entire stealth surface
- On Windows 10 build 19041+: maps to `WDA_EXCLUDEFROMCAPTURE` → window is transparent in captures
- On Windows < 19041: maps to `WDA_MONITOR` → window shows as a black rectangle (not transparent)
- On macOS: maps to `NSWindowSharingNone` via WindowServer

---

### Layer 1 — Direct Native API Enforcement (Defeats L1 + L2; raises the bar for some user-space privileged capture)

Do not rely solely on Electron's wrapper. Call OS APIs directly from a native Node addon (`napi-rs` / Rust).

#### Windows — Force `WDA_EXCLUDEFROMCAPTURE`

```js
const ffi = require('ffi-napi');
const ref = require('ref-napi');

const user32 = ffi.Library('user32', {
  SetWindowDisplayAffinity: ['bool', ['uint32', 'uint32']]
});

const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const hwnd = win.getNativeWindowHandle().readUInt32LE(0);
user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
```

Call this:

- After `win.show()`
- After every `win.restore()` or `win.unminimize()` event (Windows can reset affinity on window state changes)
- After moving the window between monitors

#### macOS — Reinforce via Objective-C / Rust Native Addon

```objc
// native_addon.mm (or equivalent Rust with objc2 crate)
#import <Cocoa/Cocoa.h>

// Get NSWindow from Electron handle and enforce sharing type
NSWindow* nsWin = /* derived from napi buffer holding NSView* ptr */;
[nsWin setSharingType:NSWindowSharingNone];
[nsWin.contentView setWantsLayer:YES];
// Optionally suppress layer filters that leak compositing hints
nsWin.contentView.layer.filters = nil;
```

This closes the Chromium WebRTC bypass where `ScreenCaptureKit` / Chrome's internal capturer ignores Electron's wrapper but respects the direct `NSWindowSharingNone` set on the `NSWindow` object.

**Phase 2 experimental addition:** `CGSSetWindowSharingState(..., kCGSDoNotShare)` via `dlsym`, gated behind `enablePrivateMacosStealthApi` flag.

---

### Layer 2 — Virtual Display Isolation (Defeats L1 + L2 + L3; hardens against L4)

Render sensitive content on a virtual display that is architecturally separate from the primary display capture path.

#### Windows — Indirect Display Driver (IDD / IddCx)

- Implement or integrate a UMDF2 driver using Microsoft's IddCx model
- Creates a fully registered virtual monitor in the WDDM display stack
- Electron renders the sensitive window to this virtual display
- A compositor process copies the virtual framebuffer to a real-monitor overlay
- Proctoring tools capturing Display 1 (physical) do not see Display 2 (virtual IDD) unless they explicitly enumerate all displays

> [!NOTE]
> References: [Microsoft Docs — Indirect Display Driver Model Overview](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview); Parsec Virtual Display is a working production example.

#### macOS — `CGVirtualDisplay` (macOS 12.4+)

```swift
// Swift layer called from native addon
import CoreDisplay
let desc = CGVirtualDisplayDescriptor()
desc.name = "InternalDisplay"
desc.sizeInMillimeters = CGSize(width: 300, height: 200)
let display = CGVirtualDisplay(descriptor: desc)
// Set Electron window's screen to this display
```

In the separate-program design, `CGVirtualDisplay` is only the prerequisite isolated display/control plane. Full protection depends on a native secure presenter plus compositor handoff; the main repo intentionally does not claim that this outcome is already delivered.

> [!IMPORTANT]
> Layer 2 is Phase 2 scope. Only implement after Phase 1 is stable and if L4 threat is confirmed.

---

### Layer 3 — Hardware-Protected GPU Surfaces (Defeats L1–L4)

This is the same mechanism used by Widevine L1 / HDCP / Blu-ray DRM. Content is composited at the GPU hardware overlay plane, below DWM. DXGI Desktop Duplication cannot capture hardware-protected surfaces because by the time the API reads the frame, the protected pixels have already been replaced by black/empty at the hardware scanout stage.

Current concrete implementation guidance is Windows-first. Any macOS Layer 3 claim requires a separate feasibility program to determine whether a canonical hardware-protected GPU presentation path exists at all; do not assume parity with Windows.

#### Windows — D3D11 Protected Swap Chain (via Native Addon)

```cpp
// Create device with content protection support
UINT createFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                  createFlags, featureLevels, ...);

// Create hardware-protected swap chain
DXGI_SWAP_CHAIN_DESC1 scDesc = {};
scDesc.Width  = width;
scDesc.Height = height;
scDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
scDesc.Flags  = DXGI_SWAP_CHAIN_FLAG_HW_PROTECTED; // <-- key flag

// Protected texture for sensitive content
D3D11_TEXTURE2D_DESC texDesc = {};
texDesc.MiscFlags = D3D11_RESOURCE_MISC_HW_PROTECTED; // <-- key flag
```

**Constraints:**

- Requires GPU driver support for protected content (DirectX 11.1+, most discrete + integrated GPUs on Win10+)
- Must be running as an HWND-backed D3D surface, not a pure software renderer
- In Electron: requires an offscreen rendering mode that feeds into a D3D11 swap chain via a native addon — non-trivial but achievable

#### macOS — Feasibility Gate

- Keep the canonical Layer 3 meaning the same: hardware-protected GPU surfaces.
- No supported macOS primitive is currently approved in this repo as satisfying that definition.
- A separate macOS program may attempt to prove a valid hardware-protected presentation path exists; if it cannot, macOS must no-go instead of shipping a weaker Layer 3 claim under the same name.

> [!CAUTION]
> Layer 3 is Phase 3 scope (separate project). Do not mix into the main implementation plan.

---

### Layer 4 — Kernel-Mode Driver (Defeats L4 symmetrically — Nuclear Option)

Only warranted if you are building a security product that must defend against other signed kernel-mode adversaries.

#### Windows

- Write a WDDM-compatible kernel driver using `dxgkrnl.sys` documented extension points
- Hook DWM composition at the `D3DKMTSubmitCommand` / `DxgkDdiPresentMultiPlaneOverlay` level to enforce surface exclusion below the affinity flag path
- **Requirements:**
  - EV code signing certificate + Microsoft attestation signing (WHQL or KMCS portal)
  - Unsigned kernel drivers are blocked by default on all modern Windows (Secure Boot + Driver Signing Enforcement)
  - PatchGuard (KPP) prohibits SSDT patching; all hooks must use documented kernel extension interfaces

#### macOS

- Implement a DriverKit (DEXT) extension — Apple's modern kernel-adjacent framework that does not require disabling SIP
- System Integrity Protection (SIP) + Mandatory Access Control make macOS dramatically harder for adversaries at this tier — most proctoring software on Mac is purely user-space

> [!WARNING]
> Layer 4 is the "nuclear option." Only pursue if building a dedicated security product versus L4 adversaries. Requires significant compliance, signing, and driver certification work.

---

### Layer 5 — Capture Detection Watchdog (Defense in Depth)

Complement all hardware/OS protections with a software watchdog. This is part of Phase 2.

```js
// In main process — poll for capture sessions
const { desktopCapturer, powerMonitor } = require('electron');

setInterval(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  const suspicious = sources.some(s => isCaptureToolProcess(s.name));
  if (suspicious) {
    sensitiveWindows.forEach(w => w.hide()); // Pull content immediately
    setTimeout(() => sensitiveWindows.forEach(w => w.show()), 500);
  }
}, 1000);

// Also guard against lock/sleep events where state may reset
powerMonitor.on('unlock-screen', () => reapplyAllProtections());
powerMonitor.on('resume', () => reapplyAllProtections());
```

**Watchdog responsibilities:**

- Poll `desktopCapturer.getSources()` at 1s intervals for known capture tool process names
- On detection: immediately hide all sensitive windows, then re-show after brief delay
- Re-apply all protections on `unlock-screen` and `resume` events
- Log all detections for telemetry / supportability

---

## 5  What Changes From The Old Draft

### 5.1  Corrections

- `WDA_EXCLUDEFROMCAPTURE` is valuable, but it is **not** a universal answer for Windows desktop capture.
- `DWMWA_CLOAK` is **not** safe as a default on visible primary windows; it can hide the window from the compositor and break UX.
- "Process disguise", tray hiding, and similar behavior are separate product decisions, not core screen-capture controls.
- `native-module/index.js` and `native-module/index.d.ts` are auto-generated by `napi-rs`; they should be regenerated, not hand-edited.
- Private macOS APIs (`CGSSetWindowSharingState`) carry notarization, review, and compatibility risk and must be optional.

### 5.2  Production Goals

- Make the current launcher, overlay, settings, and model selector windows consistently apply the strongest safe capture protections available on each platform.
- Centralize all stealth lifecycle logic so show/hide/focus transitions do not drift across helpers.
- Ship a measurable, testable baseline first.
- Separate GA-safe behavior from experimental behavior.

### 5.3  Non-Goals For This Plan

- No promise of total invisibility from Windows full-monitor capture (without Layer 3/4).
- No DLL injection, API hooking, or EDR-sensitive behavior in the shipping path.
- No off-screen rendering rewrite in Phase 1.
- No App Store distribution promise for the private macOS API path.
- No Windows IDD driver, hardware-protected swap-chain host, kernel-mode driver, or full macOS compositor handoff inside this implementation plan; those are tracked separately.

---

## 6  Chosen Architecture

### 6.1  Shipping Architecture

Keep the existing multi-window design:

- `electron/WindowHelper.ts` manages launcher + overlay.
- `electron/SettingsWindowHelper.ts` manages the settings popover.
- `electron/ModelSelectorWindowHelper.ts` manages the model selector popover.
- `electron/stealth/StealthManager.ts` becomes the single orchestration layer.
- `native-module/src/stealth.rs` adds platform-native APIs exposed through `napi-rs`.

### 6.2  Protection Layers By Platform

**macOS**

- Layer 0 — `BrowserWindow.setContentProtection(true)` as the Electron fallback.
- Layer 1A — `NSWindowSharingNone` on the backing `NSWindow`.
- Layer 1B — optional `CGSSetWindowSharingState(..., kCGSDoNotShare)` behind a feature flag (Phase 2).
- Layer 2 repo boundary — feature-gated `CGVirtualDisplay` helper discovery, session orchestration, and opted-in backing-surface routing for a future compositor path.
- Layer 5 — Capture-detection watchdog (Phase 2).
- UI hardening — `setHiddenInMissionControl(true)` and `setExcludedFromShownWindowsMenu(true)` where supported.

**Windows**

- Layer 0 — `BrowserWindow.setContentProtection(true)` as the fallback.
- Layer 1 — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on supported builds, re-applied on restore/unminimize/monitor-change.
- Layer 2 separate-program boundary — IDD virtual display driver work is tracked outside this implementation plan.
- Layer 5 — Capture-detection watchdog (Phase 2).
- UI hardening — `setSkipTaskbar(true)` for auxiliary windows; optional native extended style updates for dropdown-style windows.
- Deferred — do **not** use `DWMWA_CLOAK` by default on launcher or overlay windows.

### 6.3  Why This Architecture Wins

- It fits the current codebase and build system.
- It gives immediate value without renderer rewrites.
- It keeps risky or platform-fragile behavior behind flags.
- It creates a clean seam for later Layer 3/4 implementation if product requirements justify it.
- Defense in depth: multiple independent layers so a single bypass does not defeat the entire system.

---

## 7  Implementation Plan

### 7.1  Phase 1 — Layer 0 + Layer 1 (shipping scope, defeats L1-L2 and hardens selected user-space privileged capture paths)

#### A. Add a new native stealth module

Create `native-module/src/stealth.rs` with two platform sections:

- **macOS exports**
  - `apply_macos_window_stealth(window_number: u32)`
  - `remove_macos_window_stealth(window_number: u32)`
- **Windows exports**
  - `apply_windows_window_stealth(hwnd_buffer: Buffer)`
  - `remove_windows_window_stealth(hwnd_buffer: Buffer)`

Implementation requirements:

- Return `napi::Result<()>`; never panic across the FFI boundary.
- Log degraded behavior, but keep fallback protection active.
- Keep calls idempotent so repeated show/hide cycles are safe.
- Prefer typed platform crates already in use (`windows` on Windows, existing macOS stack plus `libc` for `dlsym`) over ad-hoc unsafe glue where practical.

#### B. Wire the module into the native crate

Update `native-module/src/lib.rs`:

- add `pub mod stealth;`
- re-export the new napi functions through the module as usual

Update `native-module/Cargo.toml`:

- add `libc = "0.2"`
- add any additional macOS framework or crate dependencies only if the implementation truly needs them

#### C. Regenerate JS bindings instead of editing generated files

After adding `#[napi]` exports, regenerate:

- `native-module/index.js`
- `native-module/index.d.ts`

Do not maintain manual diffs in generated files.

#### D. Rewrite `StealthManager`

Replace the current lightweight `electron/stealth/StealthManager.ts` with a real orchestrator that:

- loads the native module once
- exposes `applyToWindow(win, enable, options?)`
- exposes `reapplyAfterShow(win)`
- tracks per-window state with `WeakMap`/`WeakSet`
- always applies Layer 0 (Electron fallback) protection first
- attempts Layer 1 (native) protection second
- records whether the window is `primary` or `auxiliary`

Required behavior split:

- **Primary windows** (`launcher`, `overlay`): use safe capture protections only; do not apply cloaking-style behavior.
- **Auxiliary windows** (`settings`, `model-selector`): may also hide from task switching and window menus aggressively.

**Critical Layer 0 rule:** `setContentProtection(true)` must be called **before** `win.show()` on every window. The `StealthManager` must enforce this ordering.

#### E. Layer 1 re-application hooks

The `StealthManager` must re-apply Layer 1 protections on the following events (protections can be reset by OS state changes):

- `win.restore()` / `win.unminimize()`
- Monitor change (window moved between displays)
- `powerMonitor.on('unlock-screen')`
- `powerMonitor.on('resume')`

#### F. Move all window helpers onto the shared manager

Update:

- `electron/WindowHelper.ts`
- `electron/SettingsWindowHelper.ts`
- `electron/ModelSelectorWindowHelper.ts`

Each helper should:

- stop duplicating stealth logic inline
- delegate to `StealthManager.applyToWindow(...)`
- call `StealthManager.reapplyAfterShow(...)` after the Windows opacity shield path finishes
- keep helper-specific UX behavior local (focus, positioning, blur handling)

#### G. Simplify main-process ownership

In `electron/main.ts`:

- remove the old one-shot `new StealthManager({ enabled })` flow
- keep `setContentProtection(state)` as the external toggle surface for existing helpers if that reduces churn
- ensure toggling undetectable mode fans out through the helpers, which then route into the centralized manager

### 7.2  Phase 2 — Layer 2 + Layer 5 (experimental, does not by itself claim L4 resistance)

Add deeper protections only after Phase 1 is stable.

#### A. Experimental macOS hardening (Layer 1B)

- Gate behind a dedicated runtime flag: `enablePrivateMacosStealthApi`
- Only enable in non-App-Store builds
- Log whether CGS was applied, unavailable, or rejected
- Keep `NSWindowSharingNone` as the baseline even when CGS is disabled

#### B. Repo-Side macOS Virtual Display Control Plane (Layer 2 boundary)

- Requires macOS 12.4+
- Feature-flagged: `enableVirtualDisplayIsolation`
- Resolve the helper binary, establish the client/coordinator path, and request/release helper sessions
- Apply virtual-display routing only to opted-in backing surfaces, never to the visible shell window
- Retry display moves with bounded retries and release helper sessions on disable/close/failure paths
- Gracefully degrade when the helper is unavailable, non-ready, or the display never appears

#### C. Capture Detection Watchdog (Layer 5)

- Poll `desktopCapturer.getSources()` at 1-second intervals
- Maintain a configurable list of known capture tool process names
- On detection: immediately hide all sensitive windows
- Re-show after 500ms delay
- Wire `powerMonitor` listeners (`unlock-screen`, `resume`) to re-apply all protections
- Feature-flagged: `enableCaptureDetectionWatchdog`

### 7.3  External Follow-On Programs (tracked separately, not part of this plan)

If product requires high-confidence isolation beyond the main Electron repo boundary, stop extending this plan and execute the separate blueprint instead.

- Full macOS Layer 2 compositor handoff that keeps sensitive content usable on the physical display
- Windows IDD virtual display driver + compositor service
- Windows Layer 3 protected render host (`DXGI_SWAP_CHAIN_FLAG_HW_PROTECTED` / protected textures)
- Layer 4 kernel-adjacent delivery work

These are tracked in `stealth-separate-project-blueprint.md` and `electron/stealth/separateProjectContracts.ts`, not as open checklist items in this document.

---

## 8  File-by-File Worklist

### 8.1  `native-module/src/stealth.rs` (new)

Deliverables:

- platform-specific apply/remove functions
- defensive logging
- idempotent behavior
- no assumptions that window lookups always succeed

macOS specifics:

- resolve the target `NSWindow` by window number
- set `NSWindowSharingNone`
- set collection behavior for Mission Control suppression when appropriate
- optionally resolve `CGSMainConnectionID` and `CGSSetWindowSharingState` via `dlsym`

Windows specifics:

- read `HWND` from Electron's native handle buffer
- call `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
- re-apply on restore/unminimize/monitor-change events
- optionally adjust extended styles for auxiliary windows only if needed
- skip `DWMWA_CLOAK` in the default path

### 8.2  `native-module/src/lib.rs`

- add `pub mod stealth;`
- keep exports organized with the rest of the crate

### 8.3  `native-module/Cargo.toml`

- add only the minimum new dependencies
- document any target-specific additions inline if they are non-obvious

### 8.4  `native-module/index.js` and `native-module/index.d.ts`

- regenerate from `napi-rs`
- verify the new exports appear on both JS and DTS surfaces

### 8.5  `electron/stealth/StealthManager.ts`

New responsibilities:

- native module loading
- per-window stealth state tracking
- platform branching
- lifecycle-safe reapply hooks (restore, unminimize, monitor-change, unlock, resume)
- Layer 0 ordering enforcement (`setContentProtection` before `show`)
- structured logging for supportability
- capture detection watchdog (Phase 2)

### 8.6  `electron/WindowHelper.ts`

- replace inline `applyStealthFlags()` implementation with manager calls
- keep launcher vs overlay differences explicit
- call reapply after the Windows show-opacity transition

### 8.7  `electron/SettingsWindowHelper.ts`

- remove duplicate platform conditionals
- delegate to manager
- preserve popover focus/blur behavior

### 8.8  `electron/ModelSelectorWindowHelper.ts`

- same changes as settings helper
- ensure auxiliary-window rules remain consistent

### 8.9  `electron/main.ts`

- remove stale constructor-era stealth setup
- ensure runtime toggles remain the source of truth
- keep startup logs clear about enabled level: fallback-only, native baseline, or experimental macOS CGS

### 8.10  `electron/tests/stealthManager.test.ts`

Expand the test surface to cover:

- disabled mode no-op behavior
- fallback-only path when native module load fails
- primary vs auxiliary window behavior
- reapply-after-show idempotency
- re-application on restore/unminimize/monitor-change events
- capture detection watchdog (Phase 2)
- platform capability reporting if that API remains

Add focused helper tests if needed rather than making this file huge.

---

## 9  Sequencing

Implement in this order:

1. Add native Rust exports (Layer 1).
2. Regenerate napi bindings.
3. Rewrite `StealthManager` to consume the native module with Layer 0 + Layer 1 enforcement.
4. Migrate `WindowHelper`, `SettingsWindowHelper`, and `ModelSelectorWindowHelper`.
5. Add re-application hooks for restore/unminimize/monitor-change/unlock/resume.
6. Remove obsolete startup wiring from `electron/main.ts`.
7. Add unit tests.
8. Run manual capture verification.
9. Gate private macOS API behind a feature flag (Phase 2 — Layer 1B).
10. Implement capture-detection watchdog (Phase 2 — Layer 5).
11. Integrate the repo-side macOS virtual-display control plane (Phase 2 — Layer 2 boundary).

This order keeps the app runnable after each step and makes rollback simple.

---

## 10  Verification Plan

### 10.1  Automated Checks

Run at minimum:

```bash
cd native-module && cargo check
cd native-module && cargo test
npm test -- stealthManager
```

If the repo has a broader Electron test command, include it before merging.

### 10.2  Manual macOS Matrix

With stealth off:

1. launcher visible in regular screenshots and screen share
2. overlay visible in regular screenshots and screen share

With Phase 1 stealth on (Layer 0 + Layer 1):

1. QuickTime screen recording does not show protected windows, or shows a protected rectangle
2. common window picker flows do not list protected auxiliary windows
3. Mission Control does not surface protected auxiliary windows
4. the app remains usable during rapid show/hide of launcher, overlay, settings, and model selector
5. Chromium-internal capture (Chrome tab share, Google Meet) does not show protected content

With Phase 2 flags on (Layer 1B + Layer 5 + repo-side Layer 2 control plane):

1. repeat the same matrix
2. verify no startup crash when CGS symbols or the virtual-display helper are unavailable
3. verify the helper session create/release path succeeds without moving the visible shell window
4. verify notarized builds still launch cleanly in the intended distribution channel
5. verify capture-detection watchdog hides windows when capture tool is detected
6. verify windows re-appear after capture tool stops

### 10.3  Manual Windows Matrix

With stealth off:

1. launcher and overlay appear normally in screen share and screenshot flows

With Phase 1 stealth on (Layer 0 + Layer 1):

1. window/share picker coverage improves as expected
2. settings and model selector stay hidden from taskbar / switching surfaces as intended
3. launcher and overlay remain visible to the local user
4. no flashing or stuck-transparent windows occur during show/hide transitions
5. protections survive restore/unminimize/monitor-change cycles

With Phase 2 flags on (Layer 5):

1. verify capture-detection watchdog behavior

Document full-desktop-share results separately as **best-effort**, not pass/fail for GA.

### 10.4  Regression Checks

- rapid toggle of undetectable mode 10x in succession
- open/close settings and model selector repeatedly
- switch launcher <-> overlay repeatedly on both platforms
- secondary monitor placement
- sleep / wake and app relaunch (verify re-application)
- native module missing or unloadable (graceful fallback to Layer 0)

---

## 11  Implementation Checklist

```
[x] setContentProtection(true) before win.show() on ALL windows (Layer 0)
[x] Direct WDA_EXCLUDEFROMCAPTURE via napi-rs on Windows (Layer 1)
[x] Re-apply affinity on restore/unminimize/monitor-change events (Layer 1)
[x] Native Rust addon enforcing NSWindowSharingNone on macOS (Layer 1)
[x] powerMonitor listeners to re-apply protections after sleep/resume (Layer 1)
[x] All child/secondary BrowserWindows also protected — no leaking window (Layer 0+1)
[x] Private macOS CGS API behind feature flag (Layer 1B — Phase 2)
[x] Capture-detection watchdog polling desktopCapturer.getSources() (Layer 5 — Phase 2)
[x] Repo-side macOS virtual-display helper discovery/session orchestration is feature-flagged, bounded, and limited to opted-in backing surfaces (Layer 2 boundary)
[x] External Layer 2/3/4 native programs are moved to the separate-project blueprint instead of remaining open items in this plan
```

### 11.1  Repository Audit Status (rescoped main-repo boundary)

The table below reflects the current repository state against the rescoped main-repo checklist above. Full macOS compositor delivery, Windows IDD, Layer 3, and Layer 4 are intentionally tracked in the separate blueprint and are no longer counted as open items in this document.

| Checklist item | Status | Evidence | Notes |
|---|---|---|---|
| `setContentProtection(true)` before `win.show()` on all windows (Layer 0) | Done | `electron/stealth/StealthManager.ts`, `electron/WindowHelper.ts`, `electron/SettingsWindowHelper.ts`, `electron/ModelSelectorWindowHelper.ts` | All current `BrowserWindow` creation paths route through `StealthManager.applyToWindow(...)` before visible show flows. |
| Direct `WDA_EXCLUDEFROMCAPTURE` via `napi-rs` on Windows (Layer 1) | Done | `native-module/src/stealth.rs` | `apply_windows_window_stealth` calls `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` with `WDA_MONITOR` fallback. |
| Re-apply affinity on restore/unminimize/monitor-change events (Layer 1) | Done | `electron/stealth/StealthManager.ts`, `electron/tests/stealthManager.test.ts` | Restore/unminimize/show/move reapply hooks exist and Windows display metrics changes trigger managed-window reapply. |
| Native Rust addon enforcing `NSWindowSharingNone` on macOS (Layer 1) | Done | `native-module/src/stealth.rs` | Native macOS path resolves `NSWindow` by window number and applies `setSharingType: 0`. |
| `powerMonitor` listeners re-apply protections after sleep/resume (Layer 1) | Done | `electron/stealth/StealthManager.ts` | `unlock-screen` and `resume` listeners are bound and reapply protections to managed windows. |
| All child/secondary `BrowserWindow`s also protected (Layer 0+1) | Done | `electron/WindowHelper.ts`, `electron/SettingsWindowHelper.ts`, `electron/ModelSelectorWindowHelper.ts`, `electron/stealth/StealthRuntime.ts` | Launcher, overlay, settings, model selector, and the `StealthRuntime` shell/content pair all route through the shared manager. |
| Private macOS CGS API behind feature flag (Layer 1B — Phase 2) | Done | `electron/main.ts`, `electron/stealth/StealthManager.ts`, `native-module/src/stealth.rs` | CGS calls are gated by `enablePrivateMacosStealthApi` and disabled for MAS builds. |
| Capture-detection watchdog polling `desktopCapturer.getSources()` (Layer 5 — Phase 2) | Done | `electron/stealth/StealthManager.ts` | Feature-flagged watchdog polls sources, hides visible windows, restores them, and reapplies stealth. |
| Repo-side macOS virtual-display helper discovery/session orchestration is feature-flagged, bounded, and limited to opted-in backing surfaces (Layer 2 boundary) | Done | `electron/main.ts`, `electron/stealth/MacosVirtualDisplayClient.ts`, `electron/stealth/macosVirtualDisplayIntegration.ts`, `electron/stealth/StealthManager.ts`, `stealth-projects/macos-virtual-display-helper/Sources/CGVirtualDisplayBackend.swift`, `electron/tests/stealthManager.test.ts` | Helper resolution, client/coordinator plumbing, bounded retry/release behavior, and opted-in backing-surface routing are implemented and verified. |
| External Layer 2/3/4 native programs are transferred to the separate-project blueprint instead of remaining open items in this plan | Done | `stealth-separate-project-blueprint.md`, `electron/stealth/separateProjectContracts.ts` | Full compositor/driver/kernel delivery now lives behind an explicit separate-project boundary rather than as open checklist gaps in this document. |

### 11.2  Strict Audit Summary

- **Done:** 10
- **Open in this plan:** 0
- **External native programs tracked separately:** yes

---

## 12  Release Gates

Phase 1 is ready to merge only when:

- native module builds on supported macOS and Windows targets
- the Electron app still works when the native module fails to load (Layer 0 fallback)
- helper windows no longer duplicate stealth logic
- `setContentProtection` is verified to be called before `show()` on all windows
- re-application hooks survive restore/unminimize/monitor-change/sleep/wake
- manual QA confirms no visible regressions in focus, opacity, or positioning
- documentation and logs no longer overstate Windows full-desktop coverage

Phase 2 is ready only when:

- the private macOS path is feature-flagged
- the repo-side virtual-display control plane is feature-flagged
- capture-detection watchdog is feature-flagged
- distribution owners sign off on the compatibility risk
- QA verifies graceful degradation when APIs are unavailable

---

## 13  Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Native module load failure | Loss of deep protection (Layer 1+) | Keep `setContentProtection(true)` as the Layer 0 baseline fallback |
| macOS private API drift | Experimental path breaks after OS updates | Gate it, log it, and keep Layer 1 baseline independent |
| Windows show/hide race | Transparent or flashing windows | Keep the existing opacity shield and reapply after show |
| Windows affinity reset on state change | Protection silently lost | Re-apply on restore/unminimize/monitor-change/unlock/resume |
| Over-aggressive window hiding | UX regressions | Treat primary and auxiliary windows differently |
| Repo-side virtual-display/control-plane complexity | Helper compatibility drift or session lifecycle bugs | Keep it feature-flagged, bounded, and separate from the external compositor/driver blueprint |
| Hardware-protected swap chain GPU compat | Not all GPUs support protected content | Phase 3 only, requires GPU capability detection |
| Kernel-mode driver certification | Long lead time, high compliance bar | Phase 3 only, separate project, only if product demands it |
| Misleading product claims | Support and trust issues | Use the support matrix in docs and QA sign-off |

---

## 14  Decision Log

- **Adopt now (Phase 1):** Layer 0 + Layer 1. Rust native module + centralized Electron orchestration with re-application hooks.
- **Adopt carefully (Phase 2):** Layer 1B (macOS CGS), Layer 5 (capture watchdog), and the repo-side Layer 2 control plane — all behind feature flags.
- **Reject for Phase 1/2:** default `DWMWA_CLOAK` on visible windows.
- **Move to separate blueprint:** full macOS compositor handoff, Windows IDD driver/compositor work, Layer 3 (D3D11 hardware-protected swap chain), and Layer 4 (kernel-mode driver).

---

## Appendix A  Minimum Versions

| Component | Minimum Version | Notes |
|---|---|---|
| Electron | 28+ | Matches current app assumptions |
| Node.js | 18 LTS+ | Stable Electron baseline |
| Rust | 1.70+ | Compatible with current native module toolchain |
| macOS | 12+ | Required for current target support |
| macOS (Layer 2) | 12.4+ | `CGVirtualDisplay` API availability |
| Windows | 10 build 19041+ | `WDA_EXCLUDEFROMCAPTURE` support |
| Windows (Layer 3) | 10+ with DirectX 11.1 | Hardware-protected swap chain support |
| napi-rs CLI | current repo version | Needed for binding regeneration |

---

*END OF DOCUMENT*
