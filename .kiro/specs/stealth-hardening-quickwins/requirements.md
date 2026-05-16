# Requirements Document

## Introduction

This feature consolidates and hardens the stealth subsystem of the Natively desktop application through 10 coordinated quick-win improvements. The changes replace scattered independent timers with a centralized tick coordinator, expand monitoring and screen-share detection to multi-tier approaches, sandbox ephemeral data, redesign ScreenRAG activation to be event-driven, lock down DevTools in production, and tighten capture-tool pattern matching to reduce false positives.

## Glossary

- **Tick_Coordinator**: A centralized scheduler (`StealthTickCoordinator.ts`) that replaces independent `setInterval` calls with a single 250ms base tick, dispatching registered handlers at their configured cadences.
- **Handler**: A function registered with the Tick_Coordinator that executes at a specified cadence (multiple of the base tick interval).
- **Cadence**: The interval at which a Handler is dispatched, expressed as a multiple of the 250ms base tick.
- **Lane**: A background execution channel provided by AccelerationManager for offloading non-critical work (e.g., intelligence-lane, background-lane).
- **Continuous_Enforcement_Loop**: The existing `ContinuousEnforcementLoop` class that periodically verifies window protection, detects monitoring processes, and validates disguise state.
- **AppState**: The central application state manager (`electron/main/AppState.ts`) that coordinates lifecycle of all subsystems.
- **Screen_Share_Detector**: A new multi-tier detection module that identifies active screen-sharing sessions across platforms.
- **TCC_Database**: The macOS Transparency, Consent, and Control database that records screen-recording permissions granted to applications.
- **Monitoring_Detector**: The existing `MonitoringDetector` class that identifies enterprise monitoring and proctoring tools by process name.
- **Signature_Database**: A JSON-based registry of known monitoring/proctoring tool signatures used by the Monitoring_Detector for multi-layer detection.
- **Capture_Tool_Patterns**: The array of regex patterns in StealthManager used to identify screen-capture processes.
- **Screen_RAG_Manager**: The `ScreenRAGManager` class that performs periodic screen capture, OCR, and context extraction for AI assistance.
- **DevTools_Lockdown**: A utility module (`electron/utils/lockdownDevtools.ts`) that prevents access to Chromium DevTools in production builds.
- **Kill_Switch**: The emergency response behavior triggered by the Continuous_Enforcement_Loop when critical violations are detected.
- **Privacy_Shield**: The application's privacy protection state machine that manages window visibility based on threat detection.
- **SCK_Exclusion**: ScreenCaptureKit exclusion tag applied to windows on macOS 15+ to hide them from screen-capture enumeration.

## Requirements

### Requirement 1: Coordinated Tick Scheduler

**User Story:** As a developer, I want all periodic stealth tasks dispatched from a single coordinated scheduler, so that timer proliferation is eliminated and background work is predictable.

#### Acceptance Criteria

1. THE Tick_Coordinator SHALL provide a single 250ms base tick interval that dispatches all registered Handlers at their configured Cadences, supporting up to 64 concurrent Handler registrations.
2. WHEN a Handler is registered with an identifier, a Cadence (integer from 1 to 240), and a target Lane, THE Tick_Coordinator SHALL invoke that Handler every (Cadence × 250ms) milliseconds on the specified AccelerationManager Lane.
3. WHILE a Handler for a given identifier is already executing (i.e., its returned Promise has not yet resolved or rejected), THE Tick_Coordinator SHALL skip the next scheduled invocation for that identifier to prevent overlap (per-id serialization).
4. WHEN a Handler is deregistered by identifier, THE Tick_Coordinator SHALL remove it from the dispatch schedule and no longer invoke it on subsequent ticks.
5. THE Tick_Coordinator SHALL expose `start()` and `stop()` lifecycle methods that control the base tick timer; calling `start()` when already started or `stop()` when already stopped SHALL have no effect (idempotent).
6. IF a Handler throws a synchronous exception or returns a rejected Promise, THEN THE Tick_Coordinator SHALL log the error and continue dispatching remaining Handlers without interruption.
7. IF a Handler is registered with a Cadence value less than 1 or greater than 240, THEN THE Tick_Coordinator SHALL reject the registration and indicate an invalid cadence error.

