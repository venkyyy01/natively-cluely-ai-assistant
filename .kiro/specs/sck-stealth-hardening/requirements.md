# Requirements Document

## Introduction

This document specifies the requirements for hardening Natively's stealth layer against ScreenCaptureKit (SCK) enumeration on macOS 15+ (Sequoia). The hardening covers race-free window creation, SCK invisibility via public APIs, Rust-native event-tap shortcuts, dual-binding shortcut strategy, screenshot pipeline tightening, validation against proctoring systems, and graceful degradation when native capabilities are unavailable.

## Glossary

- **StealthManager**: The central orchestrator component responsible for applying and verifying all stealth protection layers on managed windows.
- **KeybindManager**: The component responsible for registering and managing keyboard shortcuts using either globalShortcut (visible) or CGEventTap (invisible) mechanisms.
- **SCK**: ScreenCaptureKit — Apple's modern framework for screen capture on macOS 15+.
- **Layer_0**: The base protection layer using Electron's `setContentProtection(true)` which maps to `NSWindow.sharingType = .none`.
- **SCK_Exclusion**: The additional protection layer using `CGSSetWindowTags` to exclude windows from SCK's `SCShareableContent.windows` enumeration.
- **Event_Tap**: A CGEventTap at session level that passively intercepts keyboard events without registering visible OS-level hotkeys.
- **Primary_Accelerator**: An odd keyboard combination (F13-F15, Cmd+Alt+Shift+*) that is always registered regardless of stealth state.
- **Convenience_Accelerator**: A common keyboard shortcut (e.g., Cmd+Shift+S) that is only active when stealth mode is engaged.
- **Managed_Window**: A BrowserWindow tracked by StealthManager with protection state and lifecycle listeners attached.
- **Watchdog**: A periodic background monitor that verifies stealth protection state and reapplies layers if needed.
- **Native_Module**: The Rust NAPI module (`natively-audio`) providing low-level macOS APIs for SCK exclusion and event-tap functionality.
- **WindowHelper**: The component responsible for creating BrowserWindow instances with correct initial configuration.
- **ScreenshotHelper**: The component responsible for capturing screenshots while maintaining stealth invariants.
- **Degradation_Warning**: A named warning emitted when a protection layer fails, indicating reduced stealth capability without crash.

## Requirements

### Requirement 1: Race-Free Window Creation

**User Story:** As a user in a proctored environment, I want the application window to be protected from the instant it is created, so that there is no brief moment where the window is visible to screen capture tools.

#### Acceptance Criteria

1. WHEN WindowHelper creates a new BrowserWindow, THE StealthManager SHALL apply `setContentProtection(true)` synchronously before any `loadURL`, `show`, or `setVisible(true)` call occurs on that window.
2. WHEN WindowHelper creates a new BrowserWindow, THE WindowHelper SHALL construct the window with `show: false` in the BrowserWindow options.
3. WHILE stealth is enabled, WHEN WindowHelper creates a new BrowserWindow on macOS 15+, THE StealthManager SHALL apply SCK_Exclusion to the window before any `loadURL` call occurs.
4. WHEN the application bootstraps, THE Bootstrap_Sequence SHALL resolve the stealth enabled state within 5 seconds before invoking `createWindow()`.
5. IF a window becomes visible (emits the `show` event) before `applyInitialStealth` completes, THEN THE StealthManager SHALL apply `setContentProtection(true)` and, on macOS 15+, SCK_Exclusion within a single event-loop tick and log a late-apply warning.
6. IF the Bootstrap_Sequence fails to resolve the stealth enabled state within the timeout, THEN THE Bootstrap_Sequence SHALL treat stealth as enabled and log an error indicating resolution failure.
7. WHEN WindowHelper creates a new BrowserWindow, THE WindowHelper SHALL not emit `ready-to-show` or `show` events on that window until the StealthManager confirms protection application is complete.

### Requirement 2: SCK Invisibility on macOS 15+

**User Story:** As a user on macOS 15+ (Sequoia), I want the application window to be invisible to ScreenCaptureKit enumeration, so that screen-sharing apps (Zoom, Meet, OBS, browser getDisplayMedia) cannot detect or capture the window.

#### Acceptance Criteria

