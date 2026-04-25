# Fail-Safe, Containment, Transparency, and Conscious Mode Implementation Plan

Date: 2026-04-24
Status: Ready for ticketing
Release boundary checked: v2.0.6 from remote tags
Scope: production release hardening for validated gaps only

## Re-Audit Summary

This plan is based on a second pass over the current source tree after the architectural review. Items below were included only where the code path was revalidated. Compatibility-sensitive surfaces are IPC contracts, persisted session/event data, helper wire protocols, and user-visible runtime behavior.

Validated release-blocking themes:

- Emergency/privacy shield state is not equivalent to containment.
- Stealth faults can originate from multiple channels without one authoritative state transition.
- Some supervisor and IPC fallback behavior can keep inference available after containment should have failed closed.
- Meeting/session persistence has race windows where state can be cleared, corrupted, or shut down out of order.
- Conscious mode has state/source ambiguity and overstates verifier certainty in metadata.

Not included as primary implementation tickets:

- Anti-detection/disguise hardening already tracked in existing stealth plans.
- General CSP/window sandbox hardening, except where it directly affects containment or IPC trust.
- Low-severity degraded UI behavior such as empty Ollama model lists unless it becomes part of observability work.

## Ticket Index

| Ticket | Title | Priority | Area | Depends On |
|---|---|---:|---|---|
| FS-001 | Centralize containment and make emergency hide fail closed | P0 | containment | none |
| FS-002 | Unify stealth fault ingestion through StealthSupervisor | P0 | stealth/recovery | FS-001 |
| FS-003 | Remove direct IPC inference bypass during containment/faults | P0 | IPC/inference | FS-001 |
| FS-004 | Preserve session/audit state on stealth fault | P0 | persistence/audit | FS-001 |
| FS-005 | Make meeting activation transactional | P1 | lifecycle/race | none |
| FS-006 | Await live RAG shutdown before closing database | P1 | shutdown/RAG | none |
| FS-007 | Add critical supervisor-bus observability and health gates | P1 | observability | FS-001 |
| FS-008 | Decide and enforce stealth-supervisor lifecycle policy | P1 | runtime/stealth | FS-002 |
| FS-009 | Add protected startup gate and visibility intent state | P0 | startup/privacy | FS-001, FS-002 |
| FS-010 | Make invisible-mode toggle a two-phase privacy transition | P1 | UX/privacy | FS-009 |
| CM-001 | Make conscious question source explicit | P0 | conscious mode | none |
| CM-002 | Buffer whole transcript handling during session restore | P0 | conscious/session | CM-001 |
| CM-003 | Report actual conscious verifier/provenance outcomes | P1 | transparency | CM-001 |
| CM-004 | Fix duplicate-suppression latency terminal state | P1 | metrics | none |
| CM-005 | Harden conscious thread continuation against self-reinforcement | P2 | conscious mode | CM-001 |
| AUD-001 | Expand event log to cover containment and conscious decisions | P1 | audit | FS-001, CM-003 |

## FS-001: Centralize Containment and Make Emergency Hide Fail Closed

Priority: P0
Severity: Critical
Validated: yes

Evidence:

- `electron/main/AppState.ts:355` emergency hide calls `hideMainWindow()` and `setPrivacyShieldFault(...)`.
- `electron/main/AppState.ts:2862` `setPrivacyShieldFault()` only sets `privacyShieldFaultReason`, syncs shield UI, and updates recovery.
- `electron/main/AppState.ts:2918` actual intelligence containment is only in `enforceStealthFaultContainment()`.
- `electron/IntelligenceEngine.ts:1746` `setStealthContainmentActive(true)` cancels active what-to-say and blocks auxiliary modes, but is not called from emergency hide.
- `electron/ipc/registerGeminiStreamIpcHandlers.ts:73` active stream controllers exist only inside IPC handler context and are not globally aborted by privacy shield.

Failure scenario:

1. User triggers `general:emergency-hide`.
2. Windows hide and privacy shield becomes active.
3. Active direct chat stream or suggestion path continues unless it was already routed through `stealth:fault` containment.
4. Tokens can continue flowing, assistant state can be updated, and usage can be persisted.
5. Operator sees "hidden" state but not "contained" state.

Minimal fix:

- Add a single `activateContainment(source, reason, options)` entry point in `AppState` or a new `ContainmentController`.
- Make `setPrivacyShieldFault()` call it for emergency and privacy shield faults.
- Abort all active IPC stream controllers through a main-owned stream registry.
- Keep shield UI update as a consequence of containment, not the primary action.

Robust fix:

- Introduce a `ContainmentController` that owns:
  - state: inactive, active, recovering, cleared
  - reason/source/evidence
  - inference abort registry
  - privacy shield state
  - recovery eligibility
  - audit event emission
  - metrics and renderer notification
- All critical paths call this controller: emergency hide, stealth faults, helper faults, bus critical listener loss, visible capture warnings, renderer stealth runtime crash.

Tests:

- Unit: `setPrivacyShieldFault('emergency_hide')` activates intelligence containment.
- Unit: containment aborts direct IPC stream controllers and clears registry.
- Integration: trigger emergency hide during `gemini-chat-stream`; provider iteration aborts and no final assistant message is persisted.
- Regression: clearing containment after full recovery re-enables modes only after stealth state is valid.

Acceptance criteria:

- No inference path can continue after emergency hide unless explicitly whitelisted as local cleanup.
- Renderer receives one containment event with source, reason, and aborted stream count.
- Privacy shield active state and intelligence containment state cannot diverge.

## FS-002: Unify Stealth Fault Ingestion Through StealthSupervisor

Priority: P0
Severity: Critical
Validated: yes

Evidence:

- `electron/stealth/StealthManager.ts:1535` emits EventEmitter `stealth:fault` with `restore-exhausted`.
- `electron/main/AppState.ts:285` subscribes to `stealth-degraded`, not `StealthManager` `stealth:fault`.
- `electron/stealth/ContinuousEnforcementLoop.ts:155` emits bus `stealth:fault` directly.
- `electron/runtime/StealthSupervisor.ts:261` is the code path that transitions supervisor state to `FAULT` and emits bus fault.
- `electron/stealth/PrivacyShieldRecoveryController.ts:24` recovery requires `stealthState === 'FAULT'`.

Failure scenario:

1. Capture tool restore retries exhaust inside `StealthManager`.
2. `StealthManager` emits local `stealth:fault`.
3. `AppState` does not consume that local fault.
4. Privacy shield/recovery/containment may not activate.
5. Even direct bus faults can bypass `StealthSupervisor` state, so recovery eligibility can be false despite active shield/fault reason.

Minimal fix:

