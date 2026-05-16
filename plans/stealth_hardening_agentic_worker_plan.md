# Stealth Hardening Agentic Worker Plan

Date: 2026-04-24
Status: Ready for agent assignment
Audience: low-context coding agents working in parallel
Compatibility boundary: remote tag lookup returned no tag output in this sandbox; local latest tag is `v2.5.0`. Treat startup visibility behavior, helper wire protocol, env flags, packaged-build behavior, and capture artifacts as compatibility-sensitive.

## Objective

Move the app from best-effort stealth toward a defensible privacy boundary:

> Sensitive windows must never become visible unless protection was applied and positively verified. If protection is unknown, degraded, or failed, keep sensitive windows hidden and enter a recoverable contained state.

This plan is intentionally staged to avoid bricking the app. Workers should add observability and pass-through wrappers before enforcing fail-closed behavior.

## Global Worker Rules

- Do not refactor unrelated code.
- Do not remove existing user recovery paths until replacement recovery is tested.
- Do not change multiple protection surfaces in one ticket unless listed in that ticket's write scope.
- If a ticket adds strict behavior, guard it behind a rollout flag first.
- If a ticket touches runtime code, run at least `npm run typecheck` and the listed focused tests.
- If a ticket touches native Rust, also run `cargo test --manifest-path native-module/Cargo.toml`.
- If a ticket touches Swift helpers, run the helper package tests where available and keep TypeScript client tests green.

## Shared Terms

- Surface boundary: the public or internal interface the ticket is allowed to change.
- Blast radius: the app behavior most likely to regress.
- Non-brick rule: failure may hide protected content, but must leave a clear recovery path through tray/menu/global shortcut/logged reason.
- Strict mode: proposed rollout flag `NATIVELY_STRICT_PROTECTION=1`; once stable, strict behavior becomes production default.
- Observe-only mode: records state and violations without blocking current behavior.

## Execution Waves

| Wave | Tickets | Goal |
|---|---|---|
| Wave 0 | SH-001, SH-005 | Add state/probe truth without behavior changes. |
| Wave 1 | SH-002, SH-006, SH-009A | Add pass-through control surfaces and proof scaffolding. |
| Wave 2 | SH-003, SH-004, SH-007 | Enforce fail-closed behavior behind flags. |
| Wave 3 | SH-008, SH-009B/9C | Remove risky fallbacks and prove packaged-build behavior. |
| Wave 4 | Hardening flip | Make strict mode default only after capture matrix passes. |

## [x] SH-001: Observe-Only Protection State Machine

Priority: P0
Type: refactor/test
Status: Done
Depends on: none
Parallel-safe with: SH-005, SH-006, SH-009A

Worker ownership:

- New files: `electron/stealth/ProtectionStateMachine.ts`, `electron/stealth/protectionStateTypes.ts`.
- Tests: `electron/tests/protectionStateMachine.test.ts`.
- Minimal integration points: `electron/main/AppState.ts`, `electron/stealth/StealthManager.ts`, `electron/WindowHelper.ts`, `electron/stealth/StealthRuntime.ts`.

Surface boundary:

- Internal TypeScript-only state tracking.
- No user-visible behavior change.
- No persisted schema.

Blast radius:

- Logging noise.
- Incorrect state snapshots confusing later tickets.

Implementation steps:

1. Define states: `boot`, `protecting-hidden`, `verified-hidden`, `visible-protected`, `degraded-observed`, `fault-contained`.
2. Define events: `window-created`, `protection-apply-started`, `protection-apply-finished`, `verification-passed`, `verification-failed`, `show-requested`, `shown`, `hide-requested`, `hidden`, `fault`, `recovery-requested`.
3. Implement a pure reducer plus a small class wrapper that stores a snapshot and emits structured logs.
4. Record violations in observe-only mode, especially `show-requested` before `verified-hidden`.
5. Add optional correlation metadata: window role, reason, caller, platform, strict flag, warning list.
6. Wire passive calls into existing show/protection paths without changing return values.
7. Add unit tests for legal transitions, illegal transitions, degraded state, and fault state.

