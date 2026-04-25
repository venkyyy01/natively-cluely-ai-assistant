# Stealth Audit Claim Verification: Valid Findings and Fixes

Date: 2026-04-24
Status: Valid source-backed claims only
Scope: privacy, response visibility, startup protection, capture exclusion, helper trust, and verification gaps

## Executive Summary

The valid part of the external audit is this: the codebase cannot currently prove "always protected", "invisible", "undetectable", or "bulletproof" visibility behavior. Several runtime paths still depend on stubs, observable fallbacks, private APIs, incomplete validation, or non-fail-closed transitions.

This file intentionally excludes claims that were false, overstated, or not falsifiable from the supplied text. Each finding below has direct source evidence and a concrete implementation fix.

## V-1: macOS Native Window Enumeration Is Stubbed and Falls Back to Inline Python

Severity: High
Claim status: Valid, with corrected file path

Evidence:

- `native-module/src/stealth.rs:321-331` documents `list_visible_windows()` as a placeholder and returns `Ok(Vec::new())`.
- `native-module/src/stealth.rs:334-344` documents `check_browser_capture_windows()` as a placeholder and returns `Ok(false)`.
- `electron/stealth/StealthManager.ts:1321-1362` treats empty native results as unusable and falls back to `python3 -c` with `Quartz.CGWindowListCopyWindowInfo`.
- `electron/stealth/ChromiumCaptureDetector.ts:236-259` falls back to `python3 -c` after native `checkBrowserCaptureWindows()` returns false.
- `electron/stealth/MacosStealthEnhancer.ts:137-169` and `electron/stealth/MacosStealthEnhancer.ts:223-285` execute inline Python for AppKit/Quartz work.

Impact:

Runtime protection and capture-detection paths can spawn observable `python3 -c` subprocesses containing Quartz/AppKit symbols in command-line arguments. This invalidates native-only or no-fingerprint claims.

Implementation fix:

1. Implement real CoreGraphics enumeration in `native-module/src/stealth.rs` using Rust FFI for `CGWindowListCopyWindowInfo`.
2. Return a structured result that distinguishes "no visible capture windows" from "native enumeration unavailable".
3. Remove runtime Python fallbacks from `StealthManager`, `ChromiumCaptureDetector`, and `MacosStealthEnhancer`.
4. If a fallback remains during migration, gate it behind an explicit development-only flag and log that stealth proof is degraded.
5. Add tests proving production mode never invokes `python3` from stealth paths.

Acceptance criteria:

- Production startup and enforcement never call `python3 -c`.
- Native enumeration failure triggers fail-closed containment or a degraded visible warning, not silent fallback.
- Unit tests cover native unavailable, no windows, and detected capture windows as distinct outcomes.

## V-2: Applying Protection to an Already-Visible Window Has a TOCTOU Race

Severity: Critical
Claim status: Valid

Evidence:

- `electron/stealth/StealthManager.ts:362-365` warns that applying stealth layers to an already-visible window may briefly expose the window unprotected.
- `electron/stealth/StealthManager.ts:390-394` applies Layer 0, UI hardening, native stealth, and virtual display isolation after that warning.

Impact:

A window can be visible before capture exclusion has been applied and verified. This directly contradicts startup and visibility claims that the app is always protected until explicitly shown.

Implementation fix:

1. Replace warning-only behavior with a fail-closed transition.
2. If a window is visible and protection is being enabled, immediately hide it or set opacity to zero before applying layers.
3. Apply `setContentProtection(true)`, `setExcludeFromCapture(true)` where available, native stealth, UI hardening, and virtual-display isolation while hidden.
4. Verify the effective protection state before revealing the window.
5. If verification fails, keep the window hidden and activate privacy containment.

Acceptance criteria:

- There is no code path that calls `show()` before protection is applied and verified.
- Startup uses protected-hidden as the default state.
- Tests assert `hide -> protect -> verify -> show` ordering.
- Failed verification leaves the window hidden and records a fault.

## V-3: macOS Private and Undocumented APIs Are Used in Core Stealth Paths

Severity: High
Claim status: Valid

Evidence:

- `native-module/src/stealth.rs:103-145` resolves `CGSMainConnectionID` and `CGSSetWindowSharingState` with `dlsym` and casts them using `std::mem::transmute`.
- `stealth-projects/macos-virtual-display-helper/Sources/CGVirtualDisplayBackend.swift:98-121` discovers `CGVirtualDisplay*` classes with `NSClassFromString` and configures them through KVC.

Impact:

These paths depend on unstable Apple implementation details. Missing symbols are handled, but signature drift, behavior drift, or platform policy changes can still cause crashes, undefined behavior, or silent protection failure.

