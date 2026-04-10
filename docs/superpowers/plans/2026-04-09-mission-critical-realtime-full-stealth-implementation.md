# Mission-Critical Realtime + Full Stealth Implementation Plan

> **For agentic workers:** implement this plan in order, keep steps small, and preserve the hard invariants defined below. Use checkbox (`- [ ]`) syntax for tracking. Every intermediate commit must build, pass existing tests, and keep the app shippable. Use the feature flag `ENABLE_SUPERVISOR_RUNTIME` to gate new paths during migration.

**Goal:** Make the app consistently fast, accurate, and dependable in critical realtime sessions on Apple Silicon M2 Max while enforcing full stealth as a binary invariant whenever invisible mode is enabled.

**Architecture:** Rebuild the runtime around hard realtime lanes, warm standby meeting activation, a budget-aware scheduler, M2 Max-specific QoS placement, tiered memory, and a binary full-stealth control plane. Audio continuity, transcript integrity, and full stealth are non-negotiable. Quality and background work degrade first.

**Tech Stack:** Electron, TypeScript, Node.js worker threads, native Rust audio module, Apple Silicon CoreML/ANE, Ollama-backed local inference, Swift XPC stealth helper, node:test, Playwright/E2E harnesses.

**Companion Ticket Breakdown:** [2026-04-09-mission-critical-realtime-full-stealth-ticket-breakdown.md](./2026-04-09-mission-critical-realtime-full-stealth-ticket-breakdown.md)

## Status Snapshot

- Completed and verified in this branch: Workstream 0, Workstream 1, Workstream 2 Part A, Workstream 2 Part B Step 1 through Step 6, Workstream 3 Step 1 through Step 8, Workstream 4 Step 1 through Step 8, Workstream 5 Step 1 through Step 5, Workstream 6 Step 1 through Step 8, and Workstream 7 Step 1 through Step 5 (with the remaining shipped-renderer Playwright path explicitly deferred). Focused runtime verification for proactive helper-fault callbacks, classifier-lane routing, multi-scenario soak gating, and lifecycle coverage now passes in this branch (`tsc -p electron/tsconfig.json` plus targeted `nativeStealthBridge`, `stealthSupervisor`, `macosVirtualDisplayClient`, `aneClassifierLane`, `faultInjection`, `missionCriticalSoak`, and `activeRendererLifecycle` tests).
- In progress: hardware-backed soak/fault evidence collection and shipped-renderer Playwright execution for release proof.
- Remaining release-only work: M2 Max SLO proof, executing packaged helper launch probes on signed artifacts, and final removal of the legacy `AppState` orchestration path / feature flag.

---

## Hard Constraints

- Invisible mode is binary: `OFF -> ARMING -> FULL_STEALTH -> FAULT`. No reduced stealth mode and no partial fallback while invisible mode is on.
- Audio capture continuity, transcript correctness, and full stealth outrank answer richness, speculative work, indexing, and prefetch.
- All degrade paths must disable non-essential work before touching answer quality, and answer quality before touching user-visible responsiveness.
- Meeting start must become a bind/activate operation against warm resources, not a full reconstruction of the pipeline.
- **Every intermediate refactoring commit must be shippable.** Supervisors initially delegate to `AppState` and migrate ownership incrementally (strangler fig pattern).

## Service Level Objectives (SLOs)

Hard numbers that gate release. Soak and CI must enforce these.

| Metric | Target | Measurement Point |
| --- | --- | --- |
| Warm meeting activation | < 300 ms p95 | `RuntimeCoordinator.activate()` → first audio chunk forwarded to STT |
| Fast answer first-token | < 400 ms p50, < 900 ms p95 | `InferenceRouter.submit()` → first streamed token emitted to renderer |
| Audio gap tolerance | 0 gaps > 1 chunk (20 ms) | `AudioSupervisor` chunk arrival monitor |
| Stealth arm latency | < 200 ms p99 | `StealthArmController.arm()` → state == `FULL_STEALTH` |
| Crash recovery time | < 2 s to resume session | App relaunch → `RecoverySupervisor.restore()` complete |
| Crash data loss | ≤ 1 in-flight turn | Diff of pre-crash checkpoint vs post-recovery state |
| Session crash rate | < 1 per 4-hour soak | Count of unrecoverable crashes in soak harness |
| Memory ceiling (hot) | < 200 MB after 2 hours | `process.memoryUsage().heapUsed` sampled every 60 s |

## Feature Flag & Rollback Strategy

All new runtime paths are gated behind `ENABLE_SUPERVISOR_RUNTIME` in `electron/config/optimizations.ts`. When the flag is `false`, the app runs the current `AppState`-based path unchanged.

- **Phase 1 (Workstreams 0–1):** Flag defaults to `false`. New supervisors exist but delegate to `AppState`. Tests exercise both paths.
- **Phase 2 (Workstreams 2–5):** Flag defaults to `true` for dev builds, `false` for production.
- **Phase 3 (Workstreams 6–9):** Flag defaults to `true` everywhere. Old `AppState` orchestration methods are deprecated.
- **Rollback:** If a regression is detected, set the flag to `false`. No code revert needed. The old path must remain functional until the flag is removed in the final cleanup pass.