- Subscribe to `StealthManager` `stealth:fault` in `AppState` and route to `StealthSupervisor.reportFault(...)`.
- Replace direct bus `stealth:fault` emission in enforcement loops with `StealthSupervisor.reportFault(...)`.
- Make bus `stealth:fault` handler reconcile supervisor state and log when an external event bypasses the supervisor.

Robust fix:

- Create a typed `StealthFaultSource` and `StealthFaultEvidence`.
- Remove or deprecate local EventEmitter fault events from `StealthManager`.
- Make `StealthSupervisor` the only component allowed to emit `stealth:fault`.
- Recovery controller reads a canonical `StealthFaultSnapshot`.

Tests:

- Unit: `restore-exhausted` transitions supervisor to `FAULT` and activates containment.
- Unit: direct external bus fault is converted into supervisor `FAULT` or rejected with alert.
- Integration: helper disconnect, visible capture, restore exhausted, and runtime crash all produce identical state shape.

Acceptance criteria:

- There is exactly one canonical stealth fault transition path.
- Recovery eligibility always matches operator-visible fault state.
- No local EventEmitter fault path is unobserved.

## FS-003: Remove Direct IPC Inference Bypass During Containment or Supervisor Faults

Priority: P0
Severity: High
Validated: yes

Evidence:

- `electron/ipc/handlerContext.ts:66` tries to get the inference supervisor.
- `electron/ipc/handlerContext.ts:78` catches lookup failure and silently falls back to direct `appState.processingHelper.getLLMHelper()`.
- `electron/ipc/registerGeminiStreamIpcHandlers.ts:25` direct chat uses `getInferenceLlmHelper().chatWithGemini(...)`.
- `electron/ipc/registerGeminiStreamIpcHandlers.ts:85` streaming chat uses direct `llmHelper.streamChat(...)`.
- `electron/IntelligenceEngine.ts:2023` containment checks only protect `IntelligenceEngine` modes, not direct IPC chat.

Failure scenario:

1. Inference supervisor is faulted, unavailable, or containment is active.
2. Renderer invokes direct chat or streaming chat.
3. Handler falls back to direct LLM helper.
4. LLM request succeeds outside supervisor policy and containment observability.

Minimal fix:

- Replace silent fallback with explicit policy:
  - if containment active: reject with `CONTAINMENT_ACTIVE`
  - if supervisor unavailable in production: reject with `INFERENCE_SUPERVISOR_UNAVAILABLE`
  - allow direct fallback only in test/dev with visible log/metric.
- Move `activeChatControllers` ownership to a main-level registry accessible by containment.

Robust fix:

- Route every inference entry point through `InferenceSupervisor`.
- Add `InferenceSupervisor.canAcceptRequest(policyContext)` and `abortAll(reason)`.
- Require stream registration before provider call starts.

Tests:

- Unit: `getInferenceLlmHelper` does not fall back when containment active.
- IPC contract: `gemini-chat-stream` returns/sends containment error when containment active.
- Integration: supervisor missing in production rejects direct chat.
- Regression: dev/test fallback still works only when explicitly allowed.

Acceptance criteria:

- No production inference request can bypass supervisor policy.
- Containment aborts all active direct and supervised streams.
- Bypass attempts are counted by metric.

## FS-004: Preserve Session and Audit State on Stealth Fault

Priority: P0
Severity: High
Validated: yes

Evidence:

- `electron/main/AppState.ts:550` `InferenceSupervisor` delegate handles stealth fault with `intelligenceManager.reset()`.
- `electron/SessionTracker.ts:873` `reset()` clears transcript, usage, conscious stores, semantic cache, and session state.
- `electron/SessionTracker.ts:913` reset persists the cleared state under `previousMeetingId` before clearing `activeMeetingId`.

Failure scenario:

1. Stealth fault occurs during active meeting.
2. Inference supervisor receives bus fault and calls intelligence reset.
3. Session transcript/context/conscious stores are cleared.
4. Cleared state may be persisted for the active meeting ID.
5. Incident evidence and recovery context are lost.

Minimal fix:

- Replace `intelligenceManager.reset()` in stealth-fault handling with a targeted `enterContainment(reason)` method.
- That method cancels active inference and suppresses new output without clearing transcript/session/persistence.
- Add explicit incident/audit snapshot before any destructive state transition.

Robust fix:

- Split session operations into:
  - `cancelActiveWork`
  - `clearVolatileGenerationState`
  - `resetMeetingState`
  - `discardPersistentSession`
- Require a reason enum for any persistent reset.
- Block persistent reset while `currentMeetingId` is active unless called from end-meeting finalization.

Tests:

- Unit: stealth fault cancels active generation but preserves `fullTranscript`, `fullUsage`, and `activeMeetingId`.
- Integration: emit `stealth:fault` during active meeting and assert session persistence still contains prior transcript.
- Regression: explicit user reset still clears state and persists as designed.

Acceptance criteria:

- Stealth containment never deletes active meeting evidence.
- Any destructive session reset requires an explicit reason and is audit logged.

## FS-005: Make Meeting Activation Transactional

Priority: P1
Severity: High
Validated: yes

Evidence:

- `electron/main/AppState.ts:1812` sets `currentMeetingId` and `isMeetingActive` before deferred initialization.
- `electron/main/AppState.ts:1815` starts async restore via `ensureMeetingContext(...)` without awaiting.
- `electron/main/AppState.ts:1845` stale deferred start resolves without clearing active state.
- `electron/main/AppState.ts:1866` invalidated async initialization also resolves without clearing active state.

Failure scenario:

1. `startMeeting()` sets meeting active and meeting ID.
2. `endMeeting()` or another lifecycle transition invalidates `meetingStartSequence`.
3. Deferred start sees stale sequence and resolves.
4. Early active fields may remain inconsistent with runtime lifecycle.
5. Later transcript, RAG, or UI state can attach to a ghost meeting.

Minimal fix:

- In every stale/invalidated branch, clear `isMeetingActive`, `currentMeetingId`, and reset lifecycle to idle if this activation owns the transaction.
- Await or expose `ensureMeetingContext` restore completion before meeting becomes active.
- Emit activation rollback reason.

Robust fix:

- Add `MeetingActivationTransaction`:
  - owns meeting ID, sequence, abort signal, resources started
  - `prepare()`, `commit()`, `rollback(reason)`
  - only `commit()` publishes active state.
- RuntimeCoordinator and AppState should use the same transaction ID.

Tests:

- Unit: stale deferred branch rolls back all AppState fields.
- Unit: abort during audio reconfigure rolls back all fields.
- Integration: start/end race with delayed restore does not produce ghost active meeting.

Acceptance criteria:

