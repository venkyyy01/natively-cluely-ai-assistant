# Implementation Plan: Stealth Hardening Quick Wins

## Overview

This plan implements 10 coordinated improvements to the Natively stealth subsystem. The central change is a `StealthTickCoordinator` that replaces ~8 independent `setInterval` calls with a single 250ms base-tick scheduler. All other work items build on or integrate with this coordinator. Each step is independently mergeable and follows the dependency order specified in the design.

## Tasks

- [x] 1. Implement StealthTickCoordinator
  - [x] 1.1 Create `electron/stealth/StealthTickCoordinator.ts` with base tick timer, handler registration/deregistration, cadence dispatch, per-id serialization, and lane-aware submission
    - Implement `TickHandler` interface and `StealthTickCoordinatorOptions`
    - Single 250ms `setInterval` with `tickCount` incrementing each tick
    - Dispatch handlers when `tickCount % handler.cadence === 0`
    - Per-id execution lock to skip overlapping invocations
    - Safe registration/deregistration during active dispatch (pending queues)
    - Idempotent `start()`/`stop()` lifecycle methods
    - Cadence validation: reject values outside [1, 240] with `RangeError`
    - Error isolation: log and continue on handler throw/reject
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1B.1, 1B.2, 1B.3, 1B.4, 1B.5_

  - [x] 1.2 Write property tests for StealthTickCoordinator
    - **Property 1: Cadence Dispatch Correctness** — verify handler invoked `floor(N/c)` times after N ticks
    - **Property 2: Per-ID Serialization** — no concurrent executions of same handler ID
    - **Property 3: Dispatch-Time Mutation Safety** — register/deregister during dispatch preserves consistency
    - **Property 4: Error Isolation** — throwing handlers don't disrupt others
    - **Property 5: Cadence Validation** — only [1, 240] accepted
    - **Property 6: Idempotent Start/Stop** — repeated calls are no-ops
    - **Property 14: Sequential Dispatch Within Tick** — same-tick handlers dispatched sequentially
    - **Validates: Requirements 1.2, 1.3, 1B.1, 1B.2, 1B.4, 1B.5, 1.6, 1.7, 1.5, 5B.4**

  - [x] 1.3 Write unit tests for StealthTickCoordinator
    - Test handler registration and dispatch with fake timers
    - Test deregistration stops future invocations
    - Test `stop()` during active dispatch completes cycle
    - Test duplicate handler ID overwrites existing
    - _Requirements: 1.1, 1.4, 1B.3_

- [x] 2. Tighten Capture Tool Patterns
  - [x] 2.1 Create `electron/stealth/captureToolPatterns.ts` with consolidated regex and path-verification logic
    - Export `CAPTURE_TOOL_REGEX` combining all legitimate patterns minus false positives (`coreaudiod`, `chrome`, `screenshot`, `airplay`)
    - Export `AMBIGUOUS_PATTERNS` map for patterns requiring path verification
    - Export `matchCaptureToolProcess(processName, executablePath?)` function
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 2.2 Write property tests for capture tool patterns
    - **Property 15: Ambiguous Pattern Path Verification** — ambiguous matches require path verification
    - **Property 16: Capture Tool Regex Coverage** — all legitimate tools match, false positives excluded
    - **Validates: Requirements 6.1, 6.3, 6.4**

  - [x] 2.3 Write unit tests for capture tool patterns
    - Test each excluded false-positive does not match
    - Test known capture tools still match
    - Test path-qualified matching for ambiguous patterns
    - _Requirements: 6.2, 6.4_