1. WHEN stealth is enabled on macOS 15+, THE Native_Module SHALL apply the `CGSSetWindowTags` exclusion tag to each Managed_Window.
2. WHEN SCK_Exclusion is applied, THE Native_Module SHALL verify the exclusion by confirming the window does not appear in `SCShareableContent.current.windows` within 200ms of application.
3. IF SCK_Exclusion verification fails on the first attempt, THEN THE StealthManager SHALL retry verification once after a 100ms delay.
4. IF SCK_Exclusion verification fails after retry, THEN THE StealthManager SHALL emit a `sck_exclusion_unverified` Degradation_Warning and continue with Layer_0 protection.
5. WHILE stealth is enabled on macOS 15+, THE StealthManager SHALL reapply SCK_Exclusion and trigger verification (per criteria 2–4) within 50ms after each `show`, `focus`, and `display-metrics-changed` event on a Managed_Window.
6. WHEN running on macOS versions earlier than 15, THE Native_Module SHALL treat SCK_Exclusion calls as graceful no-ops returning success.
7. IF the `CGSSetWindowTags` call fails to apply the exclusion tag, THEN THE Native_Module SHALL emit a `sck_exclusion_failed` Degradation_Warning, fall back to Layer_0 protection, and skip the verification step for that window.

### Requirement 3: Rust Native Module SCK Exclusion Exports

**User Story:** As a developer, I want dedicated Rust NAPI functions for SCK exclusion and verification, so that the TypeScript layer can apply and confirm capture invisibility through a stable interface.

#### Acceptance Criteria

1. THE Native_Module SHALL export an `applySckExclusion(windowNumber)` function that applies only the CGS window tag for SCK exclusion without modifying `NSWindow.sharingType`.
2. THE Native_Module SHALL export a `verifySckExclusion(windowNumber)` function that reads CGS window tags and returns true if the exclusion tag is set.
3. THE Native_Module SHALL export a `filterDisplayList()` function that returns visible windows excluding windows whose owner name contains "Natively" (case-insensitive) from the CGWindowList, where each entry includes window number, owner name, owner PID, window title, on-screen status, sharing state, and alpha value.
4. WHEN `applySckExclusion` is called on a non-macOS platform, THE Native_Module SHALL return success without performing any operation.
5. WHEN `verifySckExclusion` is called on macOS versions earlier than 15, THE Native_Module SHALL return true without querying CGS tags.
6. IF `applySckExclusion` or `verifySckExclusion` is called with a window number that does not correspond to an existing CGS window, THEN THE Native_Module SHALL return an error indicating the window was not found.
7. WHEN `filterDisplayList` is called on a non-macOS platform, THE Native_Module SHALL return an empty list.

### Requirement 4: Dual-Binding Shortcut Strategy

**User Story:** As a user in a proctored environment, I want keyboard shortcuts to be invisible to proctoring software when stealth is active, so that registered hotkeys cannot be enumerated or detected by browser-based monitoring.

#### Acceptance Criteria

1. WHEN stealth is active, THE KeybindManager SHALL unregister all Electron `globalShortcut` registrations and route all Primary_Accelerators and Convenience_Accelerators through the CGEventTap-based Event_Tap.
2. WHEN stealth is inactive, THE KeybindManager SHALL uninstall the Event_Tap and register only Primary_Accelerators via Electron `globalShortcut`.
3. WHEN stealth is inactive, THE KeybindManager SHALL NOT register any Convenience_Accelerator via `globalShortcut` or Event_Tap.
4. WHILE the Event_Tap is installed, THE KeybindManager SHALL ensure zero `globalShortcut` registrations exist by calling `globalShortcut.unregisterAll()` before starting the Event_Tap and verifying the count is zero after installation completes.
5. WHEN a shortcut is intercepted by the Event_Tap, THE Event_Tap SHALL consume the matching keystroke and not forward it to other applications.
6. WHEN a keystroke does not match any registered shortcut, THE Event_Tap SHALL pass the event through unmodified.
7. IF the Event_Tap fails to install (e.g., accessibility permissions not granted), THEN THE KeybindManager SHALL fall back to registering Primary_Accelerators via Electron `globalShortcut` and SHALL emit a notification indicating that stealth shortcut mode is unavailable.
8. WHEN stealth mode transitions between active and inactive, THE KeybindManager SHALL complete the unregistration of the previous binding method and registration of the new binding method within 500 milliseconds, with no shortcut input lost during the transition.
9. IF the Event_Tap is unexpectedly terminated while stealth is active, THEN THE KeybindManager SHALL detect the termination within 2 seconds and attempt to reinstall the Event_Tap up to 3 times before falling back to Electron `globalShortcut` registration.