- `isMeetingActive`, `currentMeetingId`, AppState lifecycle, and RuntimeCoordinator lifecycle cannot disagree after activation failure.

## FS-006: Await Live RAG Shutdown Before Closing Database

Priority: P1
Severity: High
Validated: yes

Evidence:

- `electron/main/AppState.ts:1954` correctly awaits `ragManager.stopLiveIndexing()` during normal end meeting.
- `electron/main/AppState.ts:2091` quit cleanup calls `stopLiveIndexing().catch(...)` without awaiting.
- `electron/main/AppState.ts:2105` closes `DatabaseManager` immediately after.

Failure scenario:

1. App quits during live indexing.
2. Quit cleanup starts live indexer stop/flush but does not await it.
3. SQLite closes while indexer may still write.
4. Flush can fail or partial RAG data can be lost.

Minimal fix:

- Await `this.ragManager?.stopLiveIndexing()` in `cleanupForQuit()`.
- Move virtual display/native helper disposal after all data writers stop.

Robust fix:

- Implement shutdown phases:
  - stop inputs
  - stop inference
  - flush session/checkpoint/RAG
  - close DB
  - dispose native helpers
- Track each phase with timeout and audit outcome.

Tests:

- Unit: `cleanupForQuit()` awaits live indexing before DB close.
- Fault injection: live indexer stop rejects; DB close still happens but error is recorded and visible.

Acceptance criteria:

- No database close occurs before all registered DB writers finish or timeout with visible failure.

## FS-007: Add Critical Supervisor-Bus Observability and Health Gates

Priority: P1
Severity: High
Validated: yes

Evidence:

- `electron/runtime/SupervisorBus.ts:109` `emit()` never throws.
- `electron/runtime/SupervisorBus.ts:148` emits `bus:listener-error`.
- `electron/runtime/SupervisorBus.ts:160` circuit-opens and unsubscribes failing listeners.
- Critical events include `stealth:fault` at `electron/runtime/SupervisorBus.ts:36`.

Failure scenario:

1. A containment listener throws repeatedly.
2. SupervisorBus isolates the error and eventually unsubscribes the listener.
3. Original emitter continues successfully.
4. Future stealth faults may miss a mandatory containment side effect.

Minimal fix:

- Add AppState subscriber for `bus:listener-error` and `bus:listener-circuit-open`.
- If source event is critical, activate containment and show operator alert.
- Add metric counters and release-gate tests.

Robust fix:

- Support mandatory listeners for critical events.
- Critical mandatory listener loss transitions runtime to degraded/faulted state.
- Add `SupervisorBusHealth` snapshot exposed to diagnostics.

Tests:

- Unit: critical listener circuit open activates containment.
- Unit: non-critical listener circuit open logs only.
- Integration: a failing `stealth:fault` listener cannot silently disable containment.

Acceptance criteria:

- Critical bus listener failure is operator-visible and fail-closed.

## FS-008: Decide and Enforce Stealth-Supervisor Lifecycle Policy

Priority: P1
Severity: Medium-high
Validated: yes

Evidence:

- `electron/runtime/RuntimeCoordinator.ts:46` managed supervisors default to `['recovery', 'audio', 'stt', 'inference']`.
- `electron/main/AppState.ts:570` registers `StealthSupervisor`, but meeting lifecycle does not start it.
- `electron/stealth/StealthManager.ts:381` `applyToWindow()` returns if not enabled, while `isEnabled()` can be true due to meeting-active state.
- `electron/main/AppState.ts:1882` sets `stealthManager.setMeetingActive(true)` after activation.

Failure scenario:

1. Meeting starts with capture protections expected.
2. `StealthManager` applies meeting-active protections.
3. `StealthSupervisor` may remain idle unless undetectable was explicitly toggled.
4. Heartbeat, canonical fault state, and recovery are not guaranteed.

Minimal fix:

- Define policy:
  - if `isUndetectable` or meeting capture protection is required, start StealthSupervisor during activation.
  - if stealth is optional, explicitly mark as unmonitored in diagnostics.
- Add activation failure if required stealth cannot start.

Robust fix:

- Add `ProtectionPolicy` with required/optional protections per mode.
- RuntimeCoordinator starts supervisors based on policy, not hardcoded default list.

Tests:

- Unit: meeting activation starts stealth supervisor when protection policy requires it.
- Unit: optional stealth path emits diagnostic that it is unmonitored.
- Integration: failure to start required stealth rolls back meeting activation.

Acceptance criteria:

- Every meeting has explicit stealth monitoring status: active, optional-unmonitored, or failed-closed.

## FS-009: Add Protected Startup Gate and Visibility Intent State

Priority: P0
Severity: Critical
Validated: yes

Brainstormed design direction:

- Do not use `openAsHidden: true` as the primary privacy mechanism. It can make the app hard to find on login and still does not prove that no sensitive renderer state exists.
- Do not use `openAsHidden: false` as-is either. It improves discoverability, but current startup, recovery, and error surfaces can visibly identify the app or expose non-shield UI during a screen share.
- Introduce a startup privacy gate that starts the app in a protected state, then reveals only the surface allowed by an explicit visibility intent.
- Treat invisible/privacy mode as the default startup intent when enabled in settings. Normal app UI should become visible only after the user explicitly toggles invisible mode off.
- While invisible/privacy mode is on, startup may create windows and initialize services, but renderer content must be blank shield or a non-sensitive local status surface. It must not render startup animation, branded copy, transcript content, assistant placeholders, model names, settings content, or errors.

Evidence:

- `electron/ipc/registerSettingsHandlers.ts:289` configures login startup with `openAsHidden: false`.
- `electron/main/bootstrap.ts:135` creates the main window during bootstrap.
- `src/App.tsx:207` renders `StartupSequence` during startup.
- `src/main.tsx:8` and `src/App.tsx:35` render visible startup error screens.
- `electron/WindowHelper.ts:337` force-reveals launcher on bootstrap timeout.

Failure scenario:

1. User has invisible/privacy mode enabled and app is configured to launch at login.
2. App starts while the user is already sharing their screen or shortly before a meeting starts.
3. Current login behavior can create and reveal a normal startup surface.
4. If bootstrap fails or times out, fallback UI can reveal app identity or error details.
5. If `openAsHidden: true` is used instead, the app becomes hard to discover and recover, but sensitive renderer state is still not formally gated by a privacy state machine.

Minimal fix:

- Add a `VisibilityIntentController` or equivalent state owned by main:
  - `boot_unknown`
  - `protected_hidden`
  - `protected_shield`
  - `visible_safe_controls`
  - `visible_app`
  - `faulted_shield`