### Requirement 1B: Tick Coordinator Concurrency Safety

**User Story:** As a developer, I want the Tick Coordinator to be free of race conditions, so that concurrent handler registrations and tick dispatches do not corrupt internal state.

#### Acceptance Criteria

1. WHILE the Tick_Coordinator is dispatching handlers on a tick, THE Tick_Coordinator SHALL safely handle new handler registrations without corrupting the handler list.
2. WHILE the Tick_Coordinator is dispatching handlers on a tick, THE Tick_Coordinator SHALL safely handle handler de-registrations without skipping or double-invoking remaining handlers.
3. WHEN `stop()` is called while a tick dispatch is in progress, THE Tick_Coordinator SHALL complete the current dispatch cycle and prevent further ticks from firing.
4. WHEN multiple async Handlers complete out of order, THE Tick_Coordinator SHALL maintain correct per-id serialization state without race conditions on the "is-executing" flag.
5. THE Tick_Coordinator SHALL use atomic state transitions for handler execution tracking to prevent concurrent tick dispatches from both invoking the same serialized handler.

### Requirement 2: Wire Continuous Enforcement Loop into AppState Lifecycle

**User Story:** As a user, I want the enforcement loop to start and stop automatically with stealth mode, so that protection is always active when needed and resources are freed when not.

#### Acceptance Criteria

1. WHEN stealth mode is enabled in AppState, THE AppState SHALL start the Continuous_Enforcement_Loop.
2. WHEN stealth mode is disabled in AppState, THE AppState SHALL stop the Continuous_Enforcement_Loop.
3. WHEN the application is quitting, THE AppState SHALL stop the Continuous_Enforcement_Loop.
4. WHEN the Kill_Switch is triggered and `NATIVELY_STRICT_KILL_SWITCH` environment variable is not set to `1`, THE Continuous_Enforcement_Loop SHALL hide all windows and warn the user instead of quitting the application.
5. WHEN the Kill_Switch is triggered and `NATIVELY_STRICT_KILL_SWITCH` environment variable is set to `1`, THE Continuous_Enforcement_Loop SHALL quit the application.

### Requirement 2B: Enforcement Loop Lifecycle Concurrency Safety

**User Story:** As a developer, I want the enforcement loop start/stop lifecycle to be safe against rapid enable/disable toggling, so that no zombie timers or double-starts occur.

#### Acceptance Criteria

1. WHEN stealth mode is toggled rapidly (enable → disable → enable), THE AppState SHALL serialize lifecycle transitions to prevent the Continuous_Enforcement_Loop from being started twice concurrently.
2. WHEN `stop()` is called while a `start()` is still initializing, THE Continuous_Enforcement_Loop SHALL complete the stop cleanly without leaving orphaned timers.
3. WHEN the Kill_Switch hide-all-windows action races with a user-initiated window show, THE Continuous_Enforcement_Loop SHALL ensure the hide operation takes precedence by using a monotonic enforcement-epoch counter.
4. THE Continuous_Enforcement_Loop SHALL use a single `running` state flag with atomic transitions to prevent concurrent start/stop calls from producing an inconsistent timer state.

### Requirement 3: Real Screen Share Detector

**User Story:** As a user, I want the application to detect when my screen is being shared, so that sensitive content can be hidden automatically during screen-sharing sessions.

#### Acceptance Criteria