---

## Workstream 0: Baseline Benchmarks & Instrumentation

> This must run before any refactoring. You cannot improve what you cannot measure.

**Problem**

There are no recorded baseline numbers for meeting activation latency, first-token time, audio gap frequency, or stealth arm duration. Without baselines, performance changes in later workstreams cannot be validated as improvements or regressions.

**Goal**

Capture current performance baselines and add lightweight instrumentation that persists across all future workstreams.

**Files**
- Create: `electron/runtime/PerformanceInstrumentation.ts`
- Create: `electron/tests/baselineBenchmarks.test.ts`
- Modify: `electron/main.ts` (add timing probes at meeting start/stop, answer emit, stealth toggle)
- Modify: `electron/latency/AnswerLatencyTracker.ts` (extend existing tracker to cover new metrics)
- Modify: `package.json` (add `bench:baseline` script)

- [x] Step 1: Add timestamp probes to `startMeeting`, `endMeeting`, first-token emit, and `setEnabled` in `StealthManager`. Each probe writes to a structured JSON log at `~/.natively/benchmarks/`.
- [x] Step 2: Create `baselineBenchmarks.test.ts` that exercises a full meeting start→answer→stop cycle and asserts probe data was captured. This test does not enforce targets yet — it records them.
- [x] Step 3: Run the benchmark on M2 Max and record current values as `docs/superpowers/plans/baseline-metrics.json`. Commit this file. All future optimization work references these numbers.
- [x] Step 4: Add `bench:baseline` npm script that runs the benchmark in isolation and prints a comparison table against the committed baseline.

**Batch validation:** Baselines recorded. Probes do not regress existing test suite runtime by > 5%.

---

## Workstream 1: Runtime Supervisor Split

**Problem**

`electron/main.ts` (3,008 lines) and `electron/LLMHelper.ts` (3,736 lines) are god objects. `AppState` alone has a 200+ line constructor and owns meeting lifecycle, audio, stealth, inference, and recovery. This makes startup latency, fault handling, and critical-path tuning depend on broad shared state.

**Goal**

Refactor the runtime into dedicated supervisors with a typed event bus for inter-supervisor communication:
- `RuntimeCoordinator` — the only orchestrator, owns lifecycle state machine
- `AudioSupervisor` — capture startup/shutdown/health
- `SttSupervisor` — STT provider lifecycle, reconnect policy
- `InferenceSupervisor` — request lifecycle, lane dispatch
- `StealthSupervisor` — stealth arm/heartbeat/fault
- `RecoverySupervisor` — checkpoint, crash recovery, restore

### Supervisor Communication Contract

Supervisors communicate exclusively through a typed `SupervisorBus`. No supervisor holds a reference to another supervisor. The `RuntimeCoordinator` instantiates all supervisors and the bus.

```typescript
// electron/runtime/SupervisorBus.ts
type SupervisorEvent =
  | { type: 'audio:gap-detected'; durationMs: number }
  | { type: 'audio:capture-started' }
  | { type: 'audio:capture-stopped' }
  | { type: 'stt:transcript'; speaker: 'interviewer' | 'user'; text: string; final: boolean }
  | { type: 'stt:provider-exhausted'; speaker: 'interviewer' | 'user' }
  | { type: 'inference:draft-ready'; requestId: string }
  | { type: 'inference:answer-committed'; requestId: string }
  | { type: 'stealth:state-changed'; from: StealthState; to: StealthState }
  | { type: 'stealth:fault'; reason: string }
  | { type: 'recovery:checkpoint-written'; checkpointId: string }
  | { type: 'recovery:restore-complete'; sessionId: string }
  | { type: 'lifecycle:meeting-starting'; meetingId: string }
  | { type: 'lifecycle:meeting-active'; meetingId: string }
  | { type: 'lifecycle:meeting-stopping' }
  | { type: 'lifecycle:meeting-idle' }
  | { type: 'budget:pressure'; lane: string; level: 'warning' | 'critical' };
```

Each supervisor implements `ISupervisor { start(): Promise<void>; stop(): Promise<void>; getState(): SupervisorState; }`.

### Migration Strategy: Strangler Fig

**Critical rule:** `AppState` remains the owner of all behavior initially. Each supervisor starts as a thin facade that delegates to `AppState` methods. Then, method by method, ownership transfers from `AppState` to the supervisor. Each transfer is a single PR that can be reviewed and rolled back independently.

**Method Ownership Map (phase 1 — delegate, phase 2 — own):**

| Method cluster in `AppState` | Target supervisor | Phase 1 | Phase 2 |
| --- | --- | --- | --- |
| `startMeeting`, `endMeeting`, `meetingLifecycleState` | `RuntimeCoordinator` | Delegate | Own |
| `setupSystemAudioPipeline`, `noteAudioChunk`, audio health | `AudioSupervisor` | Delegate | Own |
| STT creation, `reconnectSpeakerStt`, `sttReconnector` callbacks | `SttSupervisor` | Delegate | Own |
| `processingHelper.getLLMHelper()` orchestration, answer routing | `InferenceSupervisor` | Delegate | Own |
| `stealthManager`, `isUndetectable`, stealth toggle | `StealthSupervisor` | Delegate | Own |
| `checkpointer`, session restore, crash recovery | `RecoverySupervisor` | Delegate | Own |

