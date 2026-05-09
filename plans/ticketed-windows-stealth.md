# Windows 11 Bulletproof Stealth — Ticketed Implementation Plan

> **Goal**: Achieve 100% "blur-proof" stealth on Windows 11 by preventing the OS from activating the overlay window, while intercepting global inputs natively and forwarding them to the frontend via IPC.
>
> **Audience**: agentic workers. Each ticket is self-contained and executable end-to-end.
>
> **Source**: Windows focus-stealing issues causing `blur` events in the browser when interacting with the Electron overlay.

---

## 0. Conventions

### 0.1 Ticket envelope

Every ticket follows this shape:
- **ID & Title**
- **Severity** (P0 = correctness, P1 = significant UX/Stealth, P2 = optimization/polish)
- **Subsystem** (electron / native / frontend)
- **Problem** — root cause with context
- **Why it matters** — stealth/accuracy impact
- **Proposed change** — numbered, deterministic steps
- **Edge cases**
- **Race conditions / concurrency**
- **Regression risks**
- **Feature flag** (when applicable)
- **Test plan** — existing tests to keep green + new tests to add
- **Rollback** — exact reversal steps
- **Acceptance criteria** — binary pass/fail

### 0.2 Safety rails (NON-NEGOTIABLE)

1. **No macOS regressions.** Existing stealth layers for macOS (`NSPanel`, `CGSSetWindowSharingState`) must remain untouched.
2. **Graceful Hook Unloading.** Low-Level hooks must be unregistered safely if the app crashes or shuts down. Do not leave ghost hooks in the OS.
3. **No performance degradation.** Hook callbacks must be entirely non-blocking to prevent Windows from dropping the hook due to timeout.
4. **All existing tests MUST continue to pass.**

---

## 1. Sprint A — Core Invisibility (1 Week)

### TWS-001 — Electron: apply WS_EX_NOACTIVATE via focusable config
- **Severity**: P0
- **Subsystem**: electron / window-management
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem
On Windows, clicking the overlay steals active foreground focus from the browser, triggering a `blur` event that proctoring software logs. 

#### Why it matters
- **Stealth impact**: High. A `blur` event is a primary heuristic for detecting cheating.

#### Proposed change
1. Update `electron/WindowHelper.ts` to set `focusable: false` inside `overlaySettings` explicitly for `process.platform === 'win32'`.
2. Remove any explicit `this.overlayWindow!.focus()` calls for Windows. 
3. (Optional) If Electron's `focusable: false` is insufficient, inject `WS_EX_NOACTIVATE` via `SetWindowLongPtr` in the existing `applyWindowsWindowStealth` function inside the rust native addon.

#### Edge cases
- If the user explicitly tries to click a text field, it will not natively receive focus. (Addressed in TWS-004).

#### Regression risks
- The window may completely ignore all interactions. This is intended, but breaks current UX until TWS-002 is merged.
- **Mitigation**: Hide behind `enableWindowsHooks` feature flag.

#### Test plan
- Add unit tests validating that `focusable` is set to `false` when on `win32`.

#### Rollback
1. Revert `focusable: false`.
2. Restore `focus()` calls.

#### Acceptance criteria
- [ ] Windows overlay window is created with `focusable: false`.
- [ ] Clicking the overlay while a browser is open does NOT trigger a `blur` event in the browser.

---

### TWS-002 — Native: Low-Level Keyboard & Mouse Hooks (Rust)
- **Severity**: P0
- **Subsystem**: native / rust
- **Owner**: agentic_worker
- **Order**: depends on TWS-001

#### Problem
Because the overlay cannot be focused (TWS-001), users cannot type into it natively.

#### Why it matters
- **UX impact**: The user cannot ask the AI questions. 

#### Proposed change
1. In `electron/stealth/windowsNativeBindings.rs` (or equivalent Rust module), implement `install_keyboard_hook()` using `SetWindowsHookExW` with `WH_KEYBOARD_LL`.
2. Implement `install_mouse_hook()` using `WH_MOUSE_LL`.
3. Create a thread-safe callback queue to send intercepted `WM_KEYDOWN` and `WM_LBUTTONDOWN` events back to the Node layer.
4. If the overlay is visible and the mouse is inside the overlay bounds, the hook MUST return `1` to swallow the event. Otherwise, return `CallNextHookEx`.