Acceptance criteria:

- All existing behavior remains unchanged.
- State machine records an attempted show-before-verify as a violation but does not block it.
- Tests prove reducer behavior without Electron.
- Snapshot shape is stable enough for later tickets.

Validation:

- `npm run typecheck`
- `npm run test:electron -- protectionStateMachine`

Rollback:

- Remove integration calls; pure state-machine files are isolated.

## [x] SH-002: VisibilityController Wrapper

Priority: P0
Type: refactor/test
Status: Done
Depends on: SH-001
Parallel-safe with: SH-006, SH-009A

Worker ownership:

- New file: `electron/stealth/VisibilityController.ts`.
- Primary migration files: `electron/WindowHelper.ts`, `electron/SettingsWindowHelper.ts`, `electron/ModelSelectorWindowHelper.ts`, `electron/stealth/StealthRuntime.ts`, `electron/stealth/StealthManager.ts`.
- Tests: `electron/tests/visibilityController.test.ts`, updates to `electron/tests/windowHelper.test.ts`, `electron/tests/stealthRuntime.test.ts`, `electron/tests/stealthManager.test.ts`.

Surface boundary:

- Internal wrapper around `show`, `hide`, `showInactive`, `setOpacity`, and protection verification calls.
- Initial mode must be pass-through.

Blast radius:

- Startup window not appearing.
- Settings/model selector not opening.
- Stealth shell stuck hidden.

Implementation steps:

1. Create `VisibilityController` with pass-through methods:
   - `requestShow(win, context)`
   - `requestShowInactive(win, context)`
   - `requestHide(win, context)`
   - `setOpacity(win, value, context)`
   - `markProtectionApplied(win, result, context)`
   - `markVerification(win, result, context)`
2. The controller should call the state machine but not enforce blocking yet.
3. Replace direct show/hide calls in one helper at a time, starting with `WindowHelper`.
4. Migrate secondary helpers: settings window, model selector window.
5. Migrate stealth shell/content visibility in `StealthRuntime`.
6. Migrate `StealthManager` restore/emergency paths last because they are highest risk.
7. Add a static grep test or unit test that flags new direct `win.show()` calls in protected modules unless explicitly allowlisted.

Acceptance criteria:

- Existing window behavior is unchanged in default mode.
- Visibility calls emit state-machine events with role/reason metadata.
- Direct show/hide calls are either migrated or explicitly allowlisted with reason.
- Settings/model selector/launcher/overlay tests still pass.

Validation:

- `npm run typecheck`
- `npm run test:electron -- windowHelper`
- `npm run test:electron -- stealthRuntime`
- `npm run test:electron -- stealthManager`

Rollback:

- The wrapper is pass-through; rollback is replacing wrapper calls with previous direct calls.

## [x] SH-003: Fail-Closed Startup Gate

Priority: P0
Type: behavior/test
Status: Done
Depends on: SH-001, SH-002, SH-005
Parallel-safe with: SH-006 after interfaces stabilize

Worker ownership:

- New file: `electron/stealth/StartupProtectionGate.ts`.
- Integration files: `electron/main/bootstrap.ts`, `electron/main/AppState.ts`, `electron/WindowHelper.ts`, `electron/stealth/StealthManager.ts`, `electron/stealth/StealthRuntime.ts`.
- Tests: `electron/tests/startupProtectionGate.test.ts`, updates to `electron/tests/windowHelper.test.ts`, `electron/tests/stealthContentProtectionBeforeLoad.test.ts`.

Surface boundary:

- Startup visibility behavior.
- Must preserve app launch and recovery even when strict protection fails.

Blast radius:

- App opens hidden and user thinks it is dead.
- Window never appears after valid startup.
- Tray/dock/global shortcut recovery regresses.

Implementation steps:

1. Add a startup gate that defaults sensitive windows to hidden/opacity zero.
2. Require protection application before any startup reveal.
3. In observe-only default, log whether the startup reveal would have been blocked.
4. In `NATIVELY_STRICT_PROTECTION=1`, block reveal until verification returns pass.
5. If verification fails, enter recoverable containment:
   - keep sensitive windows hidden,
   - broadcast a non-sensitive privacy shield/recovery reason,
   - preserve global shortcut/tray recovery path,
   - do not crash or quit.