**IPC Handler Migration:** `ipcHandlers.ts` (1,297 lines) imports `AppState` directly. During migration, IPC handlers call `appState.getCoordinator().getSupervisor('audio')` instead of `appState.someAudioMethod()`. This is a mechanical refactor — each IPC handler that calls an `AppState` method is retargeted to the owning supervisor's public API.

**Files**
- Create: `electron/runtime/SupervisorBus.ts`
- Create: `electron/runtime/RuntimeCoordinator.ts`
- Create: `electron/runtime/AudioSupervisor.ts`
- Create: `electron/runtime/SttSupervisor.ts`
- Create: `electron/runtime/InferenceSupervisor.ts`
- Create: `electron/runtime/StealthSupervisor.ts`
- Create: `electron/runtime/RecoverySupervisor.ts`
- Create: `electron/runtime/types.ts` (ISupervisor, SupervisorState, SupervisorEvent)
- Modify: `electron/main.ts`
- Modify: `electron/ipcHandlers.ts`
- Modify: `electron/LLMHelper.ts`
- Test: `electron/tests/supervisorBus.test.ts`
- Test: `electron/tests/runtimeCoordinator.test.ts`

- [x] Step 1: Create `SupervisorBus` with typed emit/subscribe, `ISupervisor` interface, and `SupervisorState` enum. Add bus tests for event delivery, ordering, and error isolation.
- [x] Step 2: Create `RuntimeCoordinator` that instantiates all supervisors and the bus. Coordinator exposes `activate(meetingId)` and `deactivate()` but internally delegates to `AppState.startMeeting()` / `AppState.endMeeting()` behind the feature flag.
- [x] Step 3: Create `AudioSupervisor` as a facade. Its `start()` calls `AppState.setupSystemAudioPipeline()`. Add forwarding of audio chunks through the bus.
- [x] Step 4: Create `SttSupervisor` wrapping `STTReconnector` and STT provider creation. Forward transcript events through the bus.
- [x] Step 5: Create `InferenceSupervisor` wrapping `ProcessingHelper.getLLMHelper()` orchestration. Delegate all calls to `LLMHelper` initially.
- [x] Step 6: Create `StealthSupervisor` wrapping `StealthManager`. Emit `stealth:state-changed` events on the bus.
- [x] Step 7: Create `RecoverySupervisor` wrapping `MeetingCheckpointer` and `SessionPersistence`. Emit checkpoint events on the bus.
- [x] Step 8: Retarget IPC handlers from `appState.someMethod()` to `appState.getCoordinator().getSupervisor('x').someMethod()`. Each handler migration is a separate sub-PR.
- [x] Step 9: Add lifecycle tests: startup, shutdown, invalid transitions, lane restart without full meeting teardown, and bus event delivery during each transition.
- [x] Step 10: Add `ENABLE_SUPERVISOR_RUNTIME` feature flag to `optimizations.ts`. When `false`, `AppState` operates as today. When `true`, `RuntimeCoordinator` is active.

**Batch validation:** All 89 existing tests pass with flag on and off. New supervisor tests pass. App starts, runs a meeting, and stops without regression on both paths.

---

## Workstream 2: Stealth State Machine & Warm Standby Foundations

> Stealth is a hard invariant — it must be in place early so later workstreams cannot silently break it. Warm standby foundations are started here because they share the coordinator lifecycle.

### Part A: Binary Full-Stealth Control Plane

**Problem**

The current `StealthManager` (1,417 lines) has no concept of arming or fault states. Invisible mode is a best-effort toggle with degradation warnings, not a binary invariant.

**Goal**

Make full stealth a hard control-plane invariant:
- Toggle invisible mode only after a successful arm sequence.
- Report invisible mode as active only in `FULL_STEALTH`.
- If stealth is lost, transition immediately to `FAULT`, blank output, and exit invisible mode.

**Files**
- Create: `electron/stealth/StealthStateMachine.ts`
- Create: `electron/stealth/StealthArmController.ts`
- Modify: `electron/stealth/StealthRuntime.ts`
- Modify: `electron/stealth/StealthManager.ts`
- Modify: `electron/runtime/StealthSupervisor.ts`
- Test: `electron/tests/stealthStateMachine.test.ts`
- Test: `electron/tests/stealthArmController.test.ts`

- [x] Step 1: Define `OFF`, `ARMING`, `FULL_STEALTH`, and `FAULT` states in `StealthStateMachine`. Encode legal transitions. Illegal transitions throw. No "reduced stealth" path.
- [x] Step 2: Build `StealthArmController` that executes the arm sequence: verify native module loaded → apply stealth to all managed windows → verify stealth state → start heartbeat → transition to `FULL_STEALTH`.
- [x] Step 3: Make invisible-mode toggle in `StealthSupervisor` await arm success before emitting `stealth:state-changed` on the bus. Failed arm exits cleanly.
- [x] Step 4: Add fail-closed policy: heartbeat miss or runtime fault immediately → `FAULT` → blank output → exit invisible mode. `StealthSupervisor` emits `stealth:fault` on the bus. Other supervisors subscribe and shed non-essential work.
- [x] Step 5: Add tests for: failed arm (native module absent), heartbeat loss, shell crash, rapid toggle (on-off-on < 500 ms), stealth state machine rejects illegal transitions.