1. THE Screen_Share_Detector SHALL implement 4 detection tiers ranked from highest to lowest confidence: native module detection (tier 1), TCC_Database probe (tier 2), process name matching (tier 3), and window-title matching (tier 4).
2. WHILE the platform is macOS, THE Screen_Share_Detector SHALL use all 4 detection tiers.
3. WHILE the platform is Windows or Linux, THE Screen_Share_Detector SHALL use process-name matching only and emit an "invisibility unverified" warning via the application's notification system visible in the UI.
4. WHEN at least one detection tier confirms an active screen-sharing session during a detection cycle, THE Screen_Share_Detector SHALL emit a `share-started` event if the previous state was not-sharing.
5. WHEN no detection tier confirms an active screen-sharing session for 3 consecutive detection cycles, THE Screen_Share_Detector SHALL emit a `share-ended` event if the previous state was sharing.
6. THE Screen_Share_Detector SHALL report detection confidence as the highest-ranked tier (lowest tier number) that confirmed the share state in the current detection cycle.
7. THE Screen_Share_Detector SHALL execute detection cycles via a Handler registered with the Tick_Coordinator at a Cadence corresponding to a 2-second polling interval.

### Requirement 3B: Screen Share Detector Concurrency Safety

**User Story:** As a developer, I want the Screen Share Detector to handle concurrent detection tier results safely, so that overlapping tier completions do not produce inconsistent share state.

#### Acceptance Criteria

1. WHEN multiple detection tiers complete concurrently, THE Screen_Share_Detector SHALL aggregate results atomically before emitting a state-change event.
2. WHILE a detection cycle is in progress, THE Screen_Share_Detector SHALL reject or queue a new detection cycle to prevent overlapping state mutations.
3. WHEN a `share-started` event emission races with a `share-ended` event, THE Screen_Share_Detector SHALL use a monotonic sequence number to ensure only the latest state is emitted.
4. IF a detection tier times out, THEN THE Screen_Share_Detector SHALL proceed with results from completed tiers without blocking on the timed-out tier.

### Requirement 4: Complete Monitoring Detector

**User Story:** As a user, I want comprehensive detection of enterprise monitoring tools across multiple detection layers, so that the application can protect my privacy against a wide range of surveillance software.

#### Acceptance Criteria

1. THE Monitoring_Detector SHALL implement 4 detection layers: process name matching, window title matching, filesystem artifact scanning, and launch agent inspection.
2. THE Signature_Database SHALL contain signatures for at least 22 known monitoring and proctoring tools including Teramind, ActivTrak, Honorlock, and Proctorio.
3. WHEN the same monitoring tool is detected by multiple layers, THE Monitoring_Detector SHALL deduplicate the results and report the tool only once with the highest-confidence detection source.
4. THE Signature_Database SHALL be stored as a JSON file that can be updated independently of application code.
5. WHEN a filesystem artifact or launch agent is detected, THE Monitoring_Detector SHALL include the detection layer in the threat report.

### Requirement 5: Centralize Periodic Ticks

**User Story:** As a developer, I want all existing `setInterval` owners migrated to the Tick_Coordinator, so that the application has a single source of periodic scheduling.

#### Acceptance Criteria

1. WHEN the Tick_Coordinator is started, THE StealthManager watchdog SHALL be dispatched via the Tick_Coordinator instead of its own `setInterval`.
2. WHEN the Tick_Coordinator is started, THE SCStream monitor SHALL be dispatched via the Tick_Coordinator instead of its own `setInterval`.
3. WHEN the Tick_Coordinator is started, THE CGWindow monitor SHALL be dispatched via the Tick_Coordinator instead of its own `setInterval`.
4. WHEN the Tick_Coordinator is started, THE ChromiumCaptureDetector SHALL be dispatched via the Tick_Coordinator instead of its own `setInterval`.
5. WHEN the Tick_Coordinator is started, THE Continuous_Enforcement_Loop timers SHALL be dispatched via the Tick_Coordinator instead of their own `setInterval` calls.
6. THE application SHALL have no more than 1 active `setInterval` for stealth-related periodic work after migration is complete.

### Requirement 5B: Tick Migration Concurrency Safety

**User Story:** As a developer, I want the tick migration to preserve the existing concurrency guarantees of each migrated component, so that no new race conditions are introduced.

#### Acceptance Criteria