- Load persisted invisible/privacy mode before creating any user-facing renderer surface.
- On startup, set intent to `protected_hidden` or `protected_shield` when invisible/privacy mode is enabled.
- Only transition to `visible_app` after the user explicitly toggles invisible/privacy mode off.
- Replace startup animation and startup error screens with privacy shield content whenever intent is not `visible_app`.
- Move detailed startup errors to logs/diagnostics instead of renderer text while protected.
- Make `openAsHidden` a UX preference derived from visibility intent, not the safety boundary.

Robust fix:

- Make all window helpers require a `VisibilityIntentSnapshot` before `show()`.
- Add renderer boot props that include `allowedSurface: shield | safe_controls | full_app`.
- Enforce a renderer-side guard that refuses to mount full app routes unless `allowedSurface === 'full_app'`.
- Convert force-reveal fallback into force-shield fallback. If bootstrap readiness is unknown, show shield or remain hidden; never reveal launcher UI as recovery.
- Add a non-sensitive recovery path for users who cannot find the app after login, such as an explicit menu/shortcut action that toggles invisible mode off and commits `visible_app`.

Tests:

- Unit: login startup with invisible/privacy mode enabled sets visibility intent to `protected_hidden` or `protected_shield`, never `visible_app`.
- Unit: startup timeout transitions to `faulted_shield`, not launcher reveal.
- Renderer: protected startup does not mount `StartupSequence`, settings text, transcript text, model names, assistant placeholders, or startup error copy.
- Integration: app launched at login with invisible/privacy enabled produces only shield-safe pixels before user toggle.
- Regression: app launched with invisible/privacy disabled still opens normally, with content protection applied before show where supported.

Acceptance criteria:

- No sensitive or branded app UI renders before `visible_app` intent is committed.
- Invisible/privacy mode survives relaunch and blocks full UI on startup until explicitly toggled off.
- `openAsHidden` is not documented or relied on as the privacy guarantee.
- Startup failure, bootstrap timeout, and renderer crash all fail closed to shield/hidden state.

## FS-010: Make Invisible-Mode Toggle a Two-Phase Privacy Transition

Priority: P1
Severity: High
Validated: yes

Brainstormed design direction:

- The toggle should be an explicit privacy transition, not just a renderer visibility event.
- Turning invisible/privacy mode on should blank or hide sensitive UI before any animation, resize, or delayed hide path.
- Turning invisible/privacy mode off should reveal normal UI only after main and renderer agree on the new visibility intent.
- The user needs a reliable way to recover visibility after startup, but that recovery path must be intentional and must not auto-reveal sensitive content.

Evidence:

- `electron/main/AppState.ts:2454` sends `toggle-expand` to the current content window instead of directly committing a privacy state.
- `src/components/NativelyInterface.tsx:371` delays `hideWindow()` by about 400ms when collapsed.
- `src/components/NativelyInterface.tsx:928` creates a visible assistant placeholder before IPC response completion.
- `electron/main/AppState.ts:355` emergency hide is direct and closer to the desired fail-closed behavior.

Failure scenario:

1. User toggles invisible/privacy mode while a response panel or startup surface is visible.
2. Main process sends a UI event, but renderer animation/timing controls when hiding occurs.
3. For a short interval, assistant panel, placeholder, canceled message, or startup UI can remain visible.
4. If the current renderer is launcher/settings rather than the main interface, the toggle event may not reach a mounted handler.

Minimal fix:

- Add `requestVisibilityIntent(nextIntent, source)` in main.
- For invisible/privacy mode on:
  - synchronously clear sensitive renderer state
  - activate shield
  - hide or shield windows directly from main
  - abort/suppress active response rendering
- For invisible/privacy mode off:
  - clear shield fault only if startup and stealth/protection state are valid
  - commit `visible_app`
  - then reveal the appropriate window
- Replace delayed renderer hide with an immediate main-owned hide/shield path for privacy transitions.

Robust fix:

- Model transition phases:
  - `requested`
  - `blanking`
  - `main_committed`
  - `renderer_acknowledged`
  - `visible_or_hidden`
  - `failed_closed`
- Require renderer acknowledgement before showing full app UI after invisible/privacy mode is turned off.
- Add a timeout that returns to `faulted_shield` if renderer acknowledgement does not arrive.
- Use the same path for startup, tray/menu action, global shortcut, emergency hide, and settings toggle.

Tests:

- Unit: toggling invisible/privacy on immediately activates shield before delayed UI paths can run.
- Unit: toggle event works regardless of current surface: launcher, overlay, settings, model selector, or startup.
- Renderer: assistant placeholder and canceled/error response text are cleared when privacy transition starts.
- Integration: rapid toggle on/off during streaming response never leaves response text visible after protected intent is committed.
- Regression: emergency hide and invisible/privacy toggle share the same containment/shield primitives.

Acceptance criteria:

- Turning invisible/privacy mode on is fail-closed and immediate from main's perspective.
- Turning invisible/privacy mode off is the only path that reveals full app UI after protected startup.
- No renderer animation or delayed callback controls the privacy boundary.
- Users can recover visibility intentionally without auto-revealing sensitive startup or response state.

## CM-001: Make Conscious Question Source Explicit

Priority: P0
Severity: High
Validated: yes

Evidence:

- `electron/IntelligenceEngine.ts:963` derives `baseQuestion = question || interimQuestion || lastInterviewer`.
- `electron/IntelligenceEngine.ts:1025` separately fetches `lastInterviewerTurn`.
- `electron/conscious/ConsciousPreparationCoordinator.ts:245` uses `input.lastInterviewerTurn || input.resolvedQuestion` for state block.
- The same stale-first pattern is used for live RAG, long memory, planning, and semantic block at lines 248, 253, 256, and 277.

Failure scenario:

1. Last interviewer turn is "design a rate limiter".
2. User manually asks a different question.
3. `resolvedQuestion` is manual question, but preparation uses stale `lastInterviewerTurn`.
4. Planning, memory, and verifier context are grounded on the wrong question.

Minimal fix:

- Add `QuestionContext`:
  - `text`
  - `source`: auto_final, manual, interim_substitution, screenshot, followup
  - `transcriptRevision`
  - `speakerTurnTimestamp`
- In preparation, prefer `resolvedQuestion` for manual/screenshot sources.

Robust fix:

- Replace loose string arguments across conscious path with `QuestionContext`.
- Require all route, planning, retrieval, and metadata functions to carry source and revision.

Tests:

- Unit: manual question with stale last interviewer turn plans against manual text.
- Unit: auto-trigger still uses final interviewer text.
- Integration: metadata includes question source and transcript revision.

Acceptance criteria:

- Conscious route decisions and evidence hashes are tied to the same question source.

## CM-002: Buffer Whole Transcript Handling During Session Restore

Priority: P0
Severity: High
Validated: yes