### Part B: Warm Standby Capture and Meeting Activation

**Problem**

Meeting start tears down and reconstructs the entire pipeline. The current `startMeeting` in `AppState` creates audio capture, STT connections, and worker resources from scratch every time.

**Goal**

Change meeting lifecycle from cold construction to warm binding:
- Pre-create capture devices, STT sockets, and worker pool in standby.
- Keep them armed when the app is idle.
- `startMeeting` binds meeting context to warm resources. `endMeeting` unbinds without destroying them.

**Files**
- Create: `electron/runtime/WarmStandbyManager.ts`
- Modify: `electron/runtime/RuntimeCoordinator.ts`
- Modify: `electron/runtime/AudioSupervisor.ts`
- Modify: `electron/runtime/SttSupervisor.ts`
- Modify: `electron/audio/SystemAudioCapture.ts`
- Modify: `electron/audio/DeepgramStreamingSTT.ts`
- Modify: `electron/STTReconnector.ts`
- Test: `electron/tests/warmStandbyMeetingLifecycle.test.ts`

- [x] Step 1: Create `WarmStandbyManager` that owns pre-armed audio capture and STT socket resources. `warmUp()` creates them; `coolDown()` destroys them. Health is queryable.
- [x] Step 2: Modify `AudioSupervisor` so `start()` reuses the warm capture device. If warm resource is unhealthy, fall back to cold creation.
- [x] Step 3: Modify `SttSupervisor` so `start()` binds session metadata to the pre-opened STT socket instead of creating a new connection.
- [x] Step 4: `RuntimeCoordinator.activate(meetingId)` warms standby on first call, then binds on subsequent calls. `deactivate()` unbinds but does not cool down unless explicitly requested.
- [x] Step 5: Add provider-specific reconnect policies in `SttSupervisor`: health scoring per provider, cooldown windows, bounded reconnect storms (max 3 attempts / 30 s).
- [x] Step 6: Add deterministic tests for: rapid start/stop (10 cycles in 5 seconds), simulated audio device change / warm-resource invalidation, provider reconnect exhaustion, and warm resource health failure.

**Batch validation:** Warm activation measured by `PerformanceInstrumentation` probe. Target: at least 2x faster than baseline cold start. Stealth state machine fully operational with bus events. All previous tests pass.

---

## Workstream 3: Budget Scheduler and Apple Silicon QoS Placement

**Problem**

Acceleration today is static feature flags in `optimizations.ts`. The runtime does not protect hard realtime lanes under CPU, memory, or thermal pressure. Node.js has no direct API for CPU core affinity on macOS, so the original "P-core/E-core pinning" must be replaced with actionable QoS-based placement.

**Goal**

Introduce a runtime budget scheduler that uses **macOS QoS classes** (not core pinning) to influence compute placement, plus explicit lane budgets for latency, memory, and queue depth.

### How Apple Silicon Placement Actually Works in Node.js

Node.js worker threads inherit the QoS class of their parent. To influence placement:

1. **Add a native N-API addon** (`electron/native/qos_helper.cc`) that calls `pthread_set_qos_class_self_np()` to set QoS for the calling thread.
2. **Worker threads call this addon at startup** to set their QoS class:
   - Realtime lanes: `QOS_CLASS_USER_INTERACTIVE` → macOS schedules on P-cores
   - Semantic/ANE lanes: `QOS_CLASS_USER_INITIATED` → P-cores preferred, may use E-cores
   - Background lanes: `QOS_CLASS_BACKGROUND` → macOS schedules on E-cores
3. **Fallback on non-Apple-Silicon:** QoS calls are no-ops. Budget enforcement still works via queue depth and timeouts.

| Lane | QoS Class | Budget | Responsibilities |
| --- | --- | --- | --- |
| Realtime | `USER_INTERACTIVE` | 20 ms deadline, 1 concurrent | Audio callbacks, STT orchestration, stream assembly |
| Local inference | (GPU — managed by Ollama/CoreML) | 2 s deadline, 1 concurrent | Fast draft via Ollama, local verification |
| Semantic | `USER_INITIATED` | 100 ms deadline, 2 concurrent | Embeddings (ANE), reranking, pause detection, classifiers |
| Background | `BACKGROUND` | Best-effort, 4 concurrent | Indexing, compaction, prefetch, checkpointing |