6. Add a timeout with explicit state: `startup-verification-timeout`.
7. Make startup intent explicit: visible app, protected shield, or boot unknown.

Acceptance criteria:

- No startup path reveals a sensitive window before protection is applied in strict mode.
- Default mode remains non-breaking while emitting would-block logs.
- Strict failure keeps app recoverable.
- Tests cover success, verification failure, timeout, and recovery path.

Validation:

- `npm run typecheck`
- `npm run test:electron -- startupProtectionGate`
- `npm run test:electron -- windowHelper`
- `npm run test:electron -- stealthContentProtectionBeforeLoad`

Rollback:

- Disable strict flag; startup gate remains observe-only.

## [x] SH-004: Fail-Closed Invisible Toggle

Priority: P0
Type: behavior/test
Status: Done
Depends on: SH-001, SH-002, SH-003
Parallel-safe with: SH-007 after shared degraded-state types land

Worker ownership:

- Files: `electron/main/AppState.ts`, `electron/ipc/registerSettingsHandlers.ts`, `electron/stealth/privacyShieldState.ts`, `electron/WindowHelper.ts`, `electron/SettingsWindowHelper.ts`, `electron/ModelSelectorWindowHelper.ts`.
- Tests: `electron/tests/mainLifecycleContainmentGuards.test.ts`, `electron/tests/ipcContracts.test.ts`, new `electron/tests/invisibleToggleProtection.test.ts`.

Surface boundary:

- IPC `set-undetectable` / `get-undetectable`.
- User-visible invisible-mode toggle behavior.
- Renderer event `undetectable-changed`.

Blast radius:

- Toggle gets stuck.
- UI state disagrees with main process state.
- User cannot make app visible again.

Implementation steps:

1. Serialize toggle operations with a single-flight lock.
2. Model toggle as two-phase:
   - enabling invisible mode: hide first, apply protection, verify, then update state.
   - disabling invisible mode: preserve Layer 0 protection, clear shield intent, then reveal through `VisibilityController`.
3. Keep the existing pending-target cleanup for failed toggles.
4. In observe-only mode, emit would-block violations for reveal-before-verify.
5. In strict mode, failed enable keeps windows hidden and reports containment reason.
6. In strict mode, failed disable should not brick the app; allow a minimal safe recovery surface or keep current visible state unchanged.
7. Broadcast `undetectable-changed` only after the canonical state transition succeeds.

Acceptance criteria:

- Rapid toggle spam cannot interleave show/protect operations.
- Failed enable does not reveal sensitive content.
- Failed disable leaves app in the last safe state with a logged reason.
- Renderer/localStorage state cannot claim success before main process commits.

Validation:

- `npm run typecheck`
- `npm run test:electron -- mainLifecycleContainmentGuards`
- `npm run test:electron -- ipcContracts`
- `npm run test:electron -- invisibleToggleProtection`
- `npm run test:renderer`

Rollback:

- Disable strict enforcement; keep serialized state updates if tests show no regression.

## [x] SH-005: Renderer Bridge Health Fix

Priority: P1
Type: bug-fix/test
Status: Done
Depends on: none
Parallel-safe with: SH-001, SH-006, SH-009A

Worker ownership:

- Files: `electron/runtime/rendererBridgeHealth.ts`, `electron/stealth/StealthRuntime.ts`.
- Tests: new or existing renderer bridge health tests under `electron/tests/`.

Surface boundary:

- Internal health result type.
- `attachRendererBridgeMonitor` callback semantics.

Blast radius:

- Stealth content window may be marked failed more often.
- Existing tests expecting `ready` for destroyed/unprobeable windows need updates.

Implementation steps:

1. Change `RendererBridgeHealthResult` from `'ready' | 'reloading' | 'failed'` to include `'destroyed' | 'unprobeable'` or a single `'unknown'`.
2. Make `probeRendererBridge` return non-ready when the window is destroyed or `executeJavaScript` is unavailable.
3. Update `onSettled` type to include the new non-ready results.
4. Update `StealthRuntime` to treat non-ready as a fault or degraded state, not success.
5. Add tests for destroyed window, missing `executeJavaScript`, thrown probe, failed reload, and successful bridge probe.

Acceptance criteria:

- `ready` only means the bridge probe actually passed.
- Unprobeable states cannot satisfy startup or visibility verification.
- Existing runtime behavior only changes where the old result was falsely healthy.

Validation:

- `npm run typecheck`
- `npm run test:electron -- rendererBridge`
- `npm run test:electron -- stealthRuntime`

Rollback:

- Temporarily map new non-ready states to `failed` while keeping the type expansion.

## [x] SH-006: Helper Nonce and Capability Binding

Priority: P1
Type: security/protocol/test
Status: Done
Depends on: none
Parallel-safe with: SH-001, SH-002, SH-005, SH-009A

Worker ownership:

- TypeScript client: `electron/stealth/MacosVirtualDisplayClient.ts`.
- Swift helper: `stealth-projects/macos-full-stealth-helper/Sources/main.swift`.
- Contract types: `electron/stealth/separateProjectContracts.ts`, helper protocol files if needed.
- Tests: `electron/tests/helperSignatureAndNonce.test.ts`, `electron/tests/macosVirtualDisplayClient.test.ts`, Swift helper tests where available.

Surface boundary:

- Helper serve-mode JSON wire protocol.
- Backward compatibility with already-built helper binaries.

Blast radius:

- Helper sessions fail to start.
- Pending requests hang.
- Events are dropped.

Implementation steps:

1. Keep existing code-sign verification.
2. Add a serve-mode handshake:
   - client generates high-entropy capability secret,
   - first line sends `hello` with request id and capability,
   - helper stores capability for that stdin session.
3. Require every following request to include either the capability or an HMAC over `{id, command, payload}`.
4. Require every response and helper event to echo or authenticate the same capability.
5. Reject missing/wrong capability in strict mode.
6. During migration, support legacy helper only when strict mode is off and emit degraded state.
7. Add replay protection for duplicate request ids where practical.

Acceptance criteria:

- Strict client rejects helper responses without capability binding.
- Strict helper rejects commands before handshake or with wrong capability.
- Legacy compatibility is explicit and observable, not silent.
- Pending requests settle on protocol failure.

Validation:

- `npm run typecheck`
- `npm run test:electron -- helperSignatureAndNonce`
- `npm run test:electron -- macosVirtualDisplayClient`
- Swift package tests for `macos-full-stealth-helper` where available.

Rollback:

- Strict client can allow legacy responses only with `NATIVELY_STRICT_PROTECTION` off.

## [x] SH-007: Production Fallback Policy

Priority: P0
Type: behavior/test
Status: Done
Depends on: SH-001
Parallel-safe with: SH-004 after shared degraded-state types land

Worker ownership:

- New file: `electron/stealth/StealthFallbackPolicy.ts`.
- Files: `electron/stealth/StealthManager.ts`, `electron/stealth/ChromiumCaptureDetector.ts`, `electron/stealth/MacosStealthEnhancer.ts`, `electron/stealth/nativeStealthModule.ts`, `native-module/src/speaker/macos.rs`, `electron/main/AppState.ts`.
- Tests: `electron/tests/stealthFallbackPolicy.test.ts`, updates to `electron/tests/macosStealthEnhancer.test.ts`, `electron/tests/screenShareInterruptionGuard.test.ts`.

Surface boundary:

- Environment flags and production/development fallback behavior.
- Existing `NATIVELY_ALLOW_SCK_AUDIO_FALLBACK`.

Blast radius:

- Production builds become stricter and may hide instead of continue.
- Audio capture selection may differ if fallback was implicitly relied on.

Implementation steps:

1. Centralize fallback decisions:
   - Python fallback allowed?
   - SCK fallback allowed?
   - native stealth load failure allowed?
   - private API failure allowed?