1. WHEN the StealthManager watchdog is dispatched via the Tick_Coordinator, THE Tick_Coordinator SHALL respect the existing watchdog pause-token mechanism to prevent dispatch during verification.
2. WHEN the Continuous_Enforcement_Loop handlers are dispatched via the Tick_Coordinator, THE per-handler "is-running" guards SHALL prevent concurrent execution of the same enforcement check.
3. WHEN the ChromiumCaptureDetector is dispatched via the Tick_Coordinator, THE existing re-entry guard (`running` flag) SHALL continue to prevent overlapping detection cycles.
4. WHEN multiple migrated handlers are scheduled for the same tick, THE Tick_Coordinator SHALL dispatch them sequentially within a single tick to prevent shared-state contention between handlers that access StealthManager state.

### Requirement 6: Tighten Capture Tool Patterns

**User Story:** As a user, I want fewer false-positive capture-tool detections, so that the application does not unnecessarily hide windows when benign processes are running.

#### Acceptance Criteria

1. THE Capture_Tool_Patterns SHALL exclude the following noisy false-positive patterns: `coreaudiod`, `chrome`, `screenshot`, and `airplay`.
2. THE Capture_Tool_Patterns SHALL be consolidated from the current 50+ individual regex entries into a single combined regex pattern.
3. WHEN a process name matches an ambiguous pattern, THE StealthManager SHALL additionally verify the process executable path before classifying the process as a capture tool.
4. THE combined regex pattern SHALL match all legitimate capture tools that were matched by the previous individual patterns, excluding the removed false-positive entries.

### Requirement 7: Sandbox Screen RAG Cache

**User Story:** As a user, I want screen capture artifacts stored in a secure temporary location and deleted immediately after processing, so that no sensitive on-disk artifacts persist at rest.

#### Acceptance Criteria

1. THE Screen_RAG_Manager SHALL write temporary capture files to `os.tmpdir()` with a random prefix instead of the `userData` directory.
2. WHEN OCR processing completes for a capture file, THE Screen_RAG_Manager SHALL unlink the file immediately (zero on-disk artifacts at rest).
3. WHEN the Screen_RAG_Manager `dispose()` method is called, THE Screen_RAG_Manager SHALL delete all remaining temporary files in its sandbox directory.
4. WHEN the application emits a `before-quit` event, THE Screen_RAG_Manager SHALL delete all remaining temporary files in its sandbox directory.
5. IF a temporary file cannot be deleted, THEN THE Screen_RAG_Manager SHALL log a warning and continue operation without throwing.

### Requirement 7B: Screen RAG Cache Concurrency Safety

**User Story:** As a developer, I want the Screen RAG cache sandbox to handle concurrent capture-and-delete operations safely, so that file operations do not race against each other.

#### Acceptance Criteria

1. WHEN a capture file is being written while a concurrent `dispose()` call is cleaning up, THE Screen_RAG_Manager SHALL not attempt to unlink a file that is still being written.
2. WHEN multiple OCR operations complete concurrently, THE Screen_RAG_Manager SHALL unlink each file independently without corrupting the active-file tracking set.
3. WHEN `before-quit` cleanup races with an in-progress capture-OCR-unlink cycle, THE Screen_RAG_Manager SHALL wait for the in-progress cycle to complete before performing final cleanup.
4. THE Screen_RAG_Manager SHALL track active file paths in a concurrency-safe collection to prevent double-unlink attempts.

### Requirement 8: ScreenRAG Threshold and Event-Driven Redesign

**User Story:** As a user, I want ScreenRAG to activate automatically after I take screenshots during a meeting, so that contextual intelligence is available without manual activation.

#### Acceptance Criteria