**Files**
- Create: `electron/runtime/RuntimeBudgetScheduler.ts`
- Create: `electron/runtime/WorkerPool.ts`
- Create: `electron/runtime/AppleSiliconQoS.ts`
- Create: `electron/native/qos_helper.cc` (N-API addon, < 50 lines)
- Modify: `electron/services/AccelerationManager.ts` (delegate budget decisions to scheduler)
- Modify: `electron/config/optimizations.ts` (add lane budget settings)
- Modify: `electron/cache/ParallelContextAssembler.ts` (use WorkerPool instead of ad-hoc threads)
- Modify: `electron/rag/providers/ANEEmbeddingProvider.ts` (register as semantic lane consumer)
- Test: `electron/tests/runtimeBudgetScheduler.test.ts`
- Test: `electron/tests/workerPool.test.ts`

- [x] Step 1: Build `AppleSiliconQoS.ts` — a thin wrapper that loads the native QoS addon and exposes `setCurrentThreadQoS(qosClass)`. If the addon fails to load (non-macOS, headless CI), all calls are no-ops.
- [x] Step 2: Build `WorkerPool` with configurable pool size. Each worker calls `setCurrentThreadQoS()` at startup. Pool tracks queue depth and worker saturation. Replace `ParallelContextAssembler`'s per-task worker creation with pool dispatch.
- [x] Step 3: Build `RuntimeBudgetScheduler` with per-lane budget configs (deadline, max concurrent, memory ceiling). The scheduler accepts work items tagged with a lane and dispatches them to the pool with appropriate priority.
- [x] Step 4: Define budget overrun policies: `warning` → log + shed prefetch; `critical` → cancel background work, shrink context window, defer refinement.
- [x] Step 5: Integrate with `AccelerationManager`: the existing `AccelerationManager` becomes a facade that delegates budget-aware decisions to `RuntimeBudgetScheduler`. Do not delete `AccelerationManager` — wrap it.
- [x] Step 6: Route ANE embeddings and lightweight classifiers (pause detection, phase detection) through the semantic lane. `ConsciousAccelerationOrchestrator` pause-action decisions and `InterviewPhaseDetector` now submit classifier work into the semantic lane when the runtime scheduler is available, while preserving direct fallback when it is not. Background routing remains in place for speculation/prefetch and now also covers live RAG indexing embeddings via `AccelerationManager.runInLane('background', ...)`.
- [x] Step 7: Add adaptive backpressure: when the scheduler detects budget overrun, it emits `budget:pressure` on the `SupervisorBus`. Subscribers (`InferenceSupervisor`, `WarmStandbyManager`) respond by shedding work.
- [x] Step 8: Add tests for: lane priority enforcement (realtime preempts background), budget overrun triggers degrade, QoS addon graceful fallback on Linux/CI.

**Batch validation:** Worker pool replaces ad-hoc thread creation. Budget overruns produce observable degrade behavior in tests. QoS addon loads on M2 Max. No regression in existing test suite.

---

## Workstream 4: Fast, Accurate, Multi-Lane Inference

**Problem**

`LLMHelper.ts` (3,736 lines) mixes provider adapters, routing, retries, and orchestration. Inference routing is implicit. The system needs fast visible output, but also correctness and dependable behavior when providers stall.

**Goal**

Split inference into explicit lanes with the `InferenceSupervisor` as the owner:
- **Policy lane:** cheap route selection based on request class, active budgets, and provider health
- **Fast draft lane:** low-latency answer generation via the fastest available provider (or local Ollama)
- **Verification lane:** lightweight semantic check against active transcript revision
- **Quality refinement lane:** richer model path only when the budget allows

### Local Inference Strategy

**Use Ollama (already integrated via `OllamaManager.ts`)** as the local fast-draft inference backend instead of building a custom Metal runtime. Ollama already handles Metal GPU acceleration, model management, and memory on M2 Max.

- Fast draft uses a small model (e.g., `qwen2.5:7b` or `phi3:mini`) via `ollama run` with streaming.
- Verification uses the same or a smaller model for semantic checks.
- Quality refinement uses the cloud provider (Gemini, GPT-4, Claude) when budget allows.
- If Ollama is unavailable, fast draft falls back to the cloud fast provider (Groq, Cerebras).

**Files**
- Create: `electron/inference/InferenceRouter.ts`
- Create: `electron/inference/FastDraftLane.ts`
- Create: `electron/inference/VerificationLane.ts`
- Create: `electron/inference/QualityLane.ts`
- Create: `electron/inference/types.ts` (InferenceRequest, LaneResult, RouteDecision)
- Modify: `electron/LLMHelper.ts` (becomes provider adapter only — routing moves to InferenceRouter)
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/runtime/InferenceSupervisor.ts` (owns InferenceRouter)
- Modify: `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- Modify: `electron/prefetch/PredictivePrefetcher.ts`
- Test: `electron/tests/inferenceRouter.test.ts`
- Test: `electron/tests/verificationLane.test.ts`
- Test: `electron/tests/qualityLaneFallback.test.ts`

