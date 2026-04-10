# Mission-Critical Realtime + Full Stealth Ticket Breakdown

**Primary Plan:** [2026-04-09-mission-critical-realtime-full-stealth-implementation.md](./2026-04-09-mission-critical-realtime-full-stealth-implementation.md)

**Purpose:** Break the implementation plan into delivery-ready tickets grouped by module and file ownership.

**Hard Invariants**
- Invisible mode is binary: `OFF -> ARMING -> FULL_STEALTH -> FAULT`
- No reduced or partial stealth state while invisible mode is enabled
- Audio continuity, transcript integrity, and full stealth outrank answer richness and background work
- Meeting start should bind onto warm resources, not reconstruct the runtime
- **Every intermediate commit is shippable.** Feature flag `ENABLE_SUPERVISOR_RUNTIME` gates new paths.

## Delivery Status Snapshot

- Done in this branch: `BL-001`, `BL-002`, `RT-001` through `RT-009`, `STL-001`, `STL-002`, `STL-003`, `WS-001`, `WS-002`, `WS-003`, `ACC-001`, `ACC-002`, `ACC-003`, `ACC-004`, `ACC-005`, `ACC-006`, `INF-001` through `INF-005`, `MEM-001`, `MEM-002`, `MEM-003`, `MEM-004`, `NSH-001`, `NSH-002`, `NSH-003`, `NSH-004`, `NSH-006`, `VAL-001`, `VAL-002`, `VAL-003`, `VAL-004`, plus the soak-procedure doc requested by `VAL-001`.
- In progress: hardware-backed release-proof runs for the VAL tickets.
- Remaining release-only proof: execute packaged-app helper launch probes on signed artifacts, collect M2 Max SLO/soak evidence, and finish the final legacy-runtime cleanup that removes the migration flag.

---

## Sequencing Summary

| Ticket | Module | Depends On |
| --- | --- | --- |
| BL-001 | Performance probes | None |
| BL-002 | Baseline capture | BL-001 |
| RT-001 | Supervisor bus and types | None |
| RT-002 | Runtime coordinator scaffold | RT-001 |
| RT-003 | Audio supervisor extraction | RT-001, RT-002 |
| RT-004 | STT supervisor extraction | RT-001, RT-002 |
| RT-005 | Inference supervisor extraction | RT-001, RT-002 |
| RT-006 | Stealth supervisor extraction | RT-001, RT-002 |
| RT-007 | Recovery supervisor extraction | RT-001, RT-002 |
| RT-008 | IPC handler migration | RT-002 through RT-007 |
| RT-009 | Feature flag integration | RT-002 |
| STL-001 | Stealth state machine | RT-006 |
| STL-002 | Stealth arm controller | STL-001 |
| STL-003 | Fail-closed invisible mode | STL-001, STL-002 |
| WS-001 | Warm standby manager | RT-003, RT-004 |
| WS-002 | Warm capture activation path | WS-001, RT-002 |
| WS-003 | Provider health and reconnect policy | RT-004, WS-001 |
| ACC-001 | QoS native addon | None |
| ACC-002 | Worker pool with QoS | ACC-001 |
| ACC-003 | Runtime budget scheduler | ACC-002, RT-002 |
| ACC-004 | Budget-aware acceleration facade | ACC-003 |
| ACC-005 | ANE classifier routing | ACC-003 |
| ACC-006 | Backpressure and bus integration | ACC-003, RT-001 |
| INF-001 | Inference types and router | RT-005, ACC-003 |
| INF-002 | Fast draft lane (Ollama) | INF-001 |
| INF-003 | Verification lane | INF-001 |
| INF-004 | Quality lane and failover | INF-001, INF-002, INF-003 |
| INF-005 | Budget-gated speculation | ACC-003, INF-001 |
| MEM-001 | Tiered memory manager | RT-007 |
| MEM-002 | Event checkpoint policy | MEM-001 |
| MEM-003 | Recovery restore path hardening | MEM-001, MEM-002 |
| MEM-004 | Memory pressure enforcement | ACC-003, MEM-001 |
| NSH-001 | XPC protocol and contract | STL-001 |
| NSH-002 | Swift XPC service scaffold | NSH-001 |
| NSH-003 | Native stealth bridge (TypeScript) | NSH-001 |
| NSH-004 | Arm and heartbeat integration | NSH-002, NSH-003, STL-002 |
| NSH-005 | Build and packaging | NSH-002 |
| NSH-006 | Fallback and crash recovery | NSH-004, STL-003 |
| VAL-001 | Soak test harness | WS-002, ACC-003, INF-002 |
| VAL-002 | Fault injection suite | RT-002, STL-003, MEM-003 |
| VAL-003 | Active renderer lifecycle tests | STL-003, WS-002 |
| VAL-004 | Release gate script | VAL-001, VAL-002, VAL-003 |

---

## Baseline & Instrumentation

### BL-001: Performance Instrumentation Probes