Evidence:

- `electron/main/AppState.ts:1815` calls `ensureMeetingContext()` and does not await restore.
- `electron/session/sessionPersistence.ts:351` starts restore asynchronously.
- `electron/SessionTracker.ts:250` `addTranscript()` buffers writes when restoring.
- `electron/SessionTracker.ts:433` `handleTranscript()` still mutates observed question, hypothesis, thread, preference, and design stores after `addTranscript()`.

Failure scenario:

1. Meeting starts and async restore is in progress.
2. Final interviewer transcript arrives.
3. Transcript write is buffered, but conscious stores mutate immediately against pre-restore state.
4. Restore applies old persisted state and then buffered transcript write.
5. Conscious state can be out of order or mixed across sessions.

Minimal fix:

- If `isRestoring`, buffer the entire `handleTranscript()` operation, not only `addTranscript()`.
- Expose `await ensureMeetingContextReady()` and use it before activation commit.

Robust fix:

- Session restore becomes a transaction gate for all session mutations.
- Meeting activation cannot become active until restore completes or explicitly times out with a clean empty session.

Tests:

- Unit: final interviewer transcript during restore does not mutate conscious stores until restore finishes.
- Integration: delayed restore plus transcript produces deterministic transcript revision and thread state.

Acceptance criteria:

- No conscious store mutation occurs outside restore ordering.

## CM-003: Report Actual Conscious Verifier and Provenance Outcomes

Priority: P1
Severity: High
Validated: yes

Evidence:

- `electron/IntelligenceEngine.ts:1394` hardcodes verifier deterministic/provenance pass for continuation.
- `electron/IntelligenceEngine.ts:1506` hardcodes pass for fresh conscious answer.
- `electron/IntelligenceEngine.ts:416` judge requirement can be false when structured generation capability is unavailable.
- `electron/conscious/ConsciousVerifier.ts:173` returns rule verdict when judge is unavailable and not required.
- `electron/conscious/ConsciousProvenanceVerifier.ts:255` allows open-ended responses with no strict grounding when no tech/metric claims are detected.

Failure scenario:

1. Conscious answer succeeds with deterministic rules only, judge skipped.
2. Metadata reports verifier/provenance pass.
3. Operator cannot distinguish fully judged answer from degraded local-rule answer.

Minimal fix:

- Extend verifier result to include:
  - deterministic: pass/fail/skipped
  - judge: pass/fail/skipped
  - provenance: pass/fail/skipped
  - reasons
- Return these results from `ConsciousOrchestrator`.
- Build metadata from actual results.

Robust fix:

- Add confidence/calibration score and action policy:
  - low certainty: answer may be shown but marked degraded
  - unsupported grounding: fallback or ask clarification
  - judge unavailable: visible degraded mode

Tests:

- Unit: judge unavailable metadata says judge skipped.
- Unit: provenance open-ended pass still records strict grounding absence.
- Integration: latency tracker stores actual verifier outcome, not hardcoded pass.

Acceptance criteria:

- No conscious metadata claims pass for a verifier stage that did not run.

## CM-004: Fix Duplicate-Suppression Latency Terminal State

Priority: P1
Severity: Medium
Validated: yes

Evidence:

- `electron/conscious/ConsciousResponseCoordinator.ts:50` suppresses duplicate answer.
- `electron/conscious/ConsciousResponseCoordinator.ts:57` comment states no latency completion is intentional.
- Normal path completes latency at `electron/conscious/ConsciousResponseCoordinator.ts:100`.

Failure scenario:

1. Duplicate conscious answer is suppressed.
2. Latency tracker request remains in flight.
3. Metrics and active request snapshots drift over time.

Minimal fix:

- Add `latencyTracker.completeSuppressed(requestId, reason)` or complete with terminal status `suppressed`.

Robust fix:

- Model latency lifecycle terminal states: completed, canceled, stale, fallback, suppressed, failed.
- Release-gate asserts no request remains in flight after any response coordinator path.

Tests:

- Unit: duplicate suppression completes latency with suppressed terminal status.
- Regression: no token/final/session/usage emission for duplicate remains true.

Acceptance criteria:

- Duplicate suppression is terminal and visible in metrics.

## CM-005: Harden Conscious Thread Continuation Against Self-Reinforcement

Priority: P2
Severity: Medium
Validated: yes

Evidence:

- `electron/conscious/ConsciousOrchestrator.ts:196` allows short referential follow-up with zero token overlap.
- `electron/conscious/ConsciousThreadStore.ts:114` continuation merges previous response into active thread response.
- `electron/ConsciousMode.ts:550` broad active-thread classifier continues many question-like turns.

Failure scenario:

1. Active thread discusses one system design topic.
2. User or interviewer shifts topic with ambiguous short phrase.
3. Classifier treats it as continuation.
4. Merged response increases overlap vocabulary over time, making future continuation more likely.

Minimal fix:

- Store immutable root-topic tokens separately from accumulated response tokens.
- Require either explicit continuation phrase, overlap with root-topic tokens, or high-confidence intent continuation.

Robust fix:

- Move thread transitions into `ThreadDirector` by default.
- Emit thread transition reason, confidence, old/new thread IDs.
- Add adversarial eval set for topic shift and ambiguous follow-ups.

Tests:

- Unit: short referential phrase after explicit topic shift resets or ignores, not continue.
- Unit: accumulated response tokens do not affect compatibility with unrelated topic.
- Eval: noisy/contradictory transcript set keeps false continuation rate below threshold.

Acceptance criteria:

- Continuation requires evidence tied to stable thread identity, not accumulated self-generated text.

## AUD-001: Expand Event Log to Cover Containment and Conscious Decisions

Priority: P1
Severity: Medium-high
Validated: yes

Evidence:

- `electron/session/sessionPersistence.ts:250` appends transcript events only.
- `electron/SessionTracker.ts:548` records conscious response/thread action but only emits supervisor bus event.
- `electron/memory/SessionPersistence.ts:374` `snapshotEvents()` overwrites event log with a single checkpoint event.

Failure scenario:

1. Conscious mode changes thread or emits verified answer.
2. Containment activates or recovery clears shield.
3. Only transient bus/UI events exist.
4. Post-incident audit cannot reconstruct why a mode changed or why output was allowed/suppressed.

Minimal fix:

- Add append-only events:
  - `containment_activated`
  - `containment_cleared`
  - `stealth_fault`
  - `conscious_route_decision`
  - `conscious_thread_action`
  - `conscious_verifier_result`
  - `inference_aborted`
- Do not overwrite raw event logs during snapshot; compact to separate checkpoint file or preserve pre-snapshot events.

Robust fix:

- Treat session event log as source of truth for audit.
- Add schema version and migration for events since v2.0.6 may have released persisted session state.
- Add exportable diagnostics bundle.

Tests:

- Unit: each containment transition appends durable event.
- Unit: conscious response records route, thread action, verifier outcome, question source.
- Regression: snapshot does not destroy raw audit trail.
- Compatibility: older session event logs replay without migration failure.

Acceptance criteria:

- A production incident can be reconstructed from durable local events without relying on console logs.

## Validation Commands

Run before merging implementation work:

```bash
npm run typecheck
npm run test:electron
npm run test:renderer
npm run verify:production
```

Targeted tests to add/run as work lands:

```bash
npm run test:electron -- --test-name-pattern containment
npm run test:electron -- --test-name-pattern stealth
npm run test:electron -- --test-name-pattern SessionTracker
npm run test:electron -- --test-name-pattern Conscious
```

## Rollout Order

1. FS-001, FS-003, FS-004: close the most dangerous "hidden operation after shield/fault" blast radius.
2. FS-002, FS-007, FS-008: make stealth faults and supervisor health canonical and visible.
3. FS-005, FS-006: remove lifecycle and shutdown data-loss races.
4. CM-001, CM-002, CM-003, CM-004: make conscious mode source, restore ordering, and verifier metadata reliable.
5. CM-005, AUD-001: improve long-term interpretability and auditability.

## Compatibility Notes

- Latest release boundary is `v2.0.6`.
- IPC behavior changes should preserve existing channel names but return explicit typed failures rather than silent fallback success.
- Persisted event/session schema additions must be backward-compatible for existing sessions.
- New audit event fields should be optional when replaying older logs.
- Avoid deleting or renaming existing persisted files as part of these tickets.



--- commit 90ca0b99506f497c6868728166f4ad2c55e7fad1 ---

# Natively — Hardening Implementation Plan

> Tickets derived from verified audit findings. Ignored findings (C3, C4, C6, C8, C9, C10, C12) are excluded.

---

## Ticket Index