- [x] Step 1: Define `InferenceRequest` type with fields: `requestClass` (fast/verify/quality), `transcriptRevision`, `contextSnapshot`, `budgetDeadlineMs`. Define `RouteDecision` with lane assignment and provider selection.
- [x] Step 2: Build `InferenceRouter` that selects lane based on request class + active budgets from `RuntimeBudgetScheduler`. Route selection is explicit, testable, and does not require provider-specific branching.
- [x] Step 3: Build `FastDraftLane` that routes to Ollama (local) when available, otherwise to the fastest cloud provider. Draft generation is revision-aware: if `transcriptRevision` changed since request submission, the draft is discarded.
- [x] Step 4: Build `VerificationLane` that runs a cheap semantic check against the current transcript revision before answer commit. Verification uses local Ollama or a fast cloud classifier. Weak or stale drafts are rejected.
- [x] Step 5: Build `QualityLane` that routes to the best available cloud provider for refinement. Quality lane has its own budget and timeout. Quality failure does not block fast lane output.
- [x] Step 6: Add lane-specific provider failover: each lane maintains its own fallback chain. Fast lane: Ollama → Groq → Cerebras → OpenAI. Verify lane: Ollama → skip. Quality lane: Gemini → Claude → OpenAI.
- [x] Step 7: Replace speculation heuristics in `PredictivePrefetcher` with budget-aware admission: speculation is allowed only when `RuntimeBudgetScheduler` reports background lane has headroom. Admission is gated by a simple payoff formula: `P(question_imminent) * value_of_prefetch > cost_of_compute`.
- [x] Step 8: Add tests for: stale work discard (transcript changed during inference), provider stall recovery (timeout → failover), verification rejection of weak draft, budget-gated speculation.

**Batch validation:** First-token latency improves vs baseline. Inference routing is testable without live providers (mock-based). `LLMHelper` no longer contains routing logic.

---

## Workstream 5: Tiered Memory, Checkpointing, and Recovery

**Problem**

`SessionTracker` (1,272 lines) grows unboundedly in long sessions. `MeetingCheckpointer` checkpoints on a fixed 60-second timer only. Recovery logic is spread across `SessionPersistence`, `MeetingCheckpointer`, and `AppState`.

**Goal**

Implement explicit hot/warm/cold memory tiers owned by `RecoverySupervisor`:
- **Hot:** current turn, recent 60s of transcript, live answer state (< 50 MB)
- **Warm:** active thread state, compact summaries, pinned constraints (< 100 MB)
- **Cold:** vectorized history in `SessionPersistence` and archival snapshots on disk

Checkpoint on session events (answer commit, phase change, meeting stop), not only on timer.

**Files**
- Create: `electron/memory/TieredMemoryManager.ts`
- Create: `electron/memory/EventCheckpointPolicy.ts`
- Modify: `electron/SessionTracker.ts` (add tier boundaries, expose hot/warm/cold accessors)
- Modify: `electron/MeetingCheckpointer.ts` (add event-driven triggers alongside timer)
- Modify: `electron/memory/SessionPersistence.ts`
- Modify: `electron/runtime/RecoverySupervisor.ts`
- Modify: `electron/db/DatabaseManager.ts`
- Test: `electron/tests/tieredMemoryManager.test.ts`
- Test: `electron/tests/eventCheckpointPolicy.test.ts`
- Test: `electron/tests/recoveryRestorePath.test.ts`

- [x] Step 1: Define hot/warm/cold state boundaries in `TieredMemoryManager`. Hot state has a hard ceiling (configurable, default 50 MB). Warm state has a soft ceiling (100 MB). Cold state is disk-backed.
- [x] Step 2: Build `EventCheckpointPolicy` that triggers checkpoint on: answer committed (`inference:answer-committed` bus event), phase transition, explicit user action, meeting stop. Timer checkpoint (60 s) remains as secondary protection. Duplicate checkpoint storms are suppressed with a 5-second cooldown.
- [x] Step 3: Modify `SessionTracker` to expose `getHotState()`, `getWarmState()`, and persist explicit hot/warm/cold memory snapshots into `SessionPersistence` for restore-oriented tier recovery.
- [x] Step 4: Add memory pressure enforcement: `RuntimeBudgetScheduler` emits `budget:pressure` when `process.memoryUsage().heapUsed` exceeds 80% of ceiling. `TieredMemoryManager` responds by forcing compaction: shed caches, demote warm → cold, truncate hot.
- [x] Step 5: Harden recovery restore path: `RecoverySupervisor.restore()` now rebuilds recent transcript/usage context from the persisted hot/warm/cold snapshot in `SessionPersistence`. Deterministic tests verify restore-oriented session continuity after restart.

**Batch validation:** Memory stays under ceiling during a 2-hour simulated session. Event checkpoints fire on answer commit. Recovery test passes: crash → restart → recent session context present.

---

## Workstream 6: Native Full-Stealth Helper

**Problem**

Electron-only window orchestration cannot guarantee full stealth against all capture vectors. The app needs a native surface that Electron cannot accidentally expose.

### Technical Design

**Language:** Swift (AppKit + Metal frameworks). XPC service for process isolation.

**Process model:** The helper is a **launchd XPC service** bundled inside the app's `Contents/XPCServices/` directory. XPC services are automatically code-signed with the parent app, do not require separate notarization, and benefit from macOS sandbox protections.