**Problem:** No baseline numbers exist for key metrics.

**Goal:** Add lightweight timestamp probes to meeting start, answer emit, and stealth toggle.

**Primary Files**
- `electron/runtime/PerformanceInstrumentation.ts`
- `electron/main.ts`
- `electron/latency/AnswerLatencyTracker.ts`

**Acceptance Criteria**
- Probes emit structured JSON to `~/.natively/benchmarks/`.
- Probes add < 1 ms overhead per call.
- Existing test suite runtime not regressed by > 5%.

### BL-002: Baseline Metrics Capture

**Problem:** Optimization work cannot be validated without recorded baselines.

**Goal:** Run benchmark on M2 Max and commit results.

**Primary Files**
- `electron/tests/baselineBenchmarks.test.ts`
- `docs/superpowers/plans/baseline-metrics.json`
- `package.json` (`bench:baseline` script)

**Acceptance Criteria**
- Baseline JSON contains: warm activation time, cold activation time, first-token latency, audio gap count, stealth arm duration.
- `bench:baseline` script prints comparison table.
- File is committed and referenced by all future optimization work.

---

## Runtime Core

### RT-001: Supervisor Bus and Types

**Problem:** No inter-supervisor communication contract exists.

**Goal:** Create the typed event bus and supervisor interfaces that all supervisors will use.

**Primary Files**
- `electron/runtime/SupervisorBus.ts`
- `electron/runtime/types.ts`
- `electron/tests/supervisorBus.test.ts`

**Acceptance Criteria**
- `SupervisorEvent` discriminated union covers all cross-supervisor events.
- `ISupervisor` interface defines `start()`, `stop()`, `getState()`.
- Bus delivers events in order, isolates subscriber errors.
- Bus tests cover: multiple subscribers, error in one doesn't affect others, unsubscribe works.

### RT-002: Runtime Coordinator Scaffold

**Problem:** `electron/main.ts` owns too much runtime sequencing.

**Goal:** Introduce a single coordinator that manages lifecycle transitions across supervisors.

**Primary Files**
- `electron/runtime/RuntimeCoordinator.ts`
- `electron/main.ts`
- `electron/tests/runtimeCoordinator.test.ts`

**Acceptance Criteria**
- Coordinator instantiates all supervisors and the bus.
- Lifecycle transitions (`idle → starting → active → stopping → idle`) are explicit and typed.
- `activate(meetingId)` and `deactivate()` delegate to `AppState` behind feature flag initially.
- Invalid transitions fail deterministically in tests.

### RT-003: Audio Supervisor Extraction

**Problem:** Audio lifecycle logic is mixed into broad meeting control flow.

**Goal:** Isolate capture startup, shutdown, health, and ownership into one supervisor.

**Primary Files**
- `electron/runtime/AudioSupervisor.ts`
- `electron/audio/SystemAudioCapture.ts`
- `electron/main.ts`
- `electron/tests/audioSupervisor.test.ts`

**Acceptance Criteria**
- Phase 1: `AudioSupervisor.start()` delegates to `AppState.setupSystemAudioPipeline()`.
- Audio chunk events forwarded through `SupervisorBus`.
- Audio restart does not require full meeting teardown.
- Audio health checks run through supervisor state.

### RT-004: STT Supervisor Extraction

**Problem:** STT lifecycle and reconnects are too coupled to main flow.

**Goal:** Centralize STT lane ownership and reconnect policy.

**Primary Files**
- `electron/runtime/SttSupervisor.ts`
- `electron/audio/DeepgramStreamingSTT.ts`
- `electron/STTReconnector.ts`
- `electron/main.ts`
- `electron/tests/sttSupervisor.test.ts`

**Acceptance Criteria**
- Phase 1: STT supervisor wraps `STTReconnector` and delegates STT creation to `AppState`.
- Transcript events forwarded through `SupervisorBus`.
- User and interviewer STT lanes are independently restartable.
- Provider exhaustion emits `stt:provider-exhausted` on bus.

### RT-005: Inference Supervisor Extraction

**Problem:** `LLMHelper` mixes provider adapters, routing, retries, and orchestration.

**Goal:** Move orchestration into an inference supervisor, leaving `LLMHelper` as provider adapter code.

**Primary Files**
- `electron/runtime/InferenceSupervisor.ts`
- `electron/LLMHelper.ts`
- `electron/IntelligenceEngine.ts`
- `electron/tests/inferenceSupervisor.test.ts`

**Acceptance Criteria**
- Phase 1: `InferenceSupervisor` wraps `ProcessingHelper.getLLMHelper()`.
- Answer commit events forwarded through `SupervisorBus`.
- Request cancellation and stale-result suppression are tested.

### RT-006: Stealth Supervisor Extraction

**Problem:** Stealth lifecycle does not yet behave as a dedicated hard-invariant lane.

**Goal:** Create one owner for stealth arm, heartbeat, fault, and exit behavior.