- [x] 3. Sandbox ScreenRAG tmpdir
  - [x] 3.1 Refactor `electron/rag/ScreenRAGManager.ts` to use `os.tmpdir()` with random prefix, immediate unlink after OCR, active-file tracking, and safe `dispose()` cleanup
    - Replace `app.getPath('userData')` with `os.tmpdir()` + random prefix
    - Add `activeFiles: Set<string>` for concurrency-safe tracking
    - Unlink file immediately after OCR completes
    - `dispose()` waits for in-progress writes then cleans all remaining files
    - Handle `ENOENT` silently, log `EPERM` as warning
    - Wire `before-quit` cleanup
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7B.1, 7B.2, 7B.3, 7B.4_

  - [x] 3.2 Write property tests for ScreenRAG sandbox
    - **Property 17: Immediate File Unlink After OCR** — file does not exist after unlink
    - **Property 18: No Double-Unlink** — unlink called at most once per file
    - **Property 19: No Unlink During Active Write** — concurrent dispose doesn't unlink active writes
    - **Property 20: Dispose Cleans All Files** — no files remain after dispose
    - **Validates: Requirements 7.2, 7.3, 7B.1, 7B.2, 7B.4**

  - [x] 3.3 Write unit tests for ScreenRAG sandbox
    - Test tmpdir usage instead of userData
    - Test file cleanup on dispose
    - Test ENOENT handling on unlink
    - _Requirements: 7.1, 7.5_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Complete MonitoringDetector with layers 2-4 and JSON signature database
  - [x] 5.1 Create `electron/stealth/signatures.json` with at least 22 monitoring tool signatures including process patterns, window title patterns, filesystem artifacts, and launch agent paths
    - Include Teramind, ActivTrak, Honorlock, Proctorio, Hubstaff, Time Doctor, and others
    - Follow the schema defined in the design document
    - _Requirements: 4.2, 4.4_

  - [x] 5.2 Extend `electron/stealth/MonitoringDetector.ts` with 4 detection layers: process name, window title, filesystem artifact, and launch agent inspection
    - Add `MonitoringDetectorV2Options` with `signatureDatabasePath` and `signatures` injection
    - Load signatures from JSON file with fallback to hardcoded `KNOWN_ENTERPRISE_TOOLS`
    - Implement window-title matching layer
    - Implement filesystem-artifact scanning layer
    - Implement launch-agent inspection layer (macOS)
    - Deduplicate results when same tool detected by multiple layers
    - Include `detectionLayer` and `confidence` in threat reports
    - _Requirements: 4.1, 4.3, 4.5_

  - [x] 5.3 Write property tests for MonitoringDetector v2
    - **Property 12: Monitoring Deduplication** — same tool from multiple layers appears once
    - **Property 13: Detection Layer Attribution** — filesystem/launch-agent detections include correct layer
    - **Validates: Requirements 4.3, 4.5**

  - [x] 5.4 Write unit tests for MonitoringDetector v2
    - Test JSON signature loading and fallback
    - Test each detection layer independently
    - Test deduplication across layers
    - _Requirements: 4.1, 4.2, 4.4_

- [x] 6. Implement ScreenShareDetector
  - [x] 6.1 Create `electron/stealth/ScreenShareDetector.ts` with 4-tier detection, state machine, hysteresis (3 consecutive negatives for share-ended), and event emission
    - Tier 1: native module detection
    - Tier 2: TCC database probe (macOS)
    - Tier 3: process name matching
    - Tier 4: window title matching
    - State machine with `active`, `confidence`, `detectedBy`, `consecutiveNegatives`
    - Monotonic sequence number for event ordering
    - Emit `share-started` / `share-ended` events
    - Non-macOS: process-name only + "invisibility unverified" warning
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3B.1, 3B.2, 3B.3, 3B.4_

  - [x] 6.2 Write property tests for ScreenShareDetector
    - **Property 9: Share-Started State Transition** — exactly one event on first positive detection
    - **Property 10: Share-Ended Hysteresis** — event only after 3 consecutive negatives
    - **Property 11: Detection Result Consistency** — monotonic sequence prevents stale overwrites
    - **Validates: Requirements 3.4, 3.5, 3.6, 3B.1, 3B.3**

  - [x] 6.3 Write unit tests for ScreenShareDetector
    - Test tier timeout handling
    - Test cross-platform fallback behavior
    - Test re-entry guard prevents overlapping cycles
    - _Requirements: 3.3, 3B.2, 3B.4_