**Frame transport:** Electron captures offscreen frames via `webContents.capturePage()` and writes them to a shared **IOSurface**. The helper reads the IOSurface and presents it on a native `NSWindow` with `NSWindowSharingNone` applied. IOSurface is zero-copy between processes on Apple Silicon.

**Architecture:**

```
Electron (controller)                     XPC Helper (stealth surface)
─────────────────────                     ──────────────────────────────
OSR content window  ──IOSurface────────→  NSWindow + CAMetalLayer
                                          NSWindowSharingNone enforced
                                          Input events ──IPC────────→  Electron
ArmbridgeClient  ──────XPC msg─────────→  ArmController
HeartbeatSender  ──────XPC msg─────────→  HeartbeatReceiver
                                          Heartbeat miss → FAULT → blank + hide
```

**Files**
- Create: `stealth-projects/macos-full-stealth-helper/Sources/main.swift`
- Create: `stealth-projects/macos-full-stealth-helper/Sources/StealthSurface.swift`
- Create: `stealth-projects/macos-full-stealth-helper/Sources/XPCProtocol.swift`
- Create: `stealth-projects/macos-full-stealth-helper/contract.md`
- Create: `stealth-projects/macos-full-stealth-helper/Package.swift`
- Create: `electron/stealth/NativeStealthBridge.ts`
- Modify: `electron/stealth/StealthRuntime.ts`
- Modify: `electron/stealth/MacosStealthEnhancer.ts`
- Modify: `electron/runtime/StealthSupervisor.ts`
- Modify: build/packaging scripts (to bundle XPC service)
- Test: `electron/tests/nativeStealthBridge.test.ts`

- [x] Step 1: Write `contract.md` defining the XPC protocol: `arm(config: ArmConfig) -> ArmResult`, `heartbeat() -> void`, `submitFrame(surfaceId: IOSurfaceID,








 


 
region: CGRect) -> void`, `relayInput(event: InputEvent) -> void`, `fault(reason: String) -> void`. Protocol is versioned (v1).
- [x] Step 2: Scaffold the Swift XPC service with `Package.swift`. Implement `XPCProtocol.swift` with the protocol definition. Implement `StealthSurface.swift` with a `NSWindow` + `CAMetalLayer` that reads from IOSurface and enforces `NSWindowSharingNone`.
- [x] Step 3: Build `NativeStealthBridge.ts` in Electron that discovers and connects to the XPC service via `child_process.spawn` of the bundled helper binary (XPC bootstrap). Bridge exposes `arm()`, `submitFrame()`, `heartbeat()`, `fault()` as typed async methods.
- [x] Step 4: Integrate with `StealthArmController`: when the stealth state machine enters `ARMING`, the arm controller calls `NativeStealthBridge.arm()`. If the bridge reports success, transition to `FULL_STEALTH`. If the bridge is unavailable (XPC service not bundled), fall back to Electron-only stealth (current behavior).
- [x] Step 5: Implement heartbeat: `StealthSupervisor` sends heartbeat every 500 ms via the bridge. The helper still enforces the 2-second deadline in its control plane, and it now emits a proactive `helper-fault` event when that deadline is exceeded. `NativeStealthBridge` forwards that event to `StealthSupervisor`, which transitions to `FAULT` immediately and tears down the native session. Poll-detected fail-closed behavior remains as secondary protection.
- [x] Step 6: Add deterministic recovery: if the XPC helper dies, `NativeStealthBridge` detects process exit. `StealthSupervisor` transitions to `FAULT`. Helper restart is attempted once. If restart fails, stealth remains in `FAULT` (fail-closed).
- [x] Step 7: Modify build/packaging to bundle the XPC service in `Contents/XPCServices/`. Update code signing configuration.
- [x] Step 8: Add tests: bridge connection/disconnection, arm success/failure, heartbeat timeout, helper crash → fault, sleep/wake cycle, display hotplug.

**Batch validation:** XPC helper builds and bundles. Arm sequence completes. Heartbeat miss produces deterministic fault. Fallback to Electron-only stealth works when helper is absent.

---

## Workstream 7: Soak, Fault Injection, and Release Gates

**Problem**

Unit tests alone cannot validate mission-critical behavior. The system needs long-running soak tests, targeted fault injection, and hard release gates tied to the SLOs.

**Goal**

Add validation gates that block release if any SLO is violated.

**Files**
- Create: `electron/tests/missionCriticalSoak.test.ts`
- Create: `electron/tests/faultInjection.test.ts`
- Create: `electron/tests/activeRendererLifecycle.test.ts`
- Create: `stealth-projects/integration-harness/full-stealth-soak.md`
- Modify: `package.json` (add `test:soak`, `test:fault-injection`, `test:release-gate` scripts)

- [x] Step 1: Define soak scenarios with pass/fail criteria tied to SLO table:
  - 2-hour session: audio gap count must be 0, memory must stay under ceiling, no crashes.
  - 4-hour session: same, plus latency drift < 20% from baseline.
  - Rapid meeting cycles: 50x start/stop in 5 minutes, no leaked resources.