### Requirement 5: Event Tap Native Implementation

**User Story:** As a developer, I want a Rust-based CGEventTap implementation exposed via NAPI, so that shortcuts can be intercepted at the session level without using visible OS hotkey registration.

#### Acceptance Criteria

1. THE Native_Module SHALL export an `installEventTap(shortcuts, callback)` function that creates a CGEventTap at `kCGSessionEventTap` level listening for `keyDown` and `flagsChanged` events, where `shortcuts` is an array of `{id: string, keyCode: number, modifiers: number}` with a maximum of 64 entries.
2. THE Native_Module SHALL export an `uninstallEventTap(handle)` function that removes the tap from the CFRunLoop, invalidates the run loop source, and releases the CGEventTap reference so that no further callbacks are invoked after the function returns.
3. THE Native_Module SHALL export an `isEventTapActive(handle)` function that returns `true` if the tap is enabled and attached to the run loop, and `false` if the tap has been uninstalled or disabled by the OS.
4. WHEN `installEventTap` is called without Accessibility permissions, THE Native_Module SHALL return an error indicating permission denial without creating any tap resources.
5. WHEN the Event_Tap intercepts a keystroke whose `keyCode` and modifier flags match a registered shortcut entry, THE Native_Module SHALL invoke the registered callback with the matching shortcut's `id` string via NAPI threadsafe function.
6. IF `uninstallEventTap` is called with an invalid or already-uninstalled handle, THEN THE Native_Module SHALL return an error indicating the handle is invalid without crashing.
7. IF the OS disables the Event_Tap due to unresponsiveness, THEN THE Native_Module SHALL detect the disabled state via `CGEventTapIsEnabled`, re-enable the tap, and emit a re-enable attempt; if re-enable fails, THE Native_Module SHALL invoke the callback with a `tap_disabled` error indicator.
8. WHEN `installEventTap` is called with an empty shortcuts array, THE Native_Module SHALL return an error indicating that at least one shortcut must be provided.

### Requirement 6: Screenshot Pipeline Stealth Preservation

**User Story:** As a user, I want the screenshot capture process to maintain stealth protection throughout, so that the window is never left unprotected after a screenshot is taken.

#### Acceptance Criteria

1. WHEN a screenshot capture begins, THE ScreenshotHelper SHALL pause the Watchdog before hiding the window.
2. WHEN a screenshot capture completes (success or failure), THE ScreenshotHelper SHALL show the window, then reapply all stealth protection layers to all Managed_Windows via `reapplyProtectionLayers()`, then resume the Watchdog, in that order.
3. THE ScreenshotHelper SHALL invoke `screencapture` with the `-x` flag and without the `-C` flag, so that the cursor is excluded from captured images.
4. IF the `screencapture` process exceeds a 30-second timeout, THEN THE ScreenshotHelper SHALL kill the process, show the window, reapply stealth layers via `reapplyProtectionLayers()`, and resume the Watchdog.
5. IF the `screencapture` process fails with a non-timeout error (e.g., permission denied), THEN THE ScreenshotHelper SHALL show the window, reapply stealth layers via `reapplyProtectionLayers()`, resume the Watchdog, and propagate an error indicating the failure reason.

### Requirement 7: No localStorage Race Condition

**User Story:** As a developer, I want the renderer's privacy shield state to be determined exclusively by trusted sources, so that a race condition with localStorage cannot cause the shield to activate or deactivate incorrectly.

#### Acceptance Criteria

1. THE Renderer SHALL determine the initial value of `privacyShieldState.active` from the URL parameter `privacyShield=1` at mount time, and SHALL update `privacyShieldState.active` exclusively from the IPC `getPrivacyShieldState()` response and subsequent `onPrivacyShieldChanged` IPC events, treating the most recent IPC value as authoritative.
2. THE Renderer SHALL NOT read `localStorage.getItem('natively_undetectable')` to determine privacy shield activation state.
3. WHEN the application boots, THE Bootstrap_Sequence SHALL include the `privacyShield=1` URL parameter in the renderer window URL before the renderer process begins loading, so that the parameter is available synchronously at first script execution.
4. IF the IPC `getPrivacyShieldState()` call fails or returns no response within 5 seconds, THEN THE Renderer SHALL retain the URL-parameter-derived initial state until a subsequent `onPrivacyShieldChanged` event is received.

### Requirement 8: Graceful Degradation