| Ticket | Finding | Severity | File(s) |
|--------|---------|----------|---------|
| [NAT-H1](#nat-h1) | C1 — `process.exit()` with zero cleanup | CRITICAL | `processFailure.ts`, `logging.ts` |
| [NAT-H2](#nat-h2) | C2 — `reconfigureAudio` error paths leave audio dead | HIGH | `AppState.ts` |
| [NAT-H3](#nat-h3) | C5 — `UnsafeCell` in `sck.rs` is unsound | HIGH | `native-module/src/speaker/sck.rs` |
| [NAT-H4](#nat-h4) | C11 — Audio self-healing exhaustion with no user recovery | HIGH | `AppState.ts` |

---

## NAT-H1 — Graceful Shutdown Manager

### Problem

[processFailure.ts:12-48](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/processFailure.ts#L12-L48) calls `process.exit()` after a 3 s log-flush timeout. Any uncaught exception instantly kills the process with:
- In-flight DB writes abandoned
- Active session transcript lost
- Audio stream not torn down (leaves native handles open)
- No IPC notification to renderer (spinner frozen)

[logging.ts:13-23](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/logging.ts#L13-L23) wires **both** `uncaughtException` and `unhandledRejection` directly into this path.

### Solution: `GracefulShutdownManager`

Create a singleton that collects shutdown hooks and replaces the bare `process.exit` call.

#### [NEW] `electron/GracefulShutdownManager.ts`

```typescript
type ShutdownHook = () => Promise<void>;

class GracefulShutdownManager {
  private static instance: GracefulShutdownManager | null = null;
  private hooks: Array<{ name: string; fn: ShutdownHook }> = [];
  private shuttingDown = false;

  static getInstance(): GracefulShutdownManager {
    if (!GracefulShutdownManager.instance) {
      GracefulShutdownManager.instance = new GracefulShutdownManager();
    }
    return GracefulShutdownManager.instance;
  }

  /**
   * Register a cleanup hook. Hooks run in registration order.
   * Each hook has 2s to complete before it is abandoned.
   */
  register(name: string, fn: ShutdownHook): void {
    this.hooks.push({ name, fn });
  }

  /**
   * Run all hooks then exit. Safe to call multiple times — only
   * the first call executes; subsequent calls are no-ops.
   */
  async shutdown(code: number, reason: string): Promise<never> {
    if (this.shuttingDown) {
      // Already in progress — just wait for the process to die
      await new Promise(() => {});
      process.exit(code); // unreachable, satisfies TS
    }
    this.shuttingDown = true;
    console.error(`[GracefulShutdown] Initiating (code=${code}): ${reason}`);

    const HOOK_TIMEOUT_MS = 2000;
    for (const hook of this.hooks) {
      try {
        await Promise.race([
          hook.fn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), HOOK_TIMEOUT_MS)
          ),
        ]);
        console.log(`[GracefulShutdown] Hook "${hook.name}" done`);
      } catch (err) {
        console.error(`[GracefulShutdown] Hook "${hook.name}" failed/timed-out:`, err);
      }
    }

    console.error(`[GracefulShutdown] Exiting with code ${code}`);
    process.exit(code);
  }
}

export const gracefulShutdown = GracefulShutdownManager.getInstance();
```

#### [MODIFY] `electron/main/logging.ts` — wire shutdown manager

```diff
-import { exitAfterCriticalFailure } from '../processFailure'
+import { gracefulShutdown } from '../GracefulShutdownManager'

 process.on('uncaughtException', (err) => {
-  void exitAfterCriticalFailure(
-    logToFileAsync('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err)),
-  )
+  void logToFileAsync('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err))
+    .catch(() => undefined)
+    .finally(() => gracefulShutdown.shutdown(1, `uncaughtException: ${err.message}`))
 });

 process.on('unhandledRejection', (reason, promise) => {
-  void exitAfterCriticalFailure(
-    logToFileAsync('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason)),
-  )
+  const msg = reason instanceof Error ? reason.stack : String(reason);
+  void logToFileAsync('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + msg)
+    .catch(() => undefined)
+    .finally(() => gracefulShutdown.shutdown(1, `unhandledRejection: ${msg}`))
 });
```

#### [MODIFY] `electron/main/AppState.ts` — register hooks at startup

In `prepareMeetingActivation` or the app `ready` handler, after building AppState:

```typescript
import { gracefulShutdown } from '../GracefulShutdownManager';

// After AppState is constructed:
gracefulShutdown.register('session-flush', async () => {
  await this.intelligenceManager?.flushPersistenceNow?.();
});

gracefulShutdown.register('audio-teardown', async () => {
  this.systemAudioCapture?.removeAllListeners();
  this.systemAudioCapture?.destroy();
  this.microphoneCapture?.removeAllListeners();
  this.microphoneCapture?.destroy();
  this.googleSTT?.stop();
  this.googleSTT_User?.stop();
});

gracefulShutdown.register('db-flush', async () => {
  await this.meetingPersistence?.flush?.();
});
```

### Verification
- Throw an uncaught error in dev mode; confirm hooks log + session file is updated on disk before process dies.
- Confirm renderer receives a final IPC `meeting-lifecycle-state: 'idle'` or equivalent.

---

## NAT-H2 — `reconfigureAudio` Error-Path Hardening

### Problem

[AppState.ts:1505-1650](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L1505-L1650) `reconfigureAudio` has two independent try/catch blocks for system audio and microphone. If the **preferred device** fails and the **default device fallback** also fails, the code silently swallows the error (`console.error` only) and leaves `this.systemAudioCapture = null` / `this.microphoneCapture = null`. The caller at [AppState.ts:1310](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L1310) then sets `nativeAudioConnected = true` on the optimistic path regardless.

Additionally, `reconfigureAudio` creates new capture objects and wires listeners, but **never calls `.start()`** on the native capture handles — `start()` is expected to be called by the caller's pipeline, but the recovery path at line 1310 only calls `reconfigureAudio()` and `setNativeAudioConnected(true)` without explicitly ensuring the pipeline is started.

### Exact Changes

#### [MODIFY] `electron/main/AppState.ts` — `reconfigureAudio` must throw on total failure

```diff
     } catch (err2) {
       console.error('[Main] Failed to initialize SystemAudioCapture (Default):', err2);
+      // Both preferred and default failed — propagate so the recovery loop
+      // can count this as a failed attempt and notify the user correctly.
+      throw new Error(`SystemAudioCapture unavailable: ${err2 instanceof Error ? err2.message : err2}`);
     }
```

```diff
     } catch (err2) {
       console.error('[Main] ❌ Failed to initialize MicrophoneCapture (Default):', err2);
+      throw new Error(`MicrophoneCapture unavailable: ${err2 instanceof Error ? err2.message : err2}`);
     }
```

#### [MODIFY] `AppState.ts` — guarantee `start()` is called after reconfigure

After `reconfigureAudio()` completes successfully, the recovery path must explicitly start the capture handles. Replace the call at line 1310:

```diff
-        await this.reconfigureAudio();
-        console.log(`[Main] ${noun} recovered successfully on attempt ${attempt}`);
-        this.setNativeAudioConnected(true);
+        await this.reconfigureAudio();
+        // Explicitly start capture handles — reconfigureAudio only wires listeners.
+        this.systemAudioCapture?.start?.();
+        this.microphoneCapture?.start?.();
+        this.googleSTT?.start();
+        this.googleSTT_User?.start();
+        console.log(`[Main] ${noun} recovered successfully on attempt ${attempt}`);
+        // Reset counter so a future independent error gets a full 3 attempts.
+        this.audioRecoveryAttempts = 0;
+        this.setNativeAudioConnected(true);
```

#### [MODIFY] `AppState.ts` — surface failure to user on partial success

```diff
       } catch (recoveryErr) {
         console.error(`[Main] ${noun} recovery attempt ${attempt} failed:`, recoveryErr);
         if (this.audioRecoveryAttempts >= this.MAX_AUDIO_RECOVERY_ATTEMPTS) {
           this.broadcast('meeting-audio-error', failureMessage);
+          // Also broadcast a UI-visible status so user can act (reconnect device, restart)
+          this.broadcast('meeting-audio-degraded', {
+            source,
+            attempts: this.audioRecoveryAttempts,
+            message: failureMessage,
+          });
         }
```

### Verification
- Simulate `SystemAudioCapture` constructor throwing on both attempts; confirm `handleAudioCaptureError` catch block receives the error, recovery counter increments, and `meeting-audio-error` fires.
- Confirm `audioRecoveryAttempts` resets to 0 on a successful recovery.

---

## NAT-H3 — Replace `UnsafeCell` with `OnceLock` in `sck.rs`

### Problem

[sck.rs:105-149](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/native-module/src/speaker/sck.rs#L105-L149) shares `Arc<UnsafeCell<Option<...>>>` between the calling thread and a ScreenCaptureKit completion callback. `UnsafeCell` is `!Sync` — putting it in an `Arc` and accessing it from two threads is **undefined behavior** per Rust's aliasing rules, even when guarded by an `AtomicBool`. The atomic only provides ordering; it does not satisfy Rust's ownership invariants.

### Exact Changes

#### [MODIFY] `native-module/src/speaker/sck.rs` — replace `UnsafeCell` with `OnceLock`

```diff
-        use std::cell::UnsafeCell;
-        use std::sync::{
-            atomic::{AtomicBool, Ordering},
-            Arc,
-        };
-
-        let content_cell: Arc<UnsafeCell<Option<arc::R<sc::ShareableContent>>>> =
-            Arc::new(UnsafeCell::new(None));
-        let content_ready = Arc::new(AtomicBool::new(false));
-        let content_error = Arc::new(AtomicBool::new(false));
-
-        let cell_clone = content_cell.clone();
-        let ready_clone = content_ready.clone();
-        let error_clone = content_error.clone();
-
-        sc::ShareableContent::current_with_ch(move |content_opt, error_opt| {
-            if let Some(e) = error_opt {
-                println!("[SpeakerInput] ERROR: ScreenCaptureKit access denied: {:?}", e);
-                error_clone.store(true, Ordering::SeqCst);
-            } else if let Some(c) = content_opt {
-                unsafe { *cell_clone.get() = Some(c.retained()); }
-            }
-            ready_clone.store(true, Ordering::SeqCst);
-        });
-
-        // Wait for shareable content (max 5 seconds)
-        for _ in 0..500 {
-            if content_ready.load(Ordering::SeqCst) { break; }
-            std::thread::sleep(std::time::Duration::from_millis(10));
-        }
-
-        if content_error.load(Ordering::SeqCst) {
-            println!("[SpeakerInput] Please grant Screen Recording permission...");
-            return Err(anyhow::anyhow!("ScreenCaptureKit access denied"));
-        }
-
-        let content = unsafe { (*content_cell.get()).take() }
-            .ok_or_else(|| anyhow::anyhow!("Failed to get shareable content (timeout)"))?;
+        use std::sync::{Arc, OnceLock};
+
+        // OnceLock<Result<...>> is Sync + Send — sound cross-thread sharing.
+        let result_cell: Arc<OnceLock<Result<arc::R<sc::ShareableContent>, String>>> =
+            Arc::new(OnceLock::new());
+        let cell_clone = result_cell.clone();
+
+        sc::ShareableContent::current_with_ch(move |content_opt, error_opt| {
+            let result = if let Some(e) = error_opt {
+                Err(format!("ScreenCaptureKit access denied: {:?}", e))
+            } else if let Some(c) = content_opt {
+                Ok(c.retained())
+            } else {
+                Err("No content and no error returned".to_string())
+            };
+            // set() is a no-op if already set — safe to call from callback thread.
+            let _ = cell_clone.set(result);
+        });
+
+        // Poll until OnceLock is populated (max 5 s).
+        let mut waited_ms = 0u32;
+        while result_cell.get().is_none() && waited_ms < 5000 {
+            std::thread::sleep(std::time::Duration::from_millis(10));
+            waited_ms += 10;
+        }
+
+        let content = match result_cell.get() {
+            None => return Err(anyhow::anyhow!("ScreenCaptureKit shareable content timed out after 5s")),
+            Some(Err(msg)) => {
+                println!("[SpeakerInput] Please grant Screen Recording permission in System Settings > Privacy & Security");
+                return Err(anyhow::anyhow!("{}", msg));
+            }
+            Some(Ok(c)) => c.clone(),
+        };
```

> [!NOTE]
> `OnceLock` is stable since Rust 1.70. Confirm `Cargo.toml` MSRV is ≥ 1.70 (it should be given other features used).

### Verification
- `cargo clippy` must pass with no `unsafe` warnings in `sck.rs`.
- Run `cargo test` in `native-module/`.
- Functional smoke-test: start a meeting, confirm system audio capture initialises without panic.

---

## NAT-H4 — Audio Self-Healing Watchdog

### Problem

[AppState.ts:156-158](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L156-L158):

```typescript
private audioRecoveryAttempts: number = 0;
private readonly MAX_AUDIO_RECOVERY_ATTEMPTS = 3;
private audioRecoveryBackoffMs: number = 5000;
```

Current failure modes:
1. Counter only resets in `prepareMeetingActivation` — a successful recovery mid-meeting never resets it, so the **second** audio failure gets zero attempts (already at max).
2. After exhaustion the system silently delivers no audio with no way for the user to self-serve.
3. No detection of "audio technically alive but delivering 0 bytes" (silent hardware freeze).

### Exact Changes

#### [MODIFY] `AppState.ts` — reset counter on successful recovery (already in NAT-H2, repeated for clarity)

See NAT-H2 diff: `this.audioRecoveryAttempts = 0` after a successful `reconfigureAudio()`.

#### [MODIFY] `AppState.ts` — proactive silence watchdog in existing health-check timer

The file already has `audioHealthCheckTimer` at [line 161](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L161) and `AUDIO_PIPELINE_PERIODIC_HEALTH_INTERVAL_MS = 60000`. Extend the existing health-check body:

```typescript
// Inside the periodic health-check callback (locate the existing
// AUDIO_PIPELINE_PERIODIC_HEALTH_INTERVAL_MS timer body):

const snapshot = { ...this.audioPipelineStats };
const deltaSystem  = snapshot.systemChunks   - this.audioPipelineLastSnapshot.systemChunks;
const deltaMic     = snapshot.microphoneChunks - this.audioPipelineLastSnapshot.microphoneChunks;
this.audioPipelineLastSnapshot = snapshot;

if (this.isMeetingActive && (deltaSystem === 0 || deltaMic === 0)) {
  const silentSources: string[] = [];
  if (deltaSystem === 0) silentSources.push('system');
  if (deltaMic    === 0) silentSources.push('microphone');

  console.warn(
    `[AudioHealth] Silent source(s) detected over last ${this.AUDIO_PIPELINE_PERIODIC_HEALTH_INTERVAL_MS / 1000}s: ${silentSources.join(', ')}. Triggering proactive recovery.`
  );

  // Only attempt if not already recovering and attempts remain.
  if (!this.isReconfiguringAudio && this.audioRecoveryAttempts < this.MAX_AUDIO_RECOVERY_ATTEMPTS) {
    void this.handleAudioCaptureError(
      silentSources.includes('system') ? 'system' : 'microphone',
      new Error('Audio silence watchdog: no chunks received in health window')
    );
  } else if (this.audioRecoveryAttempts >= this.MAX_AUDIO_RECOVERY_ATTEMPTS) {
    // Exhausted — notify user with actionable message
    this.broadcast('meeting-audio-error',
      'Audio pipeline is silent and could not be recovered. ' +
      'Please check your audio devices and restart the meeting.'
    );
    // Reset counter so user can restart meeting and get fresh attempts
    this.audioRecoveryAttempts = 0;
  }
}
```

#### [MODIFY] `AppState.ts` — increase max recovery attempts for mid-meeting resilience

```diff
-  private readonly MAX_AUDIO_RECOVERY_ATTEMPTS = 3;
+  // 5 attempts with exponential backoff gives up to ~75s of retry window
+  // (5s, 10s, 15s, 20s, 25s) before declaring permanent failure.
+  private readonly MAX_AUDIO_RECOVERY_ATTEMPTS = 5;
```

#### [MODIFY] `AppState.ts` — add jitter to backoff to prevent thundering-herd on device reconnect

```diff
-      const delayMs = this.audioRecoveryBackoffMs * attempt;
+      // Exponential backoff with ±20% jitter to avoid synchronized retries
+      const base = this.audioRecoveryBackoffMs * attempt;
+      const jitter = base * 0.2 * (Math.random() - 0.5);
+      const delayMs = Math.round(base + jitter);
```

### Verification
- Simulate `noteAudioChunk` not being called for one full health-check interval while `isMeetingActive = true`; confirm watchdog fires and `handleAudioCaptureError` is called.
- Confirm that after a successful proactive recovery the counter resets.
- Confirm that after MAX_AUDIO_RECOVERY_ATTEMPTS exhaustion, `meeting-audio-error` is broadcast and counter resets to 0.

---

## Proposed Execution Order

```
NAT-H3 (Rust, isolated, no TS deps) → NAT-H1 (infra, no feature logic) → NAT-H2 + NAT-H4 (coupled, do together in AppState.ts)
```

## Open Questions

> [!IMPORTANT]
> **NAT-H2**: Does `SystemAudioCapture` / `MicrophoneCapture` expose a `.start()` method that must be called after construction, or does the constructor auto-start? Confirm in the native module binding before adding explicit `.start()` calls in the recovery path.

> [!IMPORTANT]
> **NAT-H4**: Confirm the existing `audioHealthCheckTimer` periodic callback location in `AppState.ts` (search for `AUDIO_PIPELINE_PERIODIC_HEALTH_INTERVAL_MS`) — the silence watchdog code must be inserted into that existing callback, not a new timer.