Implementation fix:

1. Wrap all private API usage behind a capability detector that runs before any window is shown.
2. Treat unsupported or unknown OS/API behavior as fail-closed.
3. Add a public-API fallback path where available, and downgrade unsupported Layer 3 features explicitly.
4. Record OS version, capability probe result, selected protection layer, and failure reason in local diagnostics.
5. Maintain a versioned macOS compatibility matrix from packaged-build runtime tests.

Acceptance criteria:

- No private API call runs before capability detection.
- Unknown macOS versions do not silently proceed as protected.
- Crash-prone calls are isolated behind narrow native wrappers with explicit error returns.
- Product claims identify the tested macOS versions and protection layer.

## V-4: Windows Protected Render Host Is Only a Scaffold

Severity: High
Claim status: Valid, narrowed

Evidence:

- `stealth-projects/windows-protected-render-host/src/main.cpp:1-13` only prints scaffold text and exits.
- `README.md:8` advertises `macOS | Windows`.
- `README.md:32-36` links Windows release artifacts and says Windows 10/11 is supported.
- `native-module/src/stealth.rs:171-197` does implement lower-level Windows display affinity, so the valid claim is not "zero Windows protection"; it is "the protected render-host layer is not implemented."

Impact:

Any claim that Windows has a protected render-host, protected swap chain, D3D protected surface, or equivalent advanced isolation is false. Windows protection currently depends on the lower-level display-affinity path and Electron behavior.

Implementation fix:

1. Decide the Windows release contract: display-affinity-only, or full protected render host.
2. If display-affinity-only, remove protected-render-host claims from docs, UI, and release notes.
3. If full protected render host is required, implement D3D11 device creation, protected-surface capability detection, swap-chain binding, IPC, lifecycle, and capture validation.
4. Add Windows packaged-build capture tests for OS screenshot, Teams, Zoom, Meet, and browser capture.
5. Fail closed when `SetWindowDisplayAffinity` fails or returns weaker-than-required protection.

Acceptance criteria:

- Windows docs and UI name the actual protection boundary.
- The scaffold binary is not shipped as a production protection layer.
- Windows release gates include capture-matrix evidence for the claimed layer.

## V-5: ScreenCaptureKit Audio Backend Creates a Video Capture Stream When Selected

Severity: High
Claim status: Valid conditionally

Evidence:

- `native-module/src/speaker/sck.rs:164-179` creates a ScreenCaptureKit display filter, enables audio capture, sets width and height to `2`, and uses a 1 FPS frame interval.
- `native-module/src/speaker/macos.rs:18-41` shows SCK is selected only by explicit `sck` device id or `NATIVELY_ALLOW_SCK_AUDIO_FALLBACK`.

Impact:

The SCK backend is not always active, but when selected it uses a screen-capture stream. Any claim that this path is invisible or indicator-free requires runtime OS evidence.

Implementation fix:

1. Keep SCK disabled by default and require explicit opt-in.
2. Add UI/state labeling when SCK is active because it may trigger OS capture indicators or permissions.
3. Prefer CoreAudio Tap for default speaker capture when available.
4. Add runtime tests on supported macOS versions to record menu-bar indicator, permission prompts, and capture visibility.
5. Block "invisible" claims for SCK mode until tests prove the exact behavior.

Acceptance criteria:

- Production fallback to SCK cannot occur silently.
- Runtime state exposes whether CoreAudio Tap or SCK is active.
- Capture/indicator matrix records behavior for each supported macOS version.

## V-6: CoreAudio Aggregate Device Uses a Hardcoded Product-Identifying Name

Severity: Medium
Claim status: Valid

Evidence:

- `native-module/src/speaker/core_audio.rs:61-63` creates an aggregate device named `NativelySystemAudioTap`.

Impact:

Any local process that can enumerate CoreAudio devices may observe a product-identifying aggregate device. This is a local fingerprint and should not be ignored in visibility or privacy claims.

Implementation fix:

1. Replace the hardcoded product name with a neutral, per-install or per-session label if compatible with CoreAudio constraints.
2. Keep a stable internal UID for cleanup, but avoid product-identifying display names.
3. Add startup cleanup for stale aggregate devices from previous crashes.
4. Add tests or a diagnostic command that enumerates devices before start, during capture, and after shutdown.

Acceptance criteria:

- No product-identifying aggregate device name is required for normal operation.
- Stale aggregate devices are removed on startup and shutdown.
- Diagnostics clearly show whether an audio device remains observable.