**Primary Files**
- `electron/runtime/StealthSupervisor.ts`
- `electron/stealth/StealthManager.ts`
- `electron/stealth/StealthRuntime.ts`
- `electron/main.ts`
- `electron/tests/stealthSupervisor.test.ts`

**Acceptance Criteria**
- Phase 1: Stealth supervisor wraps `StealthManager`.
- Stealth state changes emitted through `SupervisorBus`.
- Supervisor tests cover arm, active, fault, and teardown states.

### RT-007: Recovery Supervisor Extraction

**Problem:** Recovery, checkpoint, and session continuity are not owned by one lane.

**Goal:** Centralize checkpoint, crash recovery, and restore sequencing.

**Primary Files**
- `electron/runtime/RecoverySupervisor.ts`
- `electron/SessionTracker.ts`
- `electron/MeetingCheckpointer.ts`
- `electron/memory/SessionPersistence.ts`
- `electron/tests/recoverySupervisor.test.ts`

**Acceptance Criteria**
- Phase 1: Recovery supervisor wraps `MeetingCheckpointer` and `SessionPersistence`.
- Checkpoint events emitted through `SupervisorBus`.
- Recovery tests cover restart with recent session continuity.

### RT-008: IPC Handler Migration

**Problem:** `ipcHandlers.ts` (1,297 lines) imports `AppState` directly and calls methods that now belong to supervisors.

**Goal:** Retarget IPC handlers from `appState.someMethod()` to supervisor APIs.

**Status:** Done in this branch. The meeting lifecycle handlers (`start-meeting`, `end-meeting`), meeting helper handlers (`start-audio-test`, `stop-audio-test`, `set-recognition-language`, `seed-demo`), stealth/inference-backed settings handlers, settings-window handlers, email/intelligence/RAG/profile handlers, the full window-control surface, and the remaining root IPC paths for screenshots, STT runtime controls, inference sync/re-init, theme, model selector, and native audio status now all prefer coordinator/supervisor or facade APIs, while legacy fallback is preserved when the supervisor runtime is disabled.

**Primary Files**
- `electron/ipcHandlers.ts`
- `electron/ipc/registerMeetingHandlers.ts`
- `electron/ipc/registerSettingsHandlers.ts`
- All other `electron/ipc/register*.ts` files

**Acceptance Criteria**
- IPC handlers access supervisors through `appState.getCoordinator().getSupervisor('x')`.
- Each handler retarget is a separate sub-PR.
- All IPC contract tests pass.

### RT-009: Feature Flag Integration

**Problem:** New runtime paths must be gatable without code revert.

**Goal:** Add `ENABLE_SUPERVISOR_RUNTIME` flag to `optimizations.ts`.

**Primary Files**
- `electron/config/optimizations.ts`
- `electron/main.ts`

**Acceptance Criteria**
- When flag is `false`, all behavior routes through `AppState` (zero change from today).
- When flag is `true`, `RuntimeCoordinator` is active.
- All tests pass with flag on and off.

---

## Stealth

### STL-001: Stealth State Machine

**Problem:** Invisible mode needs a strict binary state model.

**Goal:** Encode legal stealth transitions and forbid silent degrade.

**Status:** Done in this branch. `electron/stealth/StealthStateMachine.ts` now defines the legal transitions, `electron/tests/stealthStateMachine.test.ts` covers them directly, and `StealthSupervisor` delegates its state transitions through the extracted machine.

**Primary Files**
- `electron/stealth/StealthStateMachine.ts`
- `electron/runtime/StealthSupervisor.ts`
- `electron/tests/stealthStateMachine.test.ts`

**Acceptance Criteria**
- Only `OFF`, `ARMING`, `FULL_STEALTH`, and `FAULT` are legal states.
- Illegal transitions throw and are rejected in tests.
- No "reduced stealth" code path remains in invisible mode control.

### STL-002: Stealth Arm Controller

**Problem:** Invisible mode should not report active before the arm sequence completes.

**Goal:** Build a formal arm sequence with readiness checks and heartbeat start.

**Status:** Done in this branch. `electron/stealth/StealthArmController.ts` owns the enable/verify/optional-heartbeat-start and disarm/optional-heartbeat-stop sequencing, `StealthSupervisor` delegates arm/disarm through it, the native helper enforces control-plane heartbeat deadlines, and a runtime-origin shell heartbeat now feeds `StealthSupervisor.noteRuntimeHeartbeat()` through `StealthRuntime` + `WindowHelper` wiring with stale-heartbeat fail-closed coverage in supervisor/runtime tests.

**Primary Files**
- `electron/stealth/StealthArmController.ts`
- `electron/stealth/StealthRuntime.ts`
- `electron/tests/stealthArmController.test.ts`

**Acceptance Criteria**
- Arm sequence: verify native module → apply stealth to windows → verify state → start heartbeat → `FULL_STEALTH`.
- Failed arm exits cleanly to `OFF` without hidden partial state.
- Arm completes within 200 ms p99.