2. Define policy by environment:
   - development: allow fallback with warning,
   - production observe-only: block Python stealth fallback after SH-008 and record degraded,
   - strict production: block protected visibility or enter containment.
3. Add explicit env flags:
   - keep `NATIVELY_ALLOW_SCK_AUDIO_FALLBACK`,
   - add `NATIVELY_ALLOW_STEALTH_PYTHON_FALLBACK=1` for development only,
   - use `NATIVELY_STRICT_PROTECTION=1` for enforcement rollout.
4. Replace silent fallbacks with `DegradedProtectionReason` results.
5. Ensure SCK fallback cannot happen silently during an active screen share.
6. Add tests that production strict mode does not invoke Python fallback.

Acceptance criteria:

- Every fallback path returns an explicit policy decision.
- Strict production never silently degrades and then reveals sensitive content.
- Development remains usable with clear diagnostics.
- Existing SCK opt-in behavior remains compatible.

Validation:

- `npm run typecheck`
- `npm run test:electron -- stealthFallbackPolicy`
- `npm run test:electron -- macosStealthEnhancer`
- `npm run test:electron -- screenShareInterruptionGuard`
- `cargo test --manifest-path native-module/Cargo.toml`

Rollback:

- Turn strict mode off; fallback policy continues to log degraded states. Python stealth fallback remains development-only after SH-008.

## [x] SH-008: Native Replacement Work

Priority: P1/P2
Type: native/refactor/test
Status: Done
Depends on: SH-007
Parallel-safe with: SH-009B if test harness uses mocked adapters first

Worker ownership:

- Rust native module: `native-module/src/stealth.rs`, `native-module/index.d.ts`, `native-module/index.js`.
- TypeScript callers: `electron/stealth/StealthManager.ts`, `electron/stealth/ChromiumCaptureDetector.ts`.
- macOS enhancer replacement path: either `native-module/src/stealth.rs` or a Swift helper surface; do not edit both without coordination.
- Tests: native tests plus Electron tests for no-Python production path.

Surface boundary:

- Native module exported API.
- Runtime removal of Python stealth fallbacks.

Blast radius:

- macOS native build failures.
- Capture detection false positives/false negatives.
- Private API crash risk if FFI is wrong.

Implementation steps:

1. Implement CoreGraphics window enumeration in Rust:
   - call `CGWindowListCopyWindowInfo`,
   - extract window number, owner pid/name, title, on-screen status, alpha, sharing state,
   - return structured errors for unavailable APIs.
2. Implement browser capture detection using the same native enumeration result instead of a separate Python path.
3. Update TypeScript callers to consume native result status, not just empty array/boolean.
4. Remove production `python3 -c` calls from `StealthManager` and `ChromiumCaptureDetector`.
5. Replace `MacosStealthEnhancer` Python AppKit calls with a native/Swift path or mark them development-only until replaced.
6. Add contract tests that production strict mode cannot execute Python fallback.
7. Add native tests with fixture-like parsing where direct macOS APIs are not testable in CI.

Acceptance criteria:

- Native enumeration returns real data on macOS.
- Empty result means true empty, not "native stub failed".
- Production strict mode has zero stealth Python subprocess paths.
- TypeScript tests cover native unavailable, native error, true empty, and detected windows.

Validation:

- `cargo test --manifest-path native-module/Cargo.toml`
- `npm run typecheck`
- `npm run test:electron -- stealthManager`
- `npm run test:electron -- chromiumCaptureDetector`
- `npm run verify:production`

Rollback:

- Keep old Python path behind development-only flag until native path has packaged-build proof.

## SH-009: Capture-Matrix Harness

Priority: P0 for scaffold, P1/P2 for full live matrix
Type: test/infra
Status: Done
Depends on: none for scaffold; SH-003, SH-004, SH-007, SH-008 for release gating
Parallel-safe with: most implementation tickets if adapters are mocked first

Worker ownership:

- New directory: `stealth-projects/integration-harness/capture-matrix/`.
- Possible Electron fixture file: `electron/stealth/StealthCaptureFixture.ts`.
- Package scripts: `package.json`.
- Docs/artifacts: `stealth-projects/integration-harness/capture-matrix.md`, `output/capture-matrix/`.

Surface boundary:

- Test harness and release artifacts.
- No production runtime behavior unless a ticket explicitly gates release on results.

Blast radius:

- Slow/flaky tests.
- CI instability.
- False confidence from mock-only results.

Sub-ticket [x] SH-009A: Matrix schema and mocked adapters

Implementation steps:

1. Define matrix row schema: platform, OS version, app version, capture tool, mode, monitors, strict flag, expected result, actual result, artifact paths.
2. Define adapter interface: `prepare`, `startCapture`, `triggerVisibility`, `collectArtifact`, `analyze`, `cleanup`.
3. Add mocked adapters for screenshot/browser/video capture.
4. Add artifact writer for screenshots, JSON metadata, and logs.
5. Add a CLI that can run `--mock` without OS permissions.

Acceptance criteria:

- `npm run test:electron` covers schema and mock analysis.
- Mock matrix produces deterministic artifacts under `output/capture-matrix/mock`.

Sub-ticket [x] SH-009B: Local OS capture adapters

Implementation steps:

1. Add macOS adapters for `screencapture`, CGWindow enumeration, and ScreenCaptureKit where available.
2. Add Windows adapter stubs first, then implement Snipping Tool/Windows Graphics Capture workflow where automation is feasible.
3. Add canary rendering: unique high-contrast token or QR-like marker in protected test surface.
4. Add pixel/OCR/token detector that fails if canary is present in captured artifact.

Acceptance criteria:

- Local macOS run can prove canary absent/present in controlled positive and negative fixtures.
- Adapters skip with explicit reason when permissions/tools are unavailable.

Sub-ticket [x] SH-009C: Meeting app/browser capture adapters

Implementation steps:

1. Add browser `getDisplayMedia` test page and Playwright harness.
2. Add manual/semi-automated adapters for Zoom, Meet, Teams, and OBS.
3. Store external app version and capture mode in each artifact.
4. Keep these out of normal CI until stable; run in release qualification.

Acceptance criteria:

- Release qualification can produce a signed artifact bundle for each supported platform.
- Product claims can be generated from passed rows only.

Validation:

- `npm run typecheck`
- `npm run test:electron -- stealthCaptureFixture`
- capture matrix mock command added by this ticket
- live matrix commands documented but not required in normal unit CI

Rollback:

- Harness is additive; disable release gate until live adapters are stable.

## Cross-Ticket Invariants

Every implementation ticket must preserve or improve these invariants:

- A sensitive window is never shown before protection is applied in strict mode.
- `ready` means positively verified, not "could not check".
- Degraded protection is explicit and queryable.
- Production strict mode does not silently use Python stealth fallbacks.
- SCK audio fallback never happens silently.
- Helper protocol failures settle pending requests and do not hang startup.
- Recovery does not reveal sensitive content automatically after a protection fault.
- The user has a non-sensitive recovery path if strict protection keeps windows hidden.

## Regression Gates

Minimum gate after each runtime ticket:

- `npm run typecheck`
- Focused Electron tests listed in the ticket

Gate before enabling strict behavior by default:

- `npm run test:electron`
- `npm run test:renderer`
- `cargo test --manifest-path native-module/Cargo.toml`
- `npm run verify:production`
- Capture-matrix packaged-build artifact bundle for supported platforms

## Final Rollout Plan

1. Land SH-001 and SH-005 first. They expose truth without enforcement.
2. Land SH-002 as pass-through and keep it boring.
3. Land SH-003 and SH-004 behind `NATIVELY_STRICT_PROTECTION=1`.
4. Land SH-006 with legacy compatibility only when strict mode is off.
5. Land SH-007 so fallbacks are explicit and policy-driven.
6. Land SH-008 to remove runtime Python paths from production strict mode.
7. Land SH-009 enough to produce packaged-build proof artifacts.
8. Flip strict mode to production default only after release qualification passes.