## V-7: macOS Helper Protocol Lacks Request Authentication and Response Nonce Binding

Severity: High
Claim status: Valid, narrowed

Evidence:

- `stealth-projects/macos-full-stealth-helper/Sources/main.swift:867-886` reads raw JSON lines from standard input.
- `stealth-projects/macos-full-stealth-helper/Sources/main.swift:889-936` requires `id` and `command`, then dispatches commands without validating a request nonce, parent identity, audit token, or code-signing identity.
- `electron/stealth/MacosVirtualDisplayClient.ts:268-269` sends a `nonce` field.
- `stealth-projects/macos-full-stealth-helper/Sources/main.swift:936` does not echo that nonce.
- `electron/stealth/MacosVirtualDisplayClient.ts:355-359` rejects mismatched response nonces only when a nonce exists; responses without a nonce are accepted.
- `electron/stealth/MacosVirtualDisplayClient.ts:293-295` spawns the helper as a stdio child process, so arbitrary local-process hijack is not proven by this code path.

Impact:

The helper is not proven to be publicly hijackable, but the wire protocol is not capability-bound. If the transport boundary changes, is misused, or is compromised, commands are not protected by protocol-level authentication.

Implementation fix:

1. Generate a high-entropy session secret in `MacosVirtualDisplayClient`.
2. Pass the secret to the helper through a restricted startup mechanism.
3. Require every helper request to include the secret or an HMAC over `{id, command, payload}`.
4. Require every helper response and event to echo or authenticate the same session capability.
5. Reject missing, mismatched, replayed, or expired request IDs.
6. If the helper ever moves to XPC/socket IPC, add audit-token or code-signing identity validation at connection time.

Acceptance criteria:

- Helper rejects requests with missing or invalid capability.
- Client rejects responses/events with missing or invalid capability.
- Tests cover invalid nonce, missing nonce, replayed id, unknown id, and helper restart.

## V-8: Live Capture Validation Is Incomplete

Severity: Critical
Claim status: Valid

Evidence:

- `electron/stealth/StealthCaptureFixture.ts:69-76` returns failure for live mode with reason `live mode not yet implemented without SCK helper binary`.
- `stealth-projects/macos-full-stealth-helper/Sources/main.swift:659-667` returns validation status `inconclusive` with reason `NSH-002 scaffold validates control-plane wiring only; full capture exclusion validation remains pending`.

Impact:

The codebase lacks automated proof for the central visibility claim. Unit tests can prove API calls happened; they cannot prove that Zoom, Meet, Teams, browser capture, OS screenshot, and ScreenCaptureKit all see blank or protected output.

Implementation fix:

1. Build a capture-matrix harness that runs against packaged builds, not only source/dev mode.
2. Cover macOS and Windows separately.
3. Include OS screenshot, window screenshot, ScreenCaptureKit, browser capture, Zoom, Meet, Teams, and app/window enumeration.
4. Store artifacts: screenshots, metadata, app version, OS version, active protection layer, and pass/fail reason.
5. Gate strong visibility claims and releases on this matrix.

Acceptance criteria:

- Live capture tests are implemented and no longer return scaffold/inconclusive results.
- CI or release qualification produces capture artifacts for each supported platform.
- Product copy is generated only from passing matrix rows.

## V-9: Renderer Bridge Health Reports Ready When It Cannot Probe

Severity: Medium
Claim status: Valid

Evidence:

- `electron/runtime/rendererBridgeHealth.ts:36-38` returns `ready` if the window is destroyed or `executeJavaScript` is unavailable.

Impact:

Startup and recovery can report a healthy renderer bridge when the probe did not actually run. This weakens confidence in protected startup and can mask preload/runtime failures.

Implementation fix:

1. Replace the current `ready` fallback with a distinct `unknown`, `destroyed`, or `unprobeable` state.
2. Treat non-ready states as recovery triggers or containment blockers.
3. Update callers to require a positive bridge probe before allowing visibility.
4. Add tests for destroyed windows, missing `executeJavaScript`, failed probe, successful reload, and exhausted reload.

Acceptance criteria:

- Health checks only return `ready` after a successful probe.
- Unknown/unprobeable states cannot allow protected visibility.
- Recovery logs include the exact non-ready reason.

## Release Rule

Until the fixes above are implemented and tested, the only defensible claim is limited and platform-specific:

> The app attempts to reduce capture visibility using Electron content protection, native display-affinity/window-sharing APIs, and optional helper layers. Protection is conditional on platform support and verified runtime state.

The following claims are not currently defensible:

- "bulletproof"
- "invisible"
- "undetectable"
- "always protected"
- "proven safe from screenshare"