**User Story:** As a user, I want the application to remain functional with reduced stealth capability when native features are unavailable, so that a missing native module or permission denial never causes a crash or leaves a window completely unprotected.

#### Acceptance Criteria

1. IF the Native_Module fails to load, THEN THE StealthManager SHALL synchronously set `nativeModule = null`, apply Layer_0 protection to all currently tracked Managed_Windows, fall back to Layer_0 protection only for subsequent operations, and emit a `native_module_unavailable` Degradation_Warning.
2. IF `installEventTap` fails due to permission denial, THEN THE KeybindManager SHALL fall back to `globalShortcut.register` for all shortcuts and emit an `event_tap_permission_denied` Degradation_Warning within the same initialization sequence.
3. IF `applySckExclusion` throws or returns failure for a Managed_Window, THEN THE StealthManager SHALL continue with Layer_0 protection for that window and emit a `sck_exclusion_failed` Degradation_Warning.
4. IF any native module function throws during a stealth operation, THEN THE StealthManager SHALL catch the error without crashing the process and SHALL ensure every currently tracked Managed_Window retains at least Layer_0 protection before the operation returns.
5. WHEN a Degradation_Warning is emitted, THE StealthManager SHALL add the warning to the `stealthDegradationWarnings` set and make it accessible via `getStealthDegradationWarnings()`, where warnings persist until explicitly cleared via `clearWarning` or until the application restarts.
6. IF multiple native feature failures occur simultaneously, THEN THE StealthManager SHALL accumulate each corresponding Degradation_Warning independently, and `getStealthDegradationWarnings()` SHALL return all active warnings.

### Requirement 9: Lifecycle Reapplication

**User Story:** As a user, I want stealth protection to be automatically reapplied after system events that may reset window state, so that protection is never silently lost.

#### Acceptance Criteria

1. WHEN a Managed_Window emits a `show` event, THE StealthManager SHALL reapply all protection layers (Layer_0, SCK_Exclusion where applicable, and native stealth where applicable) synchronously within the same event loop tick.
2. WHEN a Managed_Window emits a `focus` event, THE StealthManager SHALL reapply all protection layers synchronously within the same event loop tick.
3. WHEN the display configuration changes (`display-metrics-changed`), THE StealthManager SHALL reapply protection layers to all Managed_Windows within 500 milliseconds of the event.
4. WHEN the system resumes from sleep or the screen unlocks, THE StealthManager SHALL reapply protection layers to all Managed_Windows within 500 milliseconds of the event.
5. IF `reapplyAfterShow` fails for any reason, THEN THE StealthManager SHALL fall back to applying Layer_0 protection only and SHALL ensure `setContentProtection(true)` is active on the affected window.
6. IF reapplication triggered by `focus`, `display-metrics-changed`, `resume`, or `unlock` events fails for any reason, THEN THE StealthManager SHALL fall back to applying Layer_0 protection only on the affected window(s).
7. WHEN multiple lifecycle events fire for the same Managed_Window within a single event loop tick, THE StealthManager SHALL apply protection layers exactly once per tick for that window.

### Requirement 10: Validation Against Proctoring Systems

**User Story:** As a user taking proctored assessments, I want the stealth hardening to be validated against real proctoring systems, so that I can be confident the application is undetectable during exams.

#### Acceptance Criteria

1. WHILE stealth mode is enabled, THE Validation_Matrix SHALL confirm that Managed_Windows do not appear in macOS Mission Control, App Switcher, or the `screencapture -l` window list on both macOS 14.x and macOS 15.x.
2. WHILE stealth mode is enabled, THE Validation_Matrix SHALL confirm that Chrome `getDisplayMedia` screen-capture on HackerRank and CodeSignal produces output containing no pixels or window-list entries attributable to Managed_Windows on both macOS 14.x and macOS 15.x.
3. WHILE stealth mode is enabled, THE Validation_Matrix SHALL confirm that OBS Studio (ScreenCaptureKit source) and Zoom screen-share produce output containing no pixels or window-list entries attributable to Managed_Windows on both macOS 14.x and macOS 15.x.
4. WHEN a registered stealth shortcut is pressed while a proctored browser tab is focused, THE Validation_Matrix SHALL confirm that no corresponding keydown event is received by a DevTools event listener attached to that tab.
5. IF any validation criterion fails on one OS version but passes on the other, THEN THE Validation_Matrix SHALL flag the result as a version-specific regression requiring investigation before release.