1. WHEN 3 screenshots are taken within the current meeting or session, THE Screen_RAG_Manager SHALL auto-activate passive sampling at a cadence of 1 sample per Tick_Coordinator cycle allocated to the intelligence-lane.
2. WHEN the meeting or session ends (signaled by the application's session-lifecycle event), THE Screen_RAG_Manager SHALL stop passive sampling and reset the screenshot counter to zero.
3. WHILE the Screen_RAG_Manager is active, THE Screen_RAG_Manager SHALL perform passive sampling only on intelligence-lane idle ticks provided by the Tick_Coordinator (ticks where no higher-priority handler is executing on that lane), not via a dedicated timer.
4. WHILE the application window is hidden, the OS screen is locked, or a screen-share is detected by the Screen_Share_Detector, THE Screen_RAG_Manager SHALL skip the current sampling tick without incrementing any retry or backoff counter.
5. WHEN a passive sampling tick captures a screen frame, THE Screen_RAG_Manager SHALL execute OCR in the background Lane provided by AccelerationManager and complete or timeout within 10 seconds.
6. IF OCR processing exceeds the 10-second timeout, THEN THE Screen_RAG_Manager SHALL cancel the operation, discard the partial result, and remain available for the next sampling tick.

### Requirement 8B: ScreenRAG Threshold Concurrency Safety

**User Story:** As a developer, I want the ScreenRAG threshold counter and activation state to be race-condition-free, so that rapid screenshot events do not cause double-activation or missed activations.

#### Acceptance Criteria

1. WHEN multiple screenshot events arrive in rapid succession, THE Screen_RAG_Manager SHALL increment the counter atomically and activate exactly once upon reaching the threshold of 3.
2. WHEN a meeting-end event races with a screenshot event, THE Screen_RAG_Manager SHALL use a state lock to ensure the counter is either incremented-then-reset or reset-then-incremented, never corrupted.
3. WHILE a passive sampling tick is executing OCR in the background Lane, THE Screen_RAG_Manager SHALL not start a second OCR operation for the same tick (idempotent tick handling).

### Requirement 9: Disable DevTools in Production

**User Story:** As a developer, I want DevTools access blocked in production builds, so that end users cannot inspect or tamper with the application internals.

#### Acceptance Criteria

1. WHILE the application is running as a packaged build, THE DevTools_Lockdown SHALL intercept and block keyboard shortcuts Ctrl+Shift+I, Cmd+Opt+I, and F12.
2. WHILE the application is running as a packaged build, THE DevTools_Lockdown SHALL close DevTools if they are opened by any means.
3. WHEN the environment variable `NATIVELY_ALLOW_DEVTOOLS` is set to `1`, THE DevTools_Lockdown SHALL permit DevTools access regardless of build type.
4. THE DevTools_Lockdown SHALL be implemented as a centralized helper module at `electron/utils/lockdownDevtools.ts`.
5. WHILE the application is running in development mode (not packaged), THE DevTools_Lockdown SHALL not restrict DevTools access.

### Requirement 10: New Tests

**User Story:** As a developer, I want comprehensive test coverage for all new stealth hardening components, so that regressions are caught early and behavior is verified.

#### Acceptance Criteria

1. THE test suite SHALL include a test file for the Tick_Coordinator verifying registration, cadence dispatch, per-id serialization, and error isolation.
2. THE test suite SHALL include a test file for the Continuous_Enforcement_Loop AppState lifecycle integration verifying start-on-enable and stop-on-disable behavior.
3. THE test suite SHALL include a test file for the Screen_Share_Detector verifying multi-tier detection and cross-platform fallback behavior.
4. THE test suite SHALL include a test file for the Monitoring_Detector verifying multi-layer detection, JSON signature loading, and deduplication.
5. THE test suite SHALL include a test file for the centralized tick migration verifying that no independent `setInterval` calls remain for stealth work.
6. THE test suite SHALL include a test file for the tightened Capture_Tool_Patterns verifying false-positive exclusion and path-qualified matching.
7. THE test suite SHALL include a test file for the Screen_RAG_Manager sandbox verifying tmpdir usage, immediate unlink after OCR, and cleanup on dispose.
8. THE test suite SHALL include a test file for the ScreenRAG threshold verifying auto-activation after 3 screenshots and counter reset on meeting end.
9. THE test suite SHALL include a test file for the DevTools_Lockdown verifying shortcut blocking, DevTools closure, and environment variable override.
10. THE test suite SHALL include a test file for the Kill_Switch behavior verifying hide-all-windows default and quit-on-strict-mode.