### STL-003: Fail-Closed Invisible Mode Integration

**Problem:** Stealth loss must never continue as degraded invisibility.

**Goal:** Wire invisible mode into fail-closed behavior.

**Status:** Done in this branch. Fail-closed state transitions, bus fault emission, lane shedding, shell/runtime crash coverage, rapid on-off-on toggle coverage, native-helper heartbeat deadline enforcement, and proactive helper-originated fault callbacks are all landed. Remaining shipped-renderer validation is tracked under `VAL-003`, not this ticket.

**Primary Files**
- `electron/main.ts`
- `electron/runtime/StealthSupervisor.ts`
- `electron/stealth/StealthManager.ts`
- `electron/tests/stealthFailClosedIntegration.test.ts`

**Acceptance Criteria**
- Heartbeat loss or runtime fault transitions immediately to `FAULT`.
- `StealthSupervisor` emits `stealth:fault` on bus. Other supervisors shed non-essential work.
- Output is blanked and invisible mode exits instead of degrading.
- Rapid toggles and crash scenarios remain deterministic.

---

## Warm Standby

### WS-001: Warm Standby Manager

**Problem:** Meeting start still reconstructs too many resources.

**Goal:** Pre-arm reusable runtime resources before a session begins.

**Status:** Done in this branch. `WarmStandbyManager` now owns reusable audio/STT/worker-pool resources with queryable health, explicit bind/unbind lifecycle, and failure-safe warmup/cooldown coverage.

**Primary Files**
- `electron/runtime/WarmStandbyManager.ts`
- `electron/runtime/AudioSupervisor.ts`
- `electron/runtime/SttSupervisor.ts`
- `electron/tests/warmStandbyManager.test.ts`

**Acceptance Criteria**
- Capture, STT, and worker pool can enter standby without an active meeting.
- Warm standby health is queryable.
- Standby warmup failures do not falsely report ready state.

### WS-002: Warm Capture Activation Path

**Problem:** Meeting activation still behaves like a cold boot.

**Goal:** Make start/stop bind and unbind session context from warm resources.

**Status:** Done in this branch. `AudioSupervisor`, `SttSupervisor`, and `RuntimeCoordinator` now prefer healthy warm resources, fall back to cold paths when warm resources are invalid, and preserve reusable lanes across repeated activation cycles.

**Primary Files**
- `electron/runtime/WarmStandbyManager.ts`
- `electron/runtime/RuntimeCoordinator.ts`
- `electron/audio/SystemAudioCapture.ts`
- `electron/tests/warmStandbyMeetingLifecycle.test.ts`

**Acceptance Criteria**
- Meeting start attaches to existing warm resources.
- Meeting end unbinds without destroying reusable lanes.
- Rapid start/stop (10 cycles in 5 s) is race-safe.
- Activation time measured by `PerformanceInstrumentation`: at least 2x faster than baseline.

### WS-003: Provider Health and Reconnect Policy

**Problem:** Current reconnect logic is too generic for mission-critical use.

**Goal:** Add health scoring, cooldowns, and lane-specific reconnect decisions.

**Status:** Done in this branch. `STTReconnector` already owned bounded retry/cooldown health state, and `SttSupervisor` now exposes that provider health and emits exhaustion without forcing the entire session down.

**Primary Files**
- `electron/STTReconnector.ts`
- `electron/runtime/SttSupervisor.ts`
- `electron/audio/DeepgramStreamingSTT.ts`
- `electron/tests/providerHealthPolicy.test.ts`

**Acceptance Criteria**
- Providers have explicit health state (healthy/degraded/down) and cooldown windows.
- Reconnect storms are bounded (max 3 attempts / 30 s).
- Exhausted providers can be demoted without taking down the session.

---

## Apple Silicon QoS & Budget

### ACC-001: QoS Native Addon

**Problem:** Node.js has no API for macOS QoS classes. Core pinning is not possible from JavaScript.

**Goal:** Build a tiny N-API addon that wraps `pthread_set_qos_class_self_np()`.

**Status:** Done in this branch. `electron/native/qos_helper.cc` and `electron/runtime/AppleSiliconQoS.ts` now provide a loadable/no-op QoS abstraction with fallback coverage on unsupported environments.

**Primary Files**
- `electron/native/qos_helper.cc` (< 50 lines)
- `electron/runtime/AppleSiliconQoS.ts` (wrapper)
- `electron/tests/appleSiliconQoS.test.ts`

