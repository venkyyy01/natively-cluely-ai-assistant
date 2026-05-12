# Tasks: SCK Stealth Hardening

## Task 1: Implement SCK capture exclusion in Rust native module
- [x] Add `excludeFromCapture` API binding in `native-module/src/stealth.rs` that calls `NSWindow.sharingType = .none` combined with the macOS 12.2+ `NSWindow` property `isExcludedFromWindowServer` or the SCK content filter exclusion approach
- [x] Implement `apply_sck_exclusion(window_number: u32)` function that sets the window to be excluded from ScreenCaptureKit enumeration using `CGSSetWindowTags` with `kCGSExcludeFromCapture` tag on macOS 15+
- [x] Implement `verify_sck_exclusion(window_number: u32) -> bool` function that queries SCK shareable content and confirms the window does NOT appear in the enumerated window list
- [x] Add `display_list_filter()` function that returns the list of visible windows excluding Natively windows, to verify exclusion is working
- [x] Export the new functions via NAPI as `applySckExclusion`, `verifySckExclusion`, and `getFilteredDisplayList`
- [x] Add unit tests in `native-module/src/stealth.rs` for the new functions (mock-based for non-macOS CI)

## Task 2: Implement CGEventTap-based dual-binding in stealth_keys.rs
- [x] Refactor `start_stealth_tap` in `native-module/src/stealth_keys.rs` to support dual-binding mode where both CGEventTap (passive, invisible) and Electron globalShortcut can coexist
- [x] Add `suppress_key_event(keycode: CGKeyCode, flags: CGEventFlags) -> bool` that swallows the event at the tap level before it reaches the active application (prevents keystroke leakage to browsers)
- [x] Implement configurable shortcut mapping that accepts a JSON-serialized keybind config from the TypeScript layer
- [x] Add `is_tap_active() -> bool` health-check function exported via NAPI
- [x] Ensure the event tap gracefully degrades if Accessibility permissions are not granted (return error, don't crash)
- [x] Add tests for shortcut matching logic and suppression behavior

## Task 3: Update StealthManager to use SCK exclusion layer
- [x] Add `applySckExclusion(win: StealthCapableWindow)` method to `electron/stealth/StealthManager.ts` that calls the new native `applySckExclusion` binding
- [x] Call `applySckExclusion` in `applyToWindow()` after Layer 0 (`setContentProtection`) for macOS 15+ systems
- [x] Add SCK exclusion verification to `verifyStealth()` method — check that `verifySckExclusion` returns true for all managed windows
- [x] Update `reapplyProtectionLayers()` to include SCK exclusion re-application after display changes or wake-from-sleep
- [x] Add SCK exclusion status to `getProtectionStateSnapshot()` return value
- [x] Add degradation warning when SCK exclusion fails but Layer 0 is still active

## Task 4: Fix boot/window-creation race condition in WindowHelper
- [x] Add a `stealthReadyPromise` gate in `electron/WindowHelper.ts` that resolves only after `StealthManager` has fully initialized and verified native module availability
- [x] Modify `createDirectWindow()` to await `stealthReadyPromise` before making the window visible (window is created hidden, stealth applied, then shown)
- [x] Ensure `createWindow()` applies stealth protection synchronously during window construction (before `loadURL` or `show`)
- [x] Add protection verification between window creation and first `show()` call — if verification fails, keep window hidden and emit a fault event
- [x] Update `StartupProtectionGate` in `electron/stealth/StartupProtectionGate.ts` to coordinate with the new `stealthReadyPromise`
- [x] Add integration test that verifies no window is ever visible without stealth protection applied

## Task 5: Update KeybindManager for dual-binding stealth mode
- [x] Modify `electron/services/KeybindManager.ts` `registerStealthShortcuts()` to use the new dual-binding mode from `stealth_keys.rs`
- [x] Implement key-event suppression: when stealth mode is active, the CGEventTap swallows shortcut keystrokes so they never reach the focused browser window
- [x] Add fallback logic: if CGEventTap fails to start (no Accessibility permission), fall back to Electron `globalShortcut` with a degradation warning
- [x] Expose `isStealthTapActive(): boolean` method that queries the native `is_tap_active()` function
- [x] Update `setStealthMode(enabled: boolean)` to transition between CGEventTap and globalShortcut modes without dropping registered shortcuts
- [x] Add test coverage for mode transitions and fallback behavior

## Task 6: Add continuous SCK exclusion enforcement loop
- [x] Create or update `electron/stealth/ContinuousEnforcementLoop.ts` to include SCK exclusion verification in its periodic check cycle
- [x] Poll `verifySckExclusion` for all managed windows every 2 seconds (configurable interval)
- [x] If a window is found to be visible in SCK enumeration, immediately re-apply exclusion and log a warning
- [x] After 3 consecutive re-application failures, trigger emergency protection (hide window) via `applyEmergencyProtection`
- [x] Integrate with the existing `pollCGWindowVisibility` and `pollCaptureTools` monitors in StealthManager
- [x] Add metrics/counters for exclusion failures to support debugging

## Task 7: Validate stealth against proctoring systems
- [x] Create `electron/tests/stealth-validation.test.ts` with test scenarios for SCK enumeration invisibility
- [x] Add test that spawns a child process using ScreenCaptureKit API to enumerate windows and verifies Natively windows are NOT listed
- [x] Add test that verifies `getDisplayMedia` in a browser context cannot see Natively windows (simulate browser capture enumeration)
- [x] Add test that verifies CGEventTap shortcuts do not appear in Accessibility API hotkey enumeration
- [x] Add test for race condition: rapidly create/destroy windows and verify stealth is never in an inconsistent state
- [x] Document manual validation steps for HackerRank, CodeSignal, ProctorU, and Karat in a `docs/stealth-validation-manual.md` file