#### Edge cases
- **App Crash**: If the Node process exits unexpectedly, the hook must be unloaded. Ensure a panic handler or `Drop` implementation calls `UnhookWindowsHookEx`.

#### Race conditions / concurrency
- The hook runs on a background OS thread. IPC dispatch to Node must use a thread-safe channel (e.g., `napi_threadsafe_function`).

#### Regression risks
- System-wide keyboard lag if the hook handler is too slow.
- **Mitigation**: The hook callback must only perform bounds-checking and fast memory dispatch. Do not perform IPC blocking inside the hook.

#### Test plan
- Add native unit tests for hooking and unhooking.

#### Rollback
1. Remove hook compilation flags from `binding.gyp` / `Cargo.toml`.
2. Remove hook invocation from `StealthManager.ts`.

#### Acceptance criteria
- [ ] Hook intercepts keystrokes successfully.
- [ ] Keys pressed while mouse is over the overlay are NOT passed to the underlying browser.

---

## 2. Sprint B — Interaction Synthesis (1 Week)

### TWS-003 — Electron: IPC routing for swallowed inputs
- **Severity**: P0
- **Subsystem**: electron / ipc
- **Owner**: agentic_worker
- **Order**: depends on TWS-002

#### Problem
The native module captures the inputs, but the React frontend needs to receive them.

#### Proposed change
1. Update `StealthManager.ts` to register the hook callbacks.
2. When a keystroke is received from the native layer, format it into a standardized payload `{ key: string, keyCode: number, modifiers: string[] }`.
3. Broadcast the payload to the overlay renderer using `webContents.send('injected-keystroke', payload)`.

#### Acceptance criteria
- [ ] `console.log` in the renderer successfully prints intercepted keystrokes.

---

### TWS-004 — Frontend: Synthetic input components
- **Severity**: P1
- **Subsystem**: frontend / react
- **Owner**: agentic_worker
- **Order**: depends on TWS-003

#### Problem
React `onChange` events on `<input>` elements do not fire if the element isn't focused natively.

#### Proposed change
1. Create a `SyntheticInput.tsx` React component.
2. Use `useEffect` to listen to the `injected-keystroke` IPC channel.
3. Manually construct the input string by appending printable characters and handling `Backspace`, `Enter`, and cursor navigation.
4. Replace the primary chat input field with `SyntheticInput` when running on Windows.

#### Edge cases
- Handling Shift modifiers for uppercase and symbols.
- Handling copy/paste (`Ctrl+C`, `Ctrl+V`).

#### Regression risks
- **Accessibility**: Synthetic inputs may not work well with screen readers. (Acceptable tradeoff for stealth mode).

#### Acceptance criteria
- [ ] User can type into the Natively overlay on Windows 11.
- [ ] Text renders correctly.
- [ ] Browser completely ignores the typing and maintains focus.

---

## 3. Sprint C — Visual Mouse Stealth (1 Week)

### TWS-005 — Full Stack: Invisible Hardware Cursor & Software Cursor
- **Severity**: P1
- **Subsystem**: full-stack
- **Owner**: agentic_worker
- **Order**: depends on TWS-003 and TWS-004

#### Problem
If the user moves the mouse into the overlay, the native OS hardware cursor is composite-rendered in screen captures, looking like the user is clicking empty space.

#### Proposed change
1. **Native (`windowsNativeBindings.rs`)**: When `WH_MOUSE_LL` detects the mouse entering the overlay bounds, hide the system cursor using `SetCursor(NULL)` or by confining it / sending invisible cursor handles. Send X/Y coordinates over IPC.
2. **Electron (`WindowHelper.ts`)**: Route the X/Y coordinates to the React frontend.
3. **Frontend (`SyntheticCursor.tsx`)**: Render a CSS/SVG cursor at the given X/Y coordinates. Ensure it has `pointer-events: none`.

#### Acceptance criteria
- [ ] When the mouse enters the overlay, the OS hardware cursor disappears.
- [ ] A fake React cursor appears and tracks perfectly with the mouse movement.
- [ ] Screen recordings only show the hardware cursor freezing at the edge of the overlay bounds.