- [x] Step 2: Build fault injection harness with injectable failures:
  - `inject:provider-timeout` — STT/LLM provider stops responding for N seconds.
  - `inject:worker-exhaustion` — all worker pool slots occupied, new work queued.
  - `inject:memory-pressure` — allocate dummy buffers to trigger pressure hooks.
  - `inject:stealth-heartbeat-loss` — suppress heartbeat for N seconds.
  - Each injection validates that the system degrades gracefully per the degradation policy.
- [x] Step 3: Build active renderer lifecycle coverage in the electron suite (start/stop, invisible mode transitions, crash/fault exits, and packaged `file://` query-target behavior). The remaining shipped-renderer Playwright path remains a release-only follow-up.
- [x] Step 4: Define release gates as a CI script (`test:release-gate`) that:
  - Runs the soak test (configurable duration, default 30 min for CI, 2 hr for pre-release).
  - Runs fault injection suite.
  - Compares benchmark results against baseline and SLO thresholds.
  - Exits non-zero if any gate fails.
- [x] Step 5: Document the full soak procedure in `full-stealth-soak.md` for manual pre-release runs on M2 Max hardware.

**Batch validation:** Soak test runs for the configured duration without SLO violation. Fault injection triggers correct degrade behavior. Release gate script integrates into CI.

---

## Implementation Order

1. **Workstream 0:** Baseline Benchmarks & Instrumentation
2. **Workstream 1:** Runtime Supervisor Split (with strangler fig migration)
3. **Workstream 2:** Stealth State Machine + Warm Standby Foundations
4. **Workstream 3:** Budget Scheduler & Apple Silicon QoS Placement
5. **Workstream 4:** Fast, Accurate, Multi-Lane Inference
6. **Workstream 5:** Tiered Memory, Checkpointing, and Recovery
7. **Workstream 6:** Native Full-Stealth Helper
8. **Workstream 7:** Soak, Fault Injection, and Release Gates

### Parallelism Opportunities

These workstreams can be worked in parallel by separate agents/engineers:
- **Workstream 3** (Budget Scheduler) is independent of **Workstream 2B** (Warm Standby) after Workstream 1 lands.
- **Workstream 5** (Memory/Recovery) is independent of **Workstream 4** (Inference).
- **Workstream 6** (Native Helper) is fully independent — it can begin as soon as the stealth state machine from Workstream 2A exists.

## Non-Negotiable Degradation Policy

Priority order (never starve a higher-priority lane):

1. **Audio continuity** — never degraded while session active
2. **Transcript integrity** — never degraded while session active
3. **Full stealth** — never degraded while invisible mode active (fail-closed to FAULT instead)
4. **Answer responsiveness** — degrade last among non-critical lanes
5. **Answer quality/refinement** — degrade before responsiveness
6. **Background work** (indexing, prefetch, compaction) — degrade first

Concrete degrade sequence when budget pressure is `critical`:
1. Cancel all prefetch and speculative work
2. Defer indexing and compaction
3. Shrink context window depth
4. Disable quality refinement lane
5. (Never reached) Disable fast draft lane
6. (Hard invariant) Audio, transcript, and stealth never touched

## Existing Module Interaction

| Existing Module | Fate | Details |
| --- | --- | --- |
| `AccelerationManager` | Wrapped | Becomes a facade over `RuntimeBudgetScheduler`. Not deleted. |
| `ConsciousAccelerationOrchestrator` | Modified | Speculation gated by budget admission control instead of static heuristics. |
| `PredictivePrefetcher` | Modified | Prefetch requests routed through `RuntimeBudgetScheduler` background lane. |
| `OllamaManager` | Extended | Local fast-draft inference routes through existing Ollama integration. |
| `STTReconnector` | Wrapped | Owned by `SttSupervisor`. Reconnect policy becomes provider-aware. |
| `MeetingCheckpointer` | Extended | `EventCheckpointPolicy` adds event-driven triggers alongside existing timer. |
| `SessionPersistence` | Extended | Cold tier storage endpoint for `TieredMemoryManager`. |

## Testing Strategy During Migration

- Existing 89 test files continue to pass throughout migration.
- Tests that mock `AppState` gain a parallel path that mocks the supervisor interface.
- Each workstream includes its own test files. Tests run in CI with both `ENABLE_SUPERVISOR_RUNTIME=true` and `false`.
- When all workstreams land and soak passes, the flag is removed and `AppState` orchestration methods are deleted in a final cleanup PR.

## Definition Of Done

- [x] Baseline metrics captured and committed.
- [ ] The app can arm and start a warm meeting on M2 Max within 300 ms p95.
- [ ] The fast lane produces first-token under 400 ms p50 via Ollama or fastest cloud provider.
- [x] Verification lane rejects stale drafts before commit.
- [ ] Tiered memory keeps hot working set under 200 MB after 2 hours.
- [x] Invisible mode is only ever `OFF`, `ARMING`, `FULL_STEALTH`, or `FAULT`.
- [x] Native XPC stealth helper arms, heartbeats, and faults correctly. Falls back to Electron-only when absent.
- [ ] 2-hour soak and fault injection tests pass on M2 Max with all SLOs met.
- [ ] Feature flag removed; old `AppState` orchestration deleted.