- [x] 7. Wire ContinuousEnforcementLoop into AppState with kill switch
  - [x] 7.1 Update `electron/main/AppState.ts` to start/stop `ContinuousEnforcementLoop` on stealth enable/disable and before-quit
    - Start loop when `setUndetectable(true)` is called
    - Stop loop when `setUndetectable(false)` is called
    - Stop loop on `before-quit` event
    - Serialize lifecycle transitions to prevent double-start
    - _Requirements: 2.1, 2.2, 2.3, 2B.1, 2B.2, 2B.4_

  - [x] 7.2 Implement kill-switch behavior with strict/non-strict modes in `ContinuousEnforcementLoop`
    - Non-strict (default): hide all windows + emit `stealth:fault` + show warning
    - Strict (`NATIVELY_STRICT_KILL_SWITCH=1`): call `gracefulShutdown.shutdown(1, reason)`
    - Monotonic enforcement-epoch counter for hide precedence over user show
    - _Requirements: 2.4, 2.5, 2B.3_

  - [x] 7.3 Write property tests for enforcement loop lifecycle
    - **Property 7: Lifecycle Serialization** — no double-started state on rapid toggles
    - **Property 8: Kill-Switch Hide Precedence** — hide wins over show during active epoch
    - **Validates: Requirements 2B.1, 2B.3**

  - [x] 7.4 Write unit tests for enforcement loop lifecycle and kill switch
    - Test start-on-enable, stop-on-disable
    - Test stop on before-quit
    - Test non-strict mode hides windows
    - Test strict mode quits app
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Migrate setInterval owners onto StealthTickCoordinator
  - [x] 9.1 Migrate StealthManager watchdog, SCStream monitor, CGWindow monitor, and ChromiumCaptureDetector to use StealthTickCoordinator handlers
    - Replace each component's internal `setInterval` with a `register()` call on the coordinator
    - Preserve existing re-entry guards and pause-token mechanisms
    - Ensure sequential dispatch within same tick for shared-state safety
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5B.1, 5B.3, 5B.4_

  - [x] 9.2 Migrate ContinuousEnforcementLoop timers to StealthTickCoordinator handlers
    - Replace window-protection, process-detection, disguise-validation, and SCK-exclusion timers
    - Preserve per-handler "is-running" guards
    - _Requirements: 5.5, 5B.2_

  - [x] 9.3 Write integration tests for tick migration
    - Verify no independent `setInterval` calls remain for stealth work
    - Verify migrated components maintain existing concurrency guarantees
    - _Requirements: 5.6, 5B.1, 5B.2, 5B.3, 5B.4_

- [x] 10. ScreenRAG threshold and event-driven redesign with lane offload
  - [x] 10.1 Implement threshold activation (3 screenshots) and event-driven sampling in `ScreenRAGManager`
    - Add `screenshotCount` with atomic increment
    - Auto-activate at threshold of 3
    - Register as tick coordinator handler on intelligence-lane idle ticks
    - Reset counter and deactivate on meeting/session end
    - Skip sampling when window hidden, screen locked, or screen-share active
    - OCR timeout at 10 seconds with cancellation
    - Idempotent tick handling (no double OCR)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8B.1, 8B.2, 8B.3_

  - [x] 10.2 Write property tests for ScreenRAG threshold
    - **Property 21: Threshold Activation Exactly Once** — activates once at count 3, not again until reset
    - **Property 22: Sampling Skip on Suppression** — no capture when suppressed
    - **Property 23: Idempotent Tick Handling** — no second OCR while one is in progress
    - **Property 24: Meeting-End Race Safety** — counter always valid after interleaved events
    - **Validates: Requirements 8.1, 8.4, 8B.1, 8B.2, 8B.3**

  - [x] 10.3 Write unit tests for ScreenRAG threshold
    - Test activation after exactly 3 screenshots
    - Test reset on meeting end
    - Test OCR timeout cancellation
    - Test suppression conditions
    - _Requirements: 8.2, 8.5, 8.6_

- [x] 11. DevTools lockdown
  - [x] 11.1 Create `electron/utils/lockdownDevtools.ts` with shortcut blocking, DevTools closure, and environment variable override
    - Block Ctrl+Shift+I, Cmd+Opt+I, F12 in packaged builds
    - Close DevTools if opened by any means
    - Allow DevTools when `NATIVELY_ALLOW_DEVTOOLS=1`
    - No-op in development mode
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 11.2 Write unit tests for DevTools lockdown
    - Test shortcut interception in packaged mode
    - Test DevTools closure
    - Test environment variable override
    - Test no restriction in dev mode
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

- [ ] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1-24)
- Unit tests validate specific scenarios, lifecycle integration, and platform-specific behavior
- All tests use Node.js built-in test runner (`node --test`) with `assert/strict` and `fast-check` for property tests
- Each step (1-11) is independently mergeable following the dependency order

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3", "3.2", "3.3", "5.1"] },
    { "id": 2, "tasks": ["5.2", "6.1", "11.1"] },
    { "id": 3, "tasks": ["5.3", "5.4", "6.2", "6.3", "11.2"] },
    { "id": 4, "tasks": ["7.1", "7.2"] },
    { "id": 5, "tasks": ["7.3", "7.4", "9.1"] },
    { "id": 6, "tasks": ["9.2"] },
    { "id": 7, "tasks": ["9.3", "10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3"] }
  ]
}
```