**Acceptance Criteria**
- `setCurrentThreadQoS('USER_INTERACTIVE' | 'USER_INITIATED' | 'BACKGROUND')` works on macOS arm64.
- No-op on non-macOS or when addon fails to load.
- Test verifies addon loads and calls succeed (does not verify core placement — that's an OS decision).

### ACC-002: Resident Worker Pool

**Problem:** Fresh worker creation per task wastes startup time.

**Goal:** Replace ephemeral worker creation with a long-lived pool. Workers set QoS at startup.

**Status:** Done in this branch. `WorkerPool` now centralizes queue depth, saturation, and QoS assignment, and `ParallelContextAssembler` dispatches through it instead of directly calling ad-hoc worker startup from the caller path.

**Primary Files**
- `electron/runtime/WorkerPool.ts`
- `electron/cache/ParallelContextAssembler.ts`
- `electron/tests/workerPool.test.ts`

**Acceptance Criteria**
- BM25, phase detection, and similar jobs run on resident workers.
- Worker startup cost is amortized across the session.
- Queue depth and worker saturation are visible to the scheduler.
- Workers call `setCurrentThreadQoS()` at startup based on assigned lane.

### ACC-003: Runtime Budget Scheduler

**Problem:** Acceleration is static flags, not a realtime scheduler.

**Goal:** Introduce per-lane budgets (deadline, max concurrent, memory ceiling) with degrade policies.

**Status:** Done in this branch. `RuntimeBudgetScheduler` now enforces explicit lane budgets, emits `budget:pressure`, and deterministically sheds background work under critical pressure.

**Primary Files**
- `electron/runtime/RuntimeBudgetScheduler.ts`
- `electron/config/optimizations.ts`
- `electron/tests/runtimeBudgetScheduler.test.ts`

**Acceptance Criteria**
- Every lane has explicit deadlines and memory ceilings.
- Budget overruns trigger deterministic degrade: `warning` → shed prefetch. `critical` → cancel background.
- Scheduler decisions are testable without full app boot.

### ACC-004: Budget-Aware Acceleration Facade

**Problem:** `AccelerationManager` uses static flags.

**Goal:** Wrap `AccelerationManager` with budget-aware scheduling. Do not delete `AccelerationManager`.

**Status:** Done in this branch. `AccelerationManager` now owns a scheduler + worker-pool pair and exposes budget-aware admission and lane execution without breaking its existing public surface.

**Primary Files**
- `electron/services/AccelerationManager.ts`
- `electron/runtime/RuntimeBudgetScheduler.ts`

**Acceptance Criteria**
- `AccelerationManager` delegates budget decisions to scheduler.
- Existing `AccelerationManager` API unchanged (no breaking change for callers).

### ACC-005: ANE Classifier Routing

**Problem:** ANE is currently used for embeddings only.

**Goal:** Route lightweight classifiers (pause detection, phase detection) through the semantic lane.

**Status:** Done in this branch. Pause-action classification in `ConsciousAccelerationOrchestrator` and phase detection in `InterviewPhaseDetector` now route through the semantic lane when the runtime scheduler is present (with direct fallback preserved), and background-lane routing now explicitly covers live indexing embeddings in `LiveRAGIndexer`.

**Primary Files**
- `electron/rag/providers/ANEEmbeddingProvider.ts`
- `electron/pause/PauseDetector.ts`
- `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- `electron/tests/aneClassifierLane.test.ts`

**Acceptance Criteria**
- Classifiers routed through semantic lane with `USER_INITIATED` QoS.
- CPU fallback remains correct if CoreML is unavailable.

### ACC-006: Backpressure and Bus Integration

**Problem:** Budget overruns need to propagate to supervisors.

**Goal:** Scheduler emits `budget:pressure` on `SupervisorBus`. Subscribers respond.

**Status:** Done in this branch. `RuntimeBudgetScheduler`, `InferenceSupervisor`, and `WarmStandbyManager` now propagate and consume `budget:pressure` events with deterministic shedding behavior.

**Primary Files**
- `electron/runtime/RuntimeBudgetScheduler.ts`
- `electron/runtime/SupervisorBus.ts`
- `electron/tests/backpressureIntegration.test.ts`

**Acceptance Criteria**
- `budget:pressure` events with lane and level reach all subscribers.
- `InferenceSupervisor` sheds speculation on `critical` pressure.
- `WarmStandbyManager` defers non-essential warmup on pressure.

---

## Inference

### INF-001: Inference Types and Router

**Problem:** Inference path selection is implicit inside `LLMHelper`.

**Goal:** Add explicit route selector with typed request/response.

**Status:** Done in this branch. `electron/inference/types.ts`, `InferenceRouter`, and supervisor integration now make routing explicit and testable.

**Primary Files**
- `electron/inference/types.ts`
- `electron/inference/InferenceRouter.ts`
- `electron/runtime/InferenceSupervisor.ts`
- `electron/tests/inferenceRouter.test.ts`

**Acceptance Criteria**
- `InferenceRequest` has `requestClass`, `transcriptRevision`, `budgetDeadlineMs`.
- Route selection is explicit and testable with mocks.
- Router does not contain provider-specific logic.

### INF-002: Fast Draft Lane (Ollama)

**Problem:** The system needs low-latency visible output.

**Goal:** Build fast draft path using existing Ollama integration for local inference. Cloud fallback to Groq/Cerebras.

**Status:** Done in this branch. `FastDraftLane` now prefers the local draft path and falls back through the fast-provider chain while discarding stale revisions.

**Primary Files**
- `electron/inference/FastDraftLane.ts`
- `electron/services/OllamaManager.ts`
- `electron/IntelligenceEngine.ts`
- `electron/tests/fastDraftLane.test.ts`

**Acceptance Criteria**
- Fast draft routes to Ollama (local) when available, cloud otherwise.
- Draft generation is revision-aware and cancelable.
- Drafts can be promoted or discarded safely.
- First-token within budget (< 400 ms p50).

### INF-003: Verification Lane

**Problem:** Fast responses need a lightweight correctness check.

**Goal:** Add cheap semantic verification against active transcript revision.

**Status:** Done in this branch. `VerificationLane` now rejects stale or weak drafts deterministically and exposes the explicit verification decision in tests.

**Primary Files**
- `electron/inference/VerificationLane.ts`
- `electron/tests/verificationLane.test.ts`

**Acceptance Criteria**
- Drafts checked against active transcript revision before commit.
- Weak or stale drafts rejected deterministically.
- Verification runs under stricter deadline than quality refinement.

### INF-004: Quality Lane and Lane-Specific Failover

**Problem:** Fallbacks are too broad and not aligned to lane roles.

**Goal:** Add lane-specific fallback chains.

**Status:** Done in this branch. `QualityLane` now owns refinement timeout/failover behavior independently of the fast and verification lanes.

**Primary Files**
- `electron/inference/QualityLane.ts`
- `electron/LLMHelper.ts`
- `electron/tests/qualityLaneFallback.test.ts`

**Acceptance Criteria**
- Fast, verify, and quality lanes fail independently.
- Quality lane failure does not block fast lane output.
- Fallback chains: Fast: Ollama → Groq → Cerebras → OpenAI. Quality: Gemini → Claude → OpenAI.

### INF-005: Budget-Gated Speculation

**Problem:** Speculation is heuristic-heavy, not budget-aware.

**Goal:** Gate speculative work with scheduler budget and payoff formula.

**Status:** Done in this branch. `PredictivePrefetcher` and `ConsciousAccelerationOrchestrator` now admit speculation only when the runtime budget scheduler allows it.

**Primary Files**
- `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- `electron/prefetch/PredictivePrefetcher.ts`
- `electron/runtime/RuntimeBudgetScheduler.ts`
- `electron/tests/speculationAdmission.test.ts`

**Acceptance Criteria**
- Speculation disabled when budget pressure is `critical`.
- Admission formula: `P(question_imminent) * value > cost`. Signals: pause detector, phase detector.
- Background speculation never starves active answer or stealth lanes.

---

## Memory And Recovery

### MEM-001: Tiered Memory Manager

**Problem:** Session state is not managed as explicit tiers.

**Goal:** Separate hot (< 50 MB), warm (< 100 MB), and cold (disk) memory ownership.

**Status:** Done in this branch. `TieredMemoryManager` now enforces hot/warm/cold ceilings and persists demoted cold entries through a storage hook.

**Primary Files**
- `electron/memory/TieredMemoryManager.ts`
- `electron/SessionTracker.ts`
- `electron/tests/tieredMemoryManager.test.ts`

**Acceptance Criteria**
- Hot ceiling enforced: oldest entries demote to warm when exceeded.
- Warm ceiling enforced: oldest entries persist to `SessionPersistence` (cold).
- Long sessions do not grow hot working set without bound.

### MEM-002: Event Checkpoint Policy

**Problem:** Timer-only checkpointing (60 s) is too coarse.

**Goal:** Trigger checkpoint on session events with 5-second cooldown.

**Status:** Done in this branch. `EventCheckpointPolicy` now reacts to answer-commit / phase / user / meeting-stop events with cooldown suppression, and `RecoverySupervisor` can drive it directly.

**Primary Files**
- `electron/memory/EventCheckpointPolicy.ts`
- `electron/MeetingCheckpointer.ts`
- `electron/tests/eventCheckpointPolicy.test.ts`

**Acceptance Criteria**
- Checkpoint on: answer commit (`inference:answer-committed`), phase change, meeting stop.
- Timer checkpoint remains as secondary protection.
- Duplicate storms suppressed (5s cooldown).

### MEM-003: Recovery Restore Path Hardening

**Problem:** Restore logic needs a clearer contract around recent session state.

**Goal:** Guarantee recent continuity after restart or crash.

**Status:** Done in this branch. `SessionTracker` now persists hot/warm/cold memory snapshots in `SessionPersistence`, restore rebuilds recent transcript/usage context from those persisted tiers, and deterministic tests cover the restore-oriented continuity path. The release SLO proof for `< 2 s` recovery still lives under validation, not implementation.

**Primary Files**
- `electron/runtime/RecoverySupervisor.ts`
- `electron/memory/SessionPersistence.ts`
- `electron/tests/recoveryRestorePath.test.ts`

**Acceptance Criteria**
- Restore rebuilds active session from most recent checkpoint + warm state.
- Recovery drops only the current in-flight turn.
- Restore deterministic across repeated restart tests.
- Recovery time < 2 s.

### MEM-004: Memory Pressure Enforcement

**Problem:** No explicit behavior when memory budgets are exceeded.

**Goal:** Enforce compaction and demotion under pressure.

**Status:** Done in this branch. `TieredMemoryManager` now compacts under `budget:pressure`, and scheduler-driven pressure tests cover the enforcement path.

**Primary Files**
- `electron/memory/TieredMemoryManager.ts`
- `electron/runtime/RuntimeBudgetScheduler.ts`
- `electron/tests/memoryPressurePolicy.test.ts`

**Acceptance Criteria**
- Memory pressure triggers tier demotion before instability.
- Nonessential caches shed before hot state affected.
- Integrates with `budget:pressure` bus event.

---

## Native Stealth Helper

### NSH-001: XPC Protocol and Contract

**Problem:** Full stealth needs a stronger contract than Electron-only orchestration.

**Goal:** Define the versioned XPC protocol for the native stealth helper.

**Primary Files**
- `stealth-projects/macos-full-stealth-helper/contract.md`
- `stealth-projects/macos-full-stealth-helper/Sources/XPCProtocol.swift`

**Acceptance Criteria**
- Protocol v1 covers: `arm(config)`, `heartbeat()`, `submitFrame(surfaceId, region)`, `relayInput(event)`, `fault(reason)`.
- Protocol is versioned. Contract doc is reviewable before implementation.

### NSH-002: Swift XPC Service Scaffold

**Problem:** No native helper exists.

**Goal:** Scaffold the Swift XPC service with stealth surface.

**Status:** Done in this branch. `main.swift` now exposes the helper control-plane commands in direct and `serve` modes, `StealthSurface.swift` creates a hidden AppKit window backed by `CAMetalLayer` with `NSWindowSharingNone`, and the helper is covered by the `MacosVirtualDisplayClient` serve-mode integration test.

**Primary Files**
- `stealth-projects/macos-full-stealth-helper/Package.swift`
- `stealth-projects/macos-full-stealth-helper/Sources/main.swift`
- `stealth-projects/macos-full-stealth-helper/Sources/StealthSurface.swift`

**Acceptance Criteria**
- XPC service builds with `swift build`.
- `StealthSurface` creates `NSWindow` + `CAMetalLayer` with `NSWindowSharingNone`.
- Service can receive arm and heartbeat messages.

### NSH-003: Native Stealth Bridge (TypeScript)

**Problem:** Electron needs a typed client for the XPC service.

**Goal:** Build the TypeScript bridge that connects to the helper.

**Primary Files**
- `electron/stealth/NativeStealthBridge.ts`
- `electron/tests/nativeStealthBridge.test.ts`

**Acceptance Criteria**
- Bridge discovers and connects to bundled XPC service.
- Typed async methods: `arm()`, `submitFrame()`, `heartbeat()`, `fault()`.
- Graceful degradation when helper is not bundled.

### NSH-004: Arm and Heartbeat Integration

**Problem:** Stealth arm must route through native helper when available.

**Goal:** Wire `StealthArmController` to use `NativeStealthBridge`.

**Status:** Done in this branch. `StealthArmController` and `StealthSupervisor` now route arm/heartbeat through `NativeStealthBridge` when available, explicit tests cover the unavailable-helper fallback to Electron-only stealth, and native-helper heartbeat misses still fail closed.

**Primary Files**
- `electron/stealth/StealthArmController.ts`
- `electron/stealth/NativeStealthBridge.ts`
- `electron/runtime/StealthSupervisor.ts`

**Acceptance Criteria**
- Arm controller calls `NativeStealthBridge.arm()` when bridge is connected.
- Falls back to Electron-only stealth when bridge is unavailable.
- Heartbeat sent every 500 ms. Helper expects heartbeat within 2 s.
- Heartbeat miss produces `FAULT`.

### NSH-005: Build and Packaging

**Problem:** XPC service needs to be bundled, code-signed, and distributed.

**Goal:** Integrate helper into build and packaging pipeline.

**Status:** Implemented in this branch with release-run proof pending. The helper now stages as `assets/xpcservices/macos-full-stealth-helper.xpc`, mac build scripts prepare it before packaging, Electron Builder places it in `Contents/XPCServices/`, the after-pack signing hook signs the nested bundle, and `build-and-install.sh` force-signs and validates helper artifacts. An opt-in packaged launch probe now executes both launch modes (`with-helper` and `without-helper`) via `NATIVELY_VALIDATE_PACKAGED_HELPER_LAUNCH=1`; final release evidence is still pending an on-device signed artifact run.

**Primary Files**
- Build scripts
- Electron Builder config
- Code signing configuration

**Acceptance Criteria**
- Helper bundled in `Contents/XPCServices/`.
- Code signing works with existing entitlements.
- App launches correctly with and without helper.

### NSH-006: Fallback and Crash Recovery

**Problem:** Helper death must not break the app.

**Goal:** Add deterministic recovery when helper crashes.

**Status:** Done in this branch. `NativeStealthBridge` now retries a helper disconnect once before emitting a terminal disconnect callback, unit tests cover both recovery-success and terminal-failure cases, and supervisor coverage now exercises helper crash, sleep/wake recovery, and display-hotplug-style second-disconnect fail-closed behavior end to end.

**Primary Files**
- `electron/stealth/NativeStealthBridge.ts`
- `electron/runtime/StealthSupervisor.ts`

**Acceptance Criteria**
- Helper process exit detected by bridge.
- `StealthSupervisor` transitions to `FAULT` (fail-closed).
- One restart attempt. If restart fails, stealth stays in `FAULT`.
- Tests cover: helper crash, sleep/wake, display hotplug.

---

## Validation And Release Gates

### VAL-001: Soak Test Harness

**Problem:** Performance targets need repeatable long-running measurement.

**Goal:** 2-hour soak with automated SLO checking.

**Status:** Partially implemented in this branch. The soak gate now executes deterministic multi-scenario runs (`2h-session`, `4h-session`, and `rapid-cycles`) through `scripts/run-soak-scenarios.js` with explicit SLO assertions in `missionCriticalSoak.test.ts`. Real hardware-backed 2-hour and 4-hour proof still remains a pre-release exercise.

**Primary Files**
- `electron/tests/missionCriticalSoak.test.ts`
- `stealth-projects/integration-harness/full-stealth-soak.md`
- `package.json` (`test:soak` script)

**Acceptance Criteria**
- Audio gap count must be 0 over 2 hours.
- Memory must stay under 200 MB hot ceiling.
- Latency drift < 20% from baseline.
- No unrecoverable crashes.

### VAL-002: Fault Injection Suite

**Problem:** Mission-critical behavior must be tested under failure.

**Goal:** Deterministic injection for provider loss, worker exhaustion, memory pressure, heartbeat loss.

**Status:** Partially implemented in this branch. The suite now covers fail-closed stealth (including proactive helper-origin heartbeat loss), provider exhaustion, worker-lane stress behavior under scheduler contention, and memory-pressure budget signaling. Full hardware-backed fault sweeps still remain open.

**Primary Files**
- `electron/tests/faultInjection.test.ts`
- Harness helpers

**Acceptance Criteria**
- Fault injection targets: inference, STT, memory, stealth lanes.
- Fail-closed behavior verified automatically.
- Recovery and degrade policies covered.

### VAL-003: Active Renderer Lifecycle Tests

**Problem:** The shipped UI lifecycle must be tested, not just backend.

**Goal:** Playwright tests for actual UI lifecycle.

**Status:** Partially implemented in this branch. Lifecycle coverage now exists in the electron test suite, including packaged `file://` query-target behavior, but the remaining shipped-renderer / Playwright path is still pending.

**Primary Files**
- `electron/tests/activeRendererLifecycle.test.ts`
- Playwright harness scripts

**Acceptance Criteria**
- Start/stop, invisible mode toggle, crash/fault exits covered.
- Tests run against shipped renderer, not mocks.

### VAL-004: Release Gate Script

**Problem:** Release must be blocked when SLOs fail.

**Goal:** CI-integrated release gate script.

**Primary Files**
- `package.json` (`test:release-gate` script)

**Acceptance Criteria**
- Runs soak (configurable: 30 min CI, 2 hr pre-release).
- Runs fault injection.
- Compares benchmarks against baseline + SLO thresholds.
- Exits non-zero if any gate fails.

---

## Suggested Delivery Batches

### Batch 0 — Baseline
- BL-001
- BL-002

### Batch 1 — Runtime Foundation
- RT-001
- RT-002
- RT-003
- RT-004
- RT-005
- RT-006
- RT-007
- RT-009

### Batch 2 — Stealth State Machine + Warm Standby
- STL-001
- STL-002
- STL-003
- WS-001
- WS-002
- WS-003
- RT-008

### Batch 3 — Budget Scheduler + QoS
- ACC-001
- ACC-002
- ACC-003
- ACC-004
- ACC-005
- ACC-006

### Batch 4 — Multi-Lane Inference
- INF-001
- INF-002
- INF-003
- INF-004
- INF-005

### Batch 5 — Memory + Recovery
- MEM-001
- MEM-002
- MEM-003
- MEM-004

### Batch 6 — Native Stealth Helper (parallel track)
- NSH-001
- NSH-002
- NSH-003
- NSH-004
- NSH-005
- NSH-006

### Batch 7 — Validation + Release Gates
- VAL-001
- VAL-002
- VAL-003
- VAL-004

**Note:** Batch 6 (Native Helper) can run in parallel with Batches 3–5. It only depends on STL-001 from Batch 2.
