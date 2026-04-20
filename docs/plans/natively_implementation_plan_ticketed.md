# Natively — Implementation Plan (Ticketed)

> Source: derived from the principal-engineer audit of the Natively Electron meeting assistant.
> Audience: low-context coding agents executing the work.
> Scope: full original audit scope, restated as execution-ready epics and tickets.

---

## 0. Conventions

### 0.1 Identifiers

- Epic ID: `EPIC-NN` (zero-padded, sequential).
- Ticket ID: `NAT-NNN` (zero-padded, sequential, never reused).
- Original audit finding IDs (`S-#`, `A-#`, `P-#`, `R-#`, `H-#`) are referenced in each ticket for traceability.

### 0.2 Priority

- `P0` — Production-impacting bug, ship in current week.
- `P1` — High-value fix or hardening, ship in current sprint.
- `P2` — Medium-value, ship in current quarter.
- `P3` — Long-term refactor or polish.

### 0.3 Type

- `bug-fix` — Restores correct behavior of existing code.
- `feature` — Adds new capability.
- `refactor` — Restructures existing code without behavior change.
- `test` — Adds or hardens tests, harnesses, fixtures.
- `infra` — Build/CI/observability/release work.
- `docs` — Documentation only.

### 0.4 File path conventions

All paths are repo-relative to the worktree root `/Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/`. Line numbers refer to the state captured during the audit.

### 0.5 Test commands (canonical)

- Type check: `npm run typecheck`
- Electron unit tests: `npm run test:electron`
- Renderer tests: `npm run test:renderer`
- Native tests: `cargo test --manifest-path native-module/Cargo.toml`
- Soak: `npm run test:soak`
- Fault injection: `npm run test:fault-injection`
- Conscious eval: `npm run eval:conscious`
- Intent eval: `npm run eval:intent`
- Coverage gate: `npm run verify:production`

### 0.6 Definition of Done (DoD) — applies to every ticket unless overridden

- [ ] All implementation steps complete.
- [ ] All acceptance criteria verified.
- [ ] All listed validation commands pass locally.
- [ ] No new linter warnings or type errors.
- [ ] Tests added or updated per ticket spec; existing tests still pass.
- [ ] Telemetry / logging additions documented in ticket if any.
- [ ] Changelog entry added under the matching epic.

### 0.7 Standing assumptions

- A1. Single active worktree at the path above; all work commits into the current branch unless an epic specifies a feature branch.
- A2. Node 20+, pnpm/npm available; Rust toolchain available for `native-module`.
- A3. macOS dev hardware with screen-recording entitlement is available for stealth fixture work.
- A4. Existing Foundation helper Swift binary builds via `npm run prepare:macos:foundation-intent-helper`.
- A5. No production telemetry endpoint exists today; new metrics will be local-log-emit until an observability sink is wired (EPIC-20).
- A6. Tickets are independent of one another *unless* a `Dependencies:` field lists prerequisites.

---

## 1. Execution order

### 1.1 Wave summary

```
Wave 1 (week 1)   — EPIC-01, EPIC-02, EPIC-03, EPIC-04, EPIC-20a (test fixtures)
Wave 2 (weeks 2–4) — EPIC-05, EPIC-06, EPIC-07, EPIC-08
Wave 3 (months 2–3)— EPIC-09, EPIC-10, EPIC-11, EPIC-12, EPIC-13, EPIC-14
Wave 4 (months 4+) — EPIC-15, EPIC-16, EPIC-17, EPIC-18, EPIC-19
Cross-cutting     — EPIC-20 (observability) runs in parallel from Wave 1
```

### 1.2 Wave 1 parallelization

All Wave-1 epics are independent and may run on parallel agents. Suggested fan-out:

```
Agent A  -> EPIC-01 (NAT-001..NAT-009)
Agent B  -> EPIC-02 (NAT-010..NAT-012) + EPIC-04 (NAT-024)
Agent C  -> EPIC-03 (NAT-013..NAT-022)
Agent D  -> EPIC-20a (NAT-082..NAT-085) test fixtures
```

### 1.3 Wave 2 parallelization

```
Agent A  -> EPIC-05 (stealth hardening)            depends on EPIC-02 + EPIC-20a
Agent B  -> EPIC-06 (IPC + cancellation)           depends on EPIC-01
Agent C  -> EPIC-07 (audio quality)                independent
Agent D  -> EPIC-08 (conscious hygiene)            depends on EPIC-01
```

### 1.4 Wave 3 dependency graph

```
EPIC-09 (Foundation persistent process)  -> EPIC-06
EPIC-10 (LiveRAG worker)                 -> independent
EPIC-11 (Unified thread model)           -> EPIC-08
EPIC-12 (IntentConfidenceService)        -> EPIC-09
EPIC-13 (RouteDirector)                  -> EPIC-06, EPIC-12
EPIC-14 (Unified Cache)                  -> EPIC-04
```

### 1.5 Wave 4 dependency graph

```
EPIC-15 (event-sourced session)          -> EPIC-03
EPIC-16 (STT diarization)                -> EPIC-07
EPIC-17 (HelperHost)                     -> EPIC-09
EPIC-18 (Provider client unification)    -> EPIC-06, EPIC-13
EPIC-19 (Mega-file decomposition)        -> last; blocks nothing
```

### 1.6 Hard blockers

- EPIC-13 will not start until EPIC-12 ships (route gating depends on the unified confidence service).
- EPIC-18 will not start until EPIC-13 ships (single provider client depends on unified routing).
- EPIC-19 will not start until Waves 1–3 ship (file splits create merge conflicts otherwise).

---

## 2. Epic catalog

### EPIC-01 — Critical accuracy fixes (stale-state elimination)
- **Objective**: Eliminate every code path where stale, invalidated, or low-confidence speculative state can surface as a final answer.
- **Scope**: `electron/IntelligenceEngine.ts`, `electron/conscious/ConsciousAccelerationOrchestrator.ts`, `electron/conscious/ConsciousIntentService.ts`, `electron/conscious/ConsciousProvenanceVerifier.ts`, `electron/conscious/ConsciousStreamingHandler.ts`, `electron/cache/EnhancedCache.ts`, `electron/prefetch/PredictivePrefetcher.ts`, `electron/ConsciousMode.ts`.
- **Dependencies**: None.
- **Exit criteria**: All Wave-1 accuracy tickets (NAT-001..NAT-009) merged; new fault-injection test suite for stale-state paths green; `npm run eval:conscious` baseline equal or better.

### EPIC-02 — Critical stealth fixes
- **Objective**: Remove the highest-impact stealth fingerprints and forensic artifacts.
- **Scope**: `electron/stealth/StealthManager.ts`, `electron/main.ts` logging path.
- **Dependencies**: EPIC-20a fixture availability.
- **Exit criteria**: Opacity flicker disabled; debug log relocated and redacted; release-build smoke test confirms no `~/Documents/natively_debug.log` is created.

### EPIC-03 — Critical reliability and lifecycle fixes
- **Objective**: Close memory leaks, unbounded growth, and shutdown bugs that destabilize long sessions.
- **Scope**: `electron/memory/TieredMemoryManager.ts`, `electron/SessionTracker.ts`, `electron/cache/ParallelContextAssembler.ts`, `electron/runtime/WorkerPool.ts`, `native-module/src/lib.rs`, `electron/db/DatabaseManager.ts`, `electron/main.ts`, `electron/runtime/SupervisorBus.ts`.
- **Dependencies**: None.
- **Exit criteria**: All Wave-1 reliability tickets merged; soak test (`npm run test:soak`) shows bounded RSS over 4-hour run; clean shutdown leaves no zombie helper processes.

### EPIC-04 — Cache invalidation correctness
- **Objective**: Stop one-key delete from clearing the entire enhanced cache.
- **Scope**: `electron/cache/EnhancedCache.ts`, `electron/cache/CacheFactory.ts`.
- **Dependencies**: None.
- **Exit criteria**: Per-key delete works; `cache.global_clear_calls` metric stays at 0 in normal operation.

### EPIC-05 — Stealth layer hardening
- **Objective**: Apply protection earlier, on more surfaces, with stronger countermeasures and honest health reporting.
- **Scope**: `electron/stealth/StealthRuntime.ts`, `electron/WindowHelper.ts`, `electron/stealth/MacosStealthEnhancer.ts`, `electron/stealth/StealthManager.ts`, `electron/runtime/StealthSupervisor.ts`, `electron/stealth/PrivacyShieldRecoveryController.ts`, `electron/stealth/MacosVirtualDisplayClient.ts`, `electron/stealth/separateProjectContracts.ts`, `electron/stealth/ChromiumCaptureDetector.ts`, `electron/services/InstallPingManager.ts`, `electron/stealth/StealthStateMachine.ts`, `src/App.tsx`.
- **Dependencies**: EPIC-02, EPIC-20a.
- **Exit criteria**: Every Wave-2 stealth ticket merged; capture fixture suite (NAT-082) reports no protection gap; PrivacyShield UI is visually generic; helper binaries renamed and env-sanitized.

### EPIC-06 — IPC, cancellation, and stream control plumbing
- **Objective**: Provide end-to-end request lifecycle: identifier, abort, tier, backpressure, typed errors.
- **Scope**: `electron/ipcHandlers.ts`, `electron/ipcValidation.ts`, `electron/preload.ts`, `electron/LLMHelper.ts`, `electron/IntelligenceEngine.ts`, `src/lib/*` renderer chat clients.
- **Dependencies**: EPIC-01.
- **Exit criteria**: Renderer can cancel an in-flight stream within 250 ms; `qualityTier` selectable end to end; Ollama errors propagate as typed events; new tests cover cancel and per-request channels.

### EPIC-07 — Audio pipeline quality
- **Objective**: Replace decimation with proper resampling, stop synthesizing finals from interim, surface drops, and add ABI guard.
- **Scope**: `electron/audio/pcm.ts`, `electron/audio/ElevenLabsStreamingSTT.ts`, `electron/audio/DeepgramStreamingSTT.ts`, `electron/audio/nativeModule.ts`, `native-module/src/*`.
- **Dependencies**: None.
- **Exit criteria**: Polyphase resample in native module; STT drop counters surfaced; ABI mismatch yields actionable error; UtteranceEnd does not synthesize finals.

### EPIC-08 — Conscious mode hygiene
- **Objective**: Tighten verifier, planner, context windowing, and post-processing without reshaping architecture.
- **Scope**: `electron/conscious/ConsciousProvenanceVerifier.ts` (extend NAT-004), `electron/conscious/AnswerHypothesisStore.ts`, `electron/conscious/ConsciousVerifier.ts`, `electron/conscious/AdaptiveContextWindow.ts`, `electron/conscious/ConsciousPreparationCoordinator.ts`, `electron/conscious/TokenBudget.ts`, `electron/llm/transcriptCleaner.ts`, `electron/llm/postProcessor.ts`, `electron/conscious/ResponseFingerprint.ts`, `electron/conscious/ConsciousResponseCoordinator.ts`.
- **Dependencies**: EPIC-01.
- **Exit criteria**: Verifier uses real token counter; cleaner preserves casing; clamp preserves prose newlines; recency-floor in adaptive window; fingerprinter wired into emit path.

### EPIC-09 — Foundation Models persistent helper
- **Objective**: Replace per-call `spawn` with a long-lived helper subprocess using a line protocol.
- **Scope**: `applesilicon/macos-foundation-intent-helper/Sources/main.swift`, `electron/llm/providers/FoundationModelsIntentProvider.ts`, `electron/llm/providers/FoundationModelsIntentHelperPath.ts`, `scripts/run-foundation-intent-latency-spike.js`.
- **Dependencies**: EPIC-06 (typed cancellation surface).
- **Exit criteria**: Latency benchmark shows ≥40% p99 reduction; helper crash auto-recovers within 1 s; legacy fallback unchanged on non-eligible hosts.

### EPIC-10 — LiveRAG indexer to worker
- **Objective**: Move chunk insert and embedding loop off the orchestration thread.
- **Scope**: `electron/rag/LiveRAGIndexer.ts`, `electron/rag/VectorStore.ts`, `electron/rag/EmbeddingPipeline.ts`, `electron/rag/vectorSearchWorker.ts`.
- **Dependencies**: None.
- **Exit criteria**: Main-thread tick time drops below 5 ms p95 during heavy meetings; embedding throughput increases via batching.

### EPIC-11 — Unified conscious thread model
- **Objective**: Collapse design-thread vs reasoning-thread duality into a single `ConversationThread` with one director.
- **Scope**: `electron/conscious/ConsciousThreadStore.ts`, `electron/conscious/ThreadManager.ts`, `electron/conscious/ConsciousOrchestrator.ts`, `electron/ConsciousMode.ts`.
- **Dependencies**: EPIC-08.
- **Exit criteria**: Single source of truth; `thread:reset` event consumed by every dependent; structural test asserts both views agree.

### EPIC-12 — Unified Intent Confidence Service
- **Objective**: One calibrated `IntentConfidenceService` exposing a single threshold table, single staleness model, and single cancellation surface.
- **Scope**: `electron/llm/IntentClassifier.ts`, `electron/llm/providers/IntentClassificationCoordinator.ts`, `electron/conscious/ConsciousIntentService.ts`, `electron/conscious/ConsciousAccelerationOrchestrator.ts`.
- **Dependencies**: EPIC-09.
- **Exit criteria**: Two threshold constants (0.55 and 0.82) replaced by one calibration map; every intent consumer uses the service; eval (`npm run eval:intent:multi`) baseline equal or better.

### EPIC-13 — Unified Route Director
- **Objective**: Single `RouteDirector` exposing `runTurn(turnId, transcriptRevision, deadlineMs, abortSignal)`; supports parallel candidate generation with first-valid-wins and hard cancel.
- **Scope**: `electron/latency/answerRouteSelector.ts`, `electron/inference/InferenceRouter.ts`, `electron/conscious/ConsciousAccelerationOrchestrator.ts`, `electron/IntelligenceEngine.ts`, `electron/inference/FastDraftLane.ts`, `electron/inference/QualityLane.ts`, `electron/inference/VerificationLane.ts`, `electron/runtime/RuntimeBudgetScheduler.ts`.
- **Dependencies**: EPIC-06, EPIC-12.
- **Exit criteria**: Single entry point used by all answer paths; revision tag enforced as one invariant; EDF scheduling honors `budgetDeadlineMs`.

### EPIC-14 — Unified cache layer
- **Objective**: One `Cache` interface with per-key delete, byte+count eviction, optional revision-prefix semantic fallback.
- **Scope**: `electron/cache/CacheFactory.ts`, `electron/cache/EnhancedCache.ts`, `electron/conscious/ConsciousCache.ts`, all consumers.
- **Dependencies**: EPIC-04.
- **Exit criteria**: All caches share interface; `maxMemoryMB` enforced; semantic fallback bound to revision and session id; metrics report hit rate per cache.

### EPIC-15 — Event-sourced session memory
- **Objective**: Wire `EventCheckpointPolicy`; persist transcript as append-only events; in-memory tiers stay bounded; cold reads come from disk on demand.
- **Scope**: `electron/memory/EventCheckpointPolicy.ts`, `electron/memory/SessionPersistence.ts`, `electron/SessionTracker.ts`, `electron/MeetingPersistence.ts`, `electron/MeetingCheckpointer.ts`.
- **Dependencies**: EPIC-03.
- **Exit criteria**: Session file size bounded; crash mid-write recovers cleanly; cold-on-demand path covered by tests.

### EPIC-16 — STT diarization or multichannel
- **Objective**: Reduce cross-talk between mic and system audio pipelines.
- **Scope**: `electron/audio/DeepgramStreamingSTT.ts`, `electron/audio/SonioxStreamingSTT.ts`, `electron/main.ts` STT setup, `native-module/src/*` echo-cancellation.
- **Dependencies**: EPIC-07.
- **Exit criteria**: Either diarized single session for supporting providers, or echo-cancellation in native module; diarization fixture passes.

### EPIC-17 — Unified HelperHost pattern
- **Objective**: Long-lived, line-protocol, code-sign-verified, env-sanitized helper supervision shared by Foundation and virtual display helpers.
- **Scope**: `electron/runtime/HelperHost.ts` (new), `electron/llm/providers/FoundationModelsIntentProvider.ts`, `electron/stealth/MacosVirtualDisplayClient.ts`, `electron/runtime/RuntimeCoordinator.ts`.
- **Dependencies**: EPIC-09.
- **Exit criteria**: Single helper-host module owns spawn, supervision, attestation; both helpers ported.

### EPIC-18 — Unified `ProviderClient` interface
- **Objective**: One `(request, AbortSignal) → AsyncIterable<Token | Error>` contract with a single retry/timeout wrapper layer.
- **Scope**: `electron/LLMHelper.ts`, `electron/llm/providers/*`.
- **Dependencies**: EPIC-06, EPIC-13.
- **Exit criteria**: All provider entry points implement `ProviderClient`; retry/timeout policy lives in one wrapper; never yields strings as errors.

### EPIC-19 — Mega-file decomposition
- **Objective**: Split files >1000 LOC into cohesive modules without behavior change.
- **Scope**: `electron/LLMHelper.ts` (5k), `electron/main.ts` (3.6k), `electron/SessionTracker.ts` (2.2k), `electron/stealth/StealthManager.ts` (1.6k), `electron/ipcHandlers.ts` (1.5k), `electron/services/ModelVersionManager.ts` (1.2k), `electron/preload.ts` (1.1k).
- **Dependencies**: Waves 1–3 complete.
- **Exit criteria**: Each split file <600 LOC per module; barrel exports preserve public API; `npm run test:electron` green.

### EPIC-20 — Test, fixtures, and observability infrastructure
- **Objective**: Provide the test fixtures, fault-injection harness, and metrics needed by every other epic.
- **Scope**: `electron/tests/*`, `scripts/*`, observability emitters across the runtime.
- **Dependencies**: None for sub-epic 20a; later sub-epics depend on respective production code.
- **Exit criteria**: Stealth capture fixtures, conscious end-to-end harness, fault-injection runner, and metrics catalog all in place; `npm run test:electron:coverage` ≥ existing baseline.

---

## 3. Tickets

> Format used: ID, title, parent epic, priority, type, goal, affected files, dependencies, implementation steps, acceptance criteria, validation, rollout notes, definition of done.

---

### EPIC-01 — Critical accuracy fixes

#### NAT-001 [x] — Add commit-token discipline to speculative path

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-1
- **Goal**: An invalidated or stale speculative entry will never surface as the final answer.
- **Affected files**:
  - `electron/conscious/ConsciousAccelerationOrchestrator.ts`
  - `electron/IntelligenceEngine.ts`
- **Dependencies**: None
- **Implementation steps**:
  1. Will add `commitToken: number` to the `SpeculativeEntry` type in `ConsciousAccelerationOrchestrator.ts` near the existing `generation` field.
  2. Will initialize `commitToken` to a monotonically increasing value sourced from a private `nextCommitToken++` counter on entry creation in `maybeStartSpeculativeAnswer`.
  3. Will bump every entry's `commitToken` whenever `invalidateSpeculation()` runs (lines 639–653).
  4. Will return `commitToken` as a top-level field of the `SpeculativeAnswerPreview` returned by `getSpeculativeAnswerPreview`.
  5. Will accept an optional `expectedCommitToken: number` argument on `finalizeSpeculativeAnswer(key, timeoutMs, expectedCommitToken)`. If the stored entry's token does not match, the method will resolve with `{ kind: 'abandoned', reason: 'commit_token_mismatch' }`.
  6. Will update `IntelligenceEngine.ts` (lines 978–1078) to:
     - capture `preview.commitToken` immediately after `getSpeculativeAnswerPreview`,
     - pass it to `finalizeSpeculativeAnswer`,
     - on `{ kind: 'abandoned' }` or `null`, skip the final emit, skip `addAssistantMessage`, mark `latencyTracker.markAbandoned(requestId)`, and return false from `runWhatShouldISay`.
  7. Will add a counter `metrics.speculativeAbandoned` (telemetry per EPIC-20).
- **Acceptance criteria**:
  - [ ] No code path emits `suggested_answer` after a speculation is invalidated.
  - [ ] Preview chunks already shown will be visually replaced by the next valid answer (UI behavior unchanged: assistant message append is the gating commit point).
  - [ ] Existing speculative-success tests still pass.
- **Validation**:
  - Will add `electron/tests/speculativeFinalizeAbandonment.test.ts` that:
    - opens an entry, retrieves preview, calls `invalidateSpeculation()`, then calls `finalizeSpeculativeAnswer` and asserts the engine returns false and never sends `suggested_answer`.
  - Will run `npm run test:electron` and confirm the new test passes.
- **Rollout notes**: Behavior change only on the rare race window; safe to ship without flag.
- **Definition of done**: standard DoD plus telemetry counter visible in local logs.

#### NAT-002 [x] — Remove semantic fallback from speculative entry selection

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-2
- **Goal**: A speculative entry will be chosen only when the normalized question matches exactly.
- **Affected files**: `electron/conscious/ConsciousAccelerationOrchestrator.ts` (lines 366–394, `selectSpeculativeEntry`).
- **Dependencies**: None
- **Implementation steps**:
  1. Will remove the cosine-similarity fallback branch.
  2. Will keep the normalized exact-match branch.
  3. Will retain the embedding computation for telemetry and emit a `speculative.semantic_near_miss` log when a similarity ≥ 0.72 entry exists but no exact match (so we keep visibility into reuse opportunities).
  4. Will add an explicit comment marking the prior 0.72 threshold as deliberately removed for accuracy.
- **Acceptance criteria**:
  - [ ] `selectSpeculativeEntry` returns either an exact match or `null`.
  - [ ] Tests previously asserting cosine-fallback selection are deleted or rewritten to assert the new behavior.
- **Validation**:
  - Will run `npm run test:electron`.
  - Will add a test `selectSpeculativeEntry_exactMatchOnly.test.ts` that registers two entries with cosine 0.85 and asserts `selectSpeculativeEntry` returns `null` for a non-exact query.
- **Rollout notes**: Slight reduction in speculative hit-rate is expected and accepted.
- **Definition of done**: standard DoD.

#### NAT-003 [x] — Bind prefetched-context cache lookups to transcript revision

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-3
- **Goal**: A semantic match in `EnhancedCache` will not return another query's prefetched context.
- **Affected files**:
  - `electron/cache/EnhancedCache.ts` (lines 118–143, `findSimilar`).
  - `electron/prefetch/PredictivePrefetcher.ts` (lines 339–351, `getContext`).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a required `bindKeyPrefix: string` argument to `EnhancedCache.findSimilar(query, embedding, bindKeyPrefix)`.
  2. Will modify `findSimilar` to filter candidate entries to those whose key starts with `bindKeyPrefix`.
  3. Will update `PredictivePrefetcher` to pass `bindKeyPrefix = `prefetch:${transcriptRevision}:`` for any prefetch lookup.
  4. Will update `PredictivePrefetcher` cache `set()` calls so keys also use that prefix.
  5. Will assume no other callers of `findSimilar` exist; will grep `rg "findSimilar" electron` to confirm; will update any other call site to pass an explicit prefix.
- **Acceptance criteria**:
  - [ ] All `findSimilar` call sites pass an explicit `bindKeyPrefix`.
  - [ ] Tests in `electron/tests/predictivePrefetcher*.test.ts` continue to pass.
- **Validation**:
  - Will add `electron/tests/enhancedCacheBindKeyPrefix.test.ts` that asserts an entry stored under prefix A is not returned for a query under prefix B even when embeddings match exactly.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-004 [x] — Make `ConsciousProvenanceVerifier` fail closed on empty grounding and exclude question text from relaxed check

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original findings**: A-4, A-9
- **Goal**: The provenance verifier will never fail open when there is no strict grounding context, and will never accept the question text as substitute grounding.
- **Affected files**: `electron/conscious/ConsciousProvenanceVerifier.ts` (lines 204–238, 251–255).
- **Dependencies**: None
- **Implementation steps**:
  1. Will introduce helper `responseHasTechnologyOrMetricClaim(response: string): boolean` (regex over the existing tech/metric token sets used elsewhere in the verifier).
  2. Will replace the early-exit at lines 233–238 with:
     - if `!hasStrictGroundingContext` and `responseHasTechnologyOrMetricClaim(response)` → return `{ ok: false, reason: 'unsupported_grounding', recommendedShape: 'clarification_answer' }`.
     - if `!hasStrictGroundingContext` and no claim → return `{ ok: true, mode: 'no_grounding' }`.
  3. Will remove the `relaxed = strict + question` construction.
  4. Will run unsupported-term checks against `strict` only.
  5. Will keep the `hypothesis` parameter and use it to *narrow* allowed proper-noun set when present.
- **Acceptance criteria**:
  - [ ] No `verify()` return path produces `{ ok: true }` when grounding is empty *and* the response contains tech/metric claims.
  - [ ] Existing verifier tests updated; new tests cover empty-grounding-with-claim and empty-grounding-without-claim.
- **Validation**:
  - Will add tests in `electron/tests/consciousProvenanceVerifier.test.ts` for the two empty-grounding cases.
  - Will run `npm run test:electron` and `npm run eval:conscious` and confirm pass-rate is not lower than baseline (baseline captured in NAT-082 before merge).
- **Rollout notes**: This will increase fallback rate on cold sessions until profile data loads; that is the intended behavior.
- **Definition of done**: standard DoD.

#### NAT-005 [x] — Confidence-gate prefetched intent storage and re-classify on weak prefetch

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-5
- **Goal**: Low-confidence prefetched intents will not silently drive planner/answer-shape selection.
- **Affected files**:
  - `electron/conscious/ConsciousAccelerationOrchestrator.ts` (lines 509–557, `maybePrefetchIntent`).
  - `electron/conscious/ConsciousIntentService.ts` (lines 58–64, `resolve`).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a constant `MIN_PREFETCH_CONFIDENCE = 0.82` in `ConsciousAccelerationOrchestrator.ts` (matches `DEFAULT_MINIMUM_PRIMARY_CONFIDENCE` from `IntentClassificationCoordinator.ts`).
  2. Will short-circuit `maybePrefetchIntent` before storing the result if `result.confidence < MIN_PREFETCH_CONFIDENCE` or `isUncertainConsciousIntent(result.intent)` is true.
  3. Will modify `ConsciousIntentService.resolve(input)` so when `prefetchedIntent` exists but `isUncertainConsciousIntent(prefetchedIntent)` is true, the service runs `classifyIntent(input.transcript)` and uses the fresh result (still emitting telemetry that the prefetch was discarded).
  4. Will emit `intent.prefetch_discarded_low_confidence` log/metric.
- **Acceptance criteria**:
  - [ ] `prefetchedIntents` map never contains entries below threshold.
  - [ ] `resolve()` re-classifies on weak prefetch.
- **Validation**:
  - Will add `electron/tests/intentPrefetchConfidenceGate.test.ts` covering: (a) below-threshold result is not stored; (b) above-threshold result is stored; (c) resolve re-classifies on weak prefetch.
  - Will run `npm run test:electron` and `npm run eval:intent`.
- **Definition of done**: standard DoD.

#### NAT-006 [x] — Require `final === true` for auto-trigger speculative answers

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-6
- **Goal**: Hypothetical (interim) transcripts will not trigger downstream answers.
- **Affected files**:
  - `electron/ConsciousMode.ts` (lines 613–630, auto-trigger gate).
  - `electron/main.ts` (lines 1403–1408, transcript handler).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add an early `if (!input.final) return;` to the auto-trigger function in `ConsciousMode.ts`.
  2. Will retain the `confidence < 0.5` rejection as belt-and-suspenders.
  3. Will leave the `speculative` boolean in place but always derive it from `input.final` semantics.
  4. Will assume STT providers' `final` field is reliable; will add an integration assertion in NAT-082 fixture.
- **Acceptance criteria**:
  - [ ] No call to `handleSuggestionTrigger` originates from an interim transcript.
- **Validation**:
  - Will add `electron/tests/autoTriggerFinalOnly.test.ts` driving an interim and a final transcript and asserting only the final triggers `handleSuggestionTrigger`.
  - Will run `npm run test:electron`.
- **Rollout notes**: This will slightly raise median trigger latency. The follow-on EPIC-13 RouteDirector will recover that with explicit speculative branching, gated correctly.
- **Definition of done**: standard DoD.

#### NAT-007 [x] — Add transcript-revision staleness check to main streaming path

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-7
- **Goal**: A streaming answer for an outdated turn will be cancelled mid-stream.
- **Affected files**: `electron/IntelligenceEngine.ts` (lines 865–869 `shouldSuppressVisibleWork`, lines 1141–1164 and 1528–1551 token loops).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a `transcriptRevisionAtStart: number` snapshot at the start of each `runWhatShouldISay`/`runStandardAnswer` invocation.
  2. Will extend `shouldSuppressVisibleWork(requestId, transcriptRevisionAtStart)` so it also returns true when `session.getTranscriptRevision() !== transcriptRevisionAtStart`.
  3. Will pass `transcriptRevisionAtStart` to all current callers of `shouldSuppressVisibleWork` in the file.
  4. Will add a `latencyTracker.markStaleStop(requestId)` when stopping due to revision change.
- **Acceptance criteria**:
  - [ ] Token loops break on revision change.
  - [ ] `addAssistantMessage` is not called for stale-stopped streams.
- **Validation**:
  - Will add `electron/tests/streamRevisionStaleStop.test.ts` driving a revision bump mid-stream and asserting no further tokens are emitted.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-008 [x] — `ConsciousStreamingHandler.start()` aborts the previous controller

- **Parent epic**: EPIC-01
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: A-8
- **Goal**: Restarting a stream will cancel the prior stream cleanly; cross-turn token interleaving will not occur.
- **Affected files**: `electron/conscious/ConsciousStreamingHandler.ts` (lines 119–132, 154–188, 426–430).
- **Dependencies**: None
- **Implementation steps**:
  1. Will modify `start()` to call `this.abortController?.abort()` before constructing a new controller, when the existing controller is not already aborted.
  2. Will await any pending `emit({ type: 'cancelled', ... })` before proceeding so handlers see cancellation in order.
  3. Will add a per-handler stream id passed into `streamReasoning` and chunk loops so handlers can ignore stale ids.
- **Acceptance criteria**:
  - [ ] Two consecutive `start()` calls produce a single `cancelled` event for the first stream and zero stale chunks reaching handlers.
- **Validation**:
  - Will add `electron/tests/consciousStreamingHandlerRestart.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-009 [x] — Drop Deepgram `UtteranceEnd`-synthesized finals

- **Parent epic**: EPIC-01
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: A-10
- **Goal**: Only provider-marked `is_final` transcripts will be emitted as final.
- **Affected files**: `electron/audio/DeepgramStreamingSTT.ts` (lines 287–295).
- **Dependencies**: None
- **Implementation steps**:
  1. Will remove the synthetic `isFinal: true` emission on `UtteranceEnd`.
  2. Will keep the `lastInterimTranscript` reset on `UtteranceEnd` for UI state hygiene.
  3. Will emit `stt.utterance_end_seen` telemetry for parity tracking.
- **Acceptance criteria**:
  - [ ] No `final` event is emitted unless the underlying Deepgram message had `is_final: true`.
- **Validation**:
  - Will update existing Deepgram tests in `electron/audio/__tests__` (or `electron/tests/deepgram*.test.ts`) and add a new test asserting `UtteranceEnd` does not produce a `final` event when last `Results` was not final.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-02 — Critical stealth fixes

#### NAT-010 [x] — Disable the 500 ms opacity flicker

- **Parent epic**: EPIC-02
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: S-1
- **Goal**: The deterministic 500 ms opacity-pattern fingerprint will be removed.
- **Affected files**: `electron/stealth/StealthManager.ts` (lines 1437–1474).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a config flag `enableOpacityFlicker: boolean` defaulting to `false` on `StealthManager` options.
  2. Will guard `ensureOpacityFlicker()` and `applyOpacityFlicker()` behind that flag.
  3. Will keep the methods callable as one-shot operations on a future `bus:capture-start-detected` event (subscriber wiring is out of scope here; will be added in NAT-082 fixture work).
  4. Will remove the `[StealthManager] macOS 15.4+ opacity flicker enabled` log line when disabled.
- **Acceptance criteria**:
  - [ ] No `setInterval` flicker is scheduled in any default code path.
- **Validation**:
  - Will add `electron/tests/stealthOpacityFlickerDisabled.test.ts` asserting `intervalScheduler` is not called for opacity flicker on a default `StealthManager` instance.
  - Will run `npm run test:electron`.
- **Rollout notes**: If a future capture-bypass test fixture proves the flicker is needed, the flag can be enabled with jittered period; that work is captured in EPIC-05.
- **Definition of done**: standard DoD.

#### NAT-011 [x] — Relocate and redact debug log in release builds

- **Parent epic**: EPIC-02
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: S-5
- **Goal**: No identifiable Natively log file will be written to `~/Documents` in release builds.
- **Affected files**: `electron/main.ts` (lines 46–193, 511–519, 536–542).
- **Dependencies**: None
- **Implementation steps**:
  1. Will replace the log path with `app.getPath('userData')` + `Logs/natively-${date}.log`.
  2. Will gate the file logging entirely behind an env flag `NATIVELY_DEBUG_LOG=1`. In release builds without the flag, file logging is off.
  3. Will introduce a small redactor `redactStealthSubstrings(line: string): string` that strips known stealth-related strings (regex set defined in a new `electron/stealth/logRedactor.ts`).
  4. Will pipe every line through the redactor before write.
  5. Will rotate at 10 MB, keep 3 (existing rotation logic preserved).
- **Acceptance criteria**:
  - [ ] Default release build creates no log file.
  - [ ] With `NATIVELY_DEBUG_LOG=1`, log file appears under `userData/Logs/`.
  - [ ] No string from the redactor list appears in any written log line.
- **Validation**:
  - Will add `electron/tests/logRedactor.test.ts` covering the redactor.
  - Will add a smoke test in `scripts/smoke-test-release-logging.js` that builds an app stub and confirms no log file is created without the flag.
  - Will run `npm run test:electron`.
- **Rollout notes**: Existing debug guides will be updated to reference the new path and env flag (small docs change in `DEPLOYMENT.md`, ticket NAT-012 covers).
- **Definition of done**: standard DoD plus updated docs.

#### NAT-012 [x] — Update `DEPLOYMENT.md` and `AGENTS.md` with new debug-log location

- **Parent epic**: EPIC-02
- **Priority**: P1
- **Type**: docs
- **Original finding**: derived from S-5
- **Goal**: Operators and developers will know where logs live and how to enable them.
- **Affected files**: `DEPLOYMENT.md`, `AGENTS.md`.
- **Dependencies**: NAT-011
- **Implementation steps**:
  1. Will add a "Debug logging" subsection to `DEPLOYMENT.md` documenting the env flag and path.
  2. Will add a one-line note to `AGENTS.md` that file logging is off by default and how to enable it.
- **Acceptance criteria**: Docs updated and rendered correctly.
- **Validation**: visual review.
- **Definition of done**: standard DoD.

---

### EPIC-03 — Critical reliability and lifecycle fixes

#### NAT-013 [x] — Bound `TieredMemoryManager.coldEntries` after persist

- **Parent epic**: EPIC-03
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: R-1
- **Goal**: Cold-tier in-memory list will not grow without bound across long sessions.
- **Affected files**: `electron/memory/TieredMemoryManager.ts` (lines 78–112).
- **Dependencies**: None
- **Implementation steps**:
  1. Will modify `enforceCeilings` so that after `await this.persistCold?.(coldBatch)` succeeds, every entry in `coldBatch` is removed from `this.coldEntries`.
  2. Will add a hard fallback cap `MAX_COLD_IN_MEMORY = 1024` entries — when over, drop oldest regardless of persist outcome (with a warn log).
  3. Will preserve the snapshot semantics of `getColdState()` (still returns a copy of current memory-resident entries).
- **Acceptance criteria**:
  - [ ] After 10 MB of cold pressure with a stub `persistCold`, `coldEntries.length` is bounded by `MAX_COLD_IN_MEMORY`.
- **Validation**:
  - Will add `electron/tests/tieredMemoryColdBound.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-014 [x] — Apply memory ceiling to `SessionTracker.getColdState`

- **Parent epic**: EPIC-03
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: R-2
- **Goal**: Persisted session JSON will not grow without bound on long meetings.
- **Affected files**: `electron/SessionTracker.ts` (lines 1567–1577 `applyMemoryCeiling`, lines 1625–1634 `getColdState`, lines 1710–1748 `buildPersistedSession`).
- **Dependencies**: None
- **Implementation steps**:
  1. Will introduce a new constant `COLD_MEMORY_CEILING_BYTES = 8 * 1024 * 1024`.
  2. Will modify `getColdState` to call `applyMemoryCeiling(coldEntries, COLD_MEMORY_CEILING_BYTES)`.
  3. Will retain a separate path to write overflow cold rows to disk via the existing `MeetingPersistence` (placeholder for EPIC-15 event-sourced path).
- **Acceptance criteria**:
  - [ ] `getColdState()` never returns more than `COLD_MEMORY_CEILING_BYTES` worth of entries.
  - [ ] Persisted session file size for a 4-hour soak stays under the ceiling.
- **Validation**:
  - Will add `electron/tests/sessionTrackerColdCeiling.test.ts`.
  - Will run `npm run test:soak` and visually confirm RSS plateau.
- **Definition of done**: standard DoD.

#### NAT-015 [x] — Terminate workers in `ParallelContextAssembler`

- **Parent epic**: EPIC-03
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: R-3
- **Goal**: No `Worker` thread will leak per context-assembly call.
- **Affected files**: `electron/cache/ParallelContextAssembler.ts` (lines 148–158, 278–280).
- **Dependencies**: None
- **Implementation steps**:
  1. Will wrap `runInWorker` in a `try { … } finally { await worker.terminate(); }`.
  2. Will implement `terminate()` on the assembler to noop (kept for API compatibility).
  3. Will mark a `// TODO(NAT-XXX)` follow-up to migrate to `WorkerPool` reuse in EPIC-10/EPIC-13.
- **Acceptance criteria**:
  - [ ] Repeated `assemble(...)` calls leak no worker threads (verified by `process._getActiveHandles().length` not growing).
- **Validation**:
  - Will add `electron/tests/parallelContextAssemblerNoLeak.test.ts` that runs 100 assemblies and asserts handle count is bounded.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-016 [x] — Bound `WorkerPool` task queue with admission control

- **Parent epic**: EPIC-03
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: R-4
- **Goal**: A burst of submissions will be rejected, not queued without bound.
- **Affected files**: `electron/runtime/WorkerPool.ts` (lines 63–84).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a constructor option `maxQueueDepth: number` defaulting to 1024 per pool.
  2. Will change `submit` to reject with `new Error('worker_pool_queue_full')` when `queue.length >= maxQueueDepth`.
  3. Will emit a `worker_pool.queue_depth` gauge (logged).
- **Acceptance criteria**:
  - [ ] Submitting 2× the cap rejects the overflow synchronously.
- **Validation**:
  - Will add `electron/tests/workerPoolBoundedQueue.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-017 [x] — Switch native module ThreadsafeFunction to `NonFatal` and add panic boundary

- **Parent epic**: EPIC-03
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: R-5
- **Goal**: A panic in the audio DSP thread will not abort Electron.
- **Affected files**: `native-module/src/lib.rs` (lines 120–127, 327–334) and any other ThreadsafeFunction declaration in `native-module/src/`.
- **Dependencies**: None
- **Implementation steps**:
  1. Will change every `ThreadsafeFunction::create(...)` in the crate from `ErrorStrategy::Fatal` to `ErrorStrategy::CalleeHandled`.
  2. Will wrap the audio DSP thread body in `std::panic::catch_unwind(AssertUnwindSafe(|| { … }))` and on panic emit a typed `'audio_thread_panic'` event up to JS.
  3. Will add a JS-side handler in `electron/audio/nativeModule.ts` that logs and triggers `STTReconnector` (so audio recovers).
  4. Will add `cargo test` cases that simulate panic via a feature flag.
- **Acceptance criteria**:
  - [ ] Inducing a panic in test mode does not exit the process.
  - [ ] JS receives a typed error event.
- **Validation**:
  - Will run `cargo test --manifest-path native-module/Cargo.toml`.
  - Will add `electron/tests/nativeAudioPanicRecovery.test.ts` that uses a stub native module to assert the recovery path.
- **Definition of done**: standard DoD.

#### NAT-018 [x] — Add `DatabaseManager.close()` and call from shutdown

- **Parent epic**: EPIC-03
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: R-6
- **Goal**: SQLite WAL will be cleanly checkpointed on shutdown.
- **Affected files**: `electron/db/DatabaseManager.ts`, `electron/main.ts` (`cleanupForQuit` 2193–2293; `before-quit` handler).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add `public close(): void` on `DatabaseManager` that calls `this.db?.close()` and nulls the handle.
  2. Will call `dbManager.close()` from `cleanupForQuit` after `waitForPendingSaves`.
  3. Will register an `app.on('before-quit', …)` if not already present that calls `cleanupForQuit` synchronously.
- **Acceptance criteria**:
  - [ ] After quit, no `*.db-wal` / `*.db-shm` files remain in user-data dir following a graceful shutdown.
- **Validation**:
  - Will add `electron/tests/databaseManagerCloseOnShutdown.test.ts` that opens a DB, calls close, and asserts no error on subsequent re-open.
- **Definition of done**: standard DoD.

#### NAT-019 [x] — Add token batching and destroyed-sender guard to streaming chat IPC

- **Parent epic**: EPIC-03
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: R-7
- **Goal**: The renderer will not be flooded by per-token IPC messages.
- **Affected files**: `electron/ipcHandlers.ts` (lines 423–461).
- **Dependencies**: None (will be subsumed by EPIC-06 NAT-029 but useful as immediate mitigation).
- **Implementation steps**:
  1. Will introduce an in-handler micro-batcher that flushes every 16 ms or every 32 tokens, whichever first.
  2. Will check `event.sender.isDestroyed()` before each flush; on destroyed, abort the loop.
- **Acceptance criteria**:
  - [ ] No more than 64 IPC sends per second per stream under high token rate.
  - [ ] No `Object has been destroyed` errors observed in logs.
- **Validation**:
  - Will add `electron/tests/streamChatIpcBackpressure.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-020 [x] — Make `SupervisorBus.emit` non-throwing on listener errors

- **Parent epic**: EPIC-03
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: R-10
- **Goal**: A buggy subscriber will not abort lifecycle events for everyone else.
- **Affected files**: `electron/runtime/SupervisorBus.ts` (lines 69–109).
- **Dependencies**: None
- **Implementation steps**:
  1. Will remove the `if (errors.length > 0 && isCriticalEvent) throw …` block.
  2. Will instead emit a synthetic `'bus:listener-error'` event on the same bus carrying the original event type and the listener errors.
  3. Will add a per-listener circuit breaker: after 3 consecutive listener errors within 30 s, the listener is unsubscribed and a `'bus:listener-circuit-open'` event is emitted.
- **Acceptance criteria**:
  - [ ] Listener throwing 5× in a row does not interrupt other listeners; on the 4th call it is auto-unsubscribed.
- **Validation**:
  - Will add `electron/tests/supervisorBusResilience.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-021 [x] — Surface STT bounded-queue drops as metrics

- **Parent epic**: EPIC-03
- **Priority**: P2
- **Type**: feature
- **Original finding**: R-11
- **Goal**: Silent audio loss under backpressure becomes visible in observability.
- **Affected files**:
  - `electron/audio/DeepgramStreamingSTT.ts` (lines 40–48)
  - `electron/audio/GoogleSTT.ts` (lines 163–164)
  - `electron/audio/ElevenLabsStreamingSTT.ts` (lines 137–141)
  - `electron/audio/SonioxStreamingSTT.ts` (lines 147–149)
  - `electron/audio/OpenAIStreamingSTT.ts` (lines 581–589)
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a `private droppedFrames = 0` counter to each provider.
  2. Will increment on each ring-buffer overwrite/drop.
  3. Will emit periodic (every 5 s) `stt.dropped_frames` log lines tagged with the provider name.
- **Acceptance criteria**:
  - [ ] All five providers emit drop telemetry.
- **Validation**:
  - Will add per-provider unit tests that force overflow and assert counter increments.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-022 — Add `dispose()` to `SessionTracker` and call on handoff [x]

- **Parent epic**: EPIC-03
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: R-9
- **Goal**: Old session trackers will not retain timers or pending work after handoff.
- **Affected files**: `electron/SessionTracker.ts`, `electron/MeetingPersistence.ts`, `electron/tests/sessionTrackerDispose.test.ts`, `electron/tests/meetingPersistence.test.ts`.
- **Dependencies**: None
- **Implementation**:
  1. Added `SessionTracker.dispose(): Promise<void>` with idempotent teardown semantics:
     - marks tracker disposed
     - cancels compaction timer
     - invalidates pending restore work (`restoreRequestId += 1`)
     - clears buffered restore writes
     - awaits `flushPersistenceNow()` to persist any final state
  2. Added disposal guards so post-handoff old trackers stop accepting new transcript/assistant/supervisor work and `restoreFromMeetingId` rejects with `session_disposed`.
  3. Updated `MeetingPersistence.stopMeeting` to capture `previousSession`, create the successor, swap to the successor session, then `await previousSession.dispose()` before returning.
- **Acceptance criteria**:
  - [x] No active timers remain on the old tracker after handoff.
- **Validation**:
  - Added `electron/tests/sessionTrackerDispose.test.ts`:
    - verifies dispose clears the compaction timer
    - verifies pending restore/buffered work is rejected as `session_disposed`
  - Extended `electron/tests/meetingPersistence.test.ts` with NAT-022 handoff coverage to assert old-session `dispose()` is called.
  - `npx tsc -p electron/tsconfig.json --noEmit` — clean.
  - `npm run test:electron` — green (858 tests, 854 pass, 4 skipped, 0 fail).
- **Definition of done**: met.

#### NAT-023 — Add ABI preflight check on native audio module load [x]

- **Parent epic**: EPIC-03
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: R-13
- **Goal**: A wrong-ABI .node binary will surface an actionable error instead of a cryptic crash.
- **Affected files**: `electron/audio/nativeModule.ts`, `scripts/build-native.js`, `electron/tests/nativeAudioAbiMismatch.test.ts`.
- **Dependencies**: None
- **Implementation**:
  1. Added ABI preflight logic in `electron/audio/nativeModule.ts`:
     - read expected ABI from sibling metadata files (`*.node.abi`)
     - compare expected value to `process.versions.modules`
     - fail candidate load with actionable mismatch error:
       `Native audio ABI mismatch: built for X, runtime is Y. Run \`npm run build:native:current\`.`
  2. Added metadata emission in `scripts/build-native.js`:
     - after build, enumerate native `.node` artifacts in `native-module/`
     - write `<artifact>.abi` files containing the runtime ABI used for build
  3. Wired fallback probing to keep behavior unchanged when ABI metadata is absent (no false hard-fail for legacy artifacts).
- **Acceptance criteria**:
  - [x] Mismatch produces the actionable error.
  - [x] Match loads silently.
- **Validation**:
  - Added `electron/tests/nativeAudioAbiMismatch.test.ts` with two cases:
    - mismatch `.abi` vs runtime ABI returns actionable error
    - matching `.abi` allows module load with no ABI warning/failure
  - `npx tsc -p electron/tsconfig.json --noEmit` — clean.
  - `npm run test:electron` — green (860 tests, 856 pass, 4 skipped, 0 fail).
- **Definition of done**: met.

---

### EPIC-04 — Cache invalidation correctness

#### NAT-024 [x] — Implement per-key delete in `EnhancedCache` and stop full-clear on `delete`

- **Parent epic**: EPIC-04
- **Priority**: P0
- **Type**: bug-fix
- **Original finding**: P-14
- **Goal**: Deleting one cache key will not evict every other entry.
- **Affected files**: `electron/cache/EnhancedCache.ts`, `electron/cache/CacheFactory.ts` (lines 132–136).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add `delete(key: string): boolean` on `EnhancedCache` that removes the entry from the LRU map and any associated embedding entry.
  2. Will track key↔embedding-id binding in a private `Map<string, number>`.
  3. Will modify `EnhancedCacheAdapter.delete(key)` in `CacheFactory.ts` to call `this.enhancedCache.delete(key)` instead of `this.enhancedCache.clear()`.
  4. Will add a `clear()` adapter method that delegates to the existing full clear, kept for explicit callers.
- **Acceptance criteria**:
  - [ ] Deleting one key leaves all other entries intact.
- **Validation**:
  - Will add `electron/tests/enhancedCachePerKeyDelete.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-05 — Stealth layer hardening

#### NAT-025 [x] — Apply content protection to both shell and offscreen content windows before any load

- **Parent epic**: EPIC-05
- **Priority**: P0
- **Type**: bug-fix
- **Original findings**: S-2, S-3
- **Goal**: No window controlled by `StealthRuntime` will paint a frame before content protection is applied.
- **Affected files**: `electron/stealth/StealthRuntime.ts` (lines 122–165, 274–284), `electron/WindowHelper.ts` (lines 288–314).
- **Dependencies**: NAT-082 (capture fixture)
- **Implementation steps**:
  1. Will refactor `createPrimaryStealthSurface` so it constructs the `BrowserWindow` for both shell and content with `webPreferences.contextIsolation` and an explicit pre-load call to `setContentProtection(true)` (and `setExcludeFromCapture(true)` where supported).
  2. Will defer `loadURL` / `loadFile` until a `protected:applied` promise resolves.
  3. Will move the `applyStealth` body so it operates on both `shellWindow` and `contentWindow` whenever both exist.
  4. Will add an invariant assertion in dev builds: `assert(window.isContentProtected())` before first paint.
- **Acceptance criteria**:
  - [ ] Capture fixture (NAT-082) sees no frame from either window before protection is applied.
- **Validation**:
  - Will run NAT-082 fixture locally and confirm.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-026 [x] — Make Privacy Shield UI visually generic

- **Parent epic**: EPIC-05
- **Priority**: P0
- **Type**: refactor
- **Original finding**: S-4
- **Goal**: Captured pixels of the shield will not attribute the assistant.
- **Affected files**: `src/App.tsx` (lines 103–126), associated CSS in `src/index.css` or `src/components/`, optional new `src/components/StealthShield.tsx`.
- **Dependencies**: NAT-025
- **Implementation steps**:
  1. Will replace the labeled "Privacy Shield" / "Sensitive content hidden" view with a neutral solid-black surface mimicking macOS sleep.
  2. Will keep the underlying state machine and IPC channel `privacy-shield-changed` unchanged.
  3. Will add a build-time assertion that the shield component renders no text nodes.
- **Acceptance criteria**:
  - [ ] Visual regression: the shield contains zero text DOM nodes.
- **Validation**:
  - Will add `renderer/src/__tests__/stealthShield.test.tsx` asserting absence of text.
  - Will run `npm run test:renderer`.
- **Definition of done**: standard DoD.

#### NAT-027 [x] — Replace Chromium-capture `win.hide()` countermeasure with reapply + multi-signal corroboration

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-6
- **Goal**: A false-positive capture detection will not hide the user's UI mid-call.
- **Affected files**: `electron/stealth/ChromiumCaptureDetector.ts` (lines 26–238), `electron/stealth/StealthManager.ts` (lines 425–466).
- **Dependencies**: NAT-082
- **Implementation steps**:
  1. Will change `applyChromiumCountermeasures` to call `applyStealth()` (Layer 0/1 reapply + privacy-shield ramp), not `win.hide()`.
  2. Will require *two* corroborating signals (parentage AND window-title regex hit) before triggering, with a 1.5 s confirmation window.
  3. Will add 5 s hysteresis between detections to prevent flapping.
  4. Will start using the existing `MEETING_SITE_PATTERNS` in detection (deletes the dead-code finding).
- **Acceptance criteria**:
  - [ ] Single-signal events do not trigger countermeasure.
  - [ ] Confirmed detections trigger a single privacy-shield ramp without UI hide.
- **Validation**:
  - Will add `electron/tests/chromiumCaptureDetectorMultiSignal.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-028 [x] — Set correct `NSWindow` level / collection behavior in `MacosStealthEnhancer`

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-7
- **Goal**: The "enhanced" Layer 1 path will use the documented utility/exclusion level instead of normal level 0.
- **Affected files**: `electron/stealth/MacosStealthEnhancer.ts` (lines 42–49, 133–147), `native-module/src/stealth/*` if level setting is bridged through native.
- **Dependencies**: NAT-082
- **Implementation steps**:
  1. Will replace `setLevel_(0)` with the program-defined utility level constant (`kCGUtilityWindowLevel` equivalent: `NSWindowLevel.utility = 19`, or higher per `electron/stealth/implementation-plan.md`).
  2. Will add a fixture in NAT-082 that asserts `[NSWindow level]` matches expectation.
  3. Will document the choice with a code comment citing implementation-plan.md.
- **Acceptance criteria**:
  - [ ] Fixture assertion passes.
- **Validation**:
  - Will run NAT-082 fixture.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-029 [x] — Honest stealth health: verify hidden windows; report missing native bridge as degraded

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-8
- **Goal**: The stealth heartbeat will reflect actual protection state.
- **Affected files**: `electron/stealth/StealthManager.ts` (lines 540–555), `electron/runtime/StealthSupervisor.ts` (lines 287–290).
- **Dependencies**: None
- **Implementation steps**:
  1. Will modify `verifyManagedWindows` so hidden windows still run `verifyStealth` (only the *visibility* gate is removed, not the verification).
  2. Will modify `StealthSupervisor.heartbeatNativeStealth` so it returns `false` when `nativeBridge` is null *and* the configured stealth level requires it; otherwise `true` when not applicable.
  3. Will introduce a typed return `{ status: 'healthy' | 'degraded' | 'not_applicable' }`.
- **Acceptance criteria**:
  - [ ] Hidden windows with broken protection raise a fault.
  - [ ] Missing required bridge raises a fault rather than reporting healthy.
- **Validation**:
  - Will add `electron/tests/stealthHonestHeartbeat.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-030 [x] — Single-flight Privacy Shield recovery with atomic snapshot

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-9
- **Goal**: Recovery will not flap or re-expose during contested transitions.
- **Affected files**: `electron/stealth/PrivacyShieldRecoveryController.ts` (lines 50–117), `electron/main.ts` (lines 549–567).
- **Dependencies**: None
- **Implementation steps**:
  1. Will introduce a private `private recoveryInFlight: Promise<void> | null = null` mutex.
  2. Will wrap `recoverFullStealth` in a check: if `recoveryInFlight` exists, `return recoveryInFlight`.
  3. Will take an atomic warning snapshot, then run recovery, then re-check warnings before clearing the shield.
- **Acceptance criteria**:
  - [ ] Two concurrent recovery requests share one promise and a single underlying recovery run.
  - [ ] Shield does not clear when post-recovery warnings include capture-risk.
- **Validation**:
  - Will add `electron/tests/privacyShieldSingleFlight.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-031 [x] — Disguise virtual display helper binary and sanitize inherited environment

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-10
- **Goal**: The virtual display helper will have a generic binary name and inherit only required env vars.
- **Affected files**: `assets/bin/macos/stealth-virtual-display-helper` build script, `package.json` `extraResources` entry, `electron/stealth/MacosVirtualDisplayClient.ts` (lines 247–261, 198–203, 182–196), `electron/stealth/macosVirtualDisplayIntegration.ts`.
- **Dependencies**: None
- **Implementation steps**:
  1. Will rename the helper binary at build time to `system-services-helper` (or similar generic name) — update `scripts/prepare-macos-virtual-display-helper.js` and `package.json` `extraResources`.
  2. Will replace `env: this.helperEnv ?? process.env` with an explicit allow-list `env: pickEnv(['PATH','HOME','TMPDIR'], this.helperEnv)`.
  3. Will add a watchdog that on `isExhausted()` calls `bus.emit('stealth:helper_dead')` so supervisors can react.
- **Acceptance criteria**:
  - [ ] `ps` shows the generic binary name.
  - [ ] No API key env vars are present in the spawned process.
- **Validation**:
  - Will add `electron/tests/virtualDisplayHelperEnvSanitization.test.ts` that stubs spawn and asserts env contents.
  - Will run `npm run test:electron`.
- **Rollout notes**: Renaming binary is a build-pipeline change; will update `DEPLOYMENT.md` (NAT-012-style follow-up).
- **Definition of done**: standard DoD.

#### NAT-032 [x] — Code-sign verify helper at startup; per-session attestation nonce

- **Parent epic**: EPIC-05
- **Priority**: P2
- **Type**: feature
- **Original finding**: S-11
- **Goal**: A replaced or unsigned helper binary will not be trusted.
- **Affected files**: `electron/stealth/separateProjectContracts.ts` (lines 109–115, 218–248), `electron/stealth/MacosVirtualDisplayClient.ts`.
- **Dependencies**: NAT-031
- **Implementation steps**:
  1. Will add `verifyHelperSignature(path: string): Promise<boolean>` using `codesign --verify --deep --strict <path>` via `child_process.execFile`.
  2. Will refuse to spawn if verification fails (log + bus emit).
  3. Will add a per-session `nonce` to the JSON contract; helper must echo the nonce in every response.
- **Acceptance criteria**:
  - [ ] Tampered binary refuses to start.
  - [ ] Helper response without echoed nonce is dropped.
- **Validation**:
  - Will add `electron/tests/helperSignatureAndNonce.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-033 [x] — Disable `InstallPingManager` by default in stealth distribution

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-12
- **Goal**: No outbound install-ping will leak the app's existence on stealth builds.
- **Affected files**: `electron/services/InstallPingManager.ts` (lines 44–52, 126–158), `electron/main.ts` startup wiring.
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a build-time flag `NATIVELY_INSTALL_PING_ENABLED` (default `false` in stealth builds).
  2. Will short-circuit `InstallPingManager.maybeSendPing` when the flag is `false`.
  3. Will document the flag in `DEPLOYMENT.md`.
- **Acceptance criteria**:
  - [ ] No network call to the install-ping URL on default stealth build.
- **Validation**:
  - Will add `electron/tests/installPingDisabled.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-034 [x] — Set generic outbound `userAgent` for provider sessions

- **Parent epic**: EPIC-05
- **Priority**: P2
- **Type**: feature
- **Original finding**: S-13
- **Goal**: Outbound HTTP from the Electron `session.defaultSession` will not announce "Electron".
- **Affected files**: `electron/main.ts` (session setup near `app.whenReady`).
- **Dependencies**: None
- **Implementation steps**:
  1. Will call `session.defaultSession.setUserAgent('Mozilla/5.0 …')` after `app.whenReady`.
  2. Will whitelist the UA against known provider compatibility (verified by manual smoke test).
  3. Will keep the renderer's own UA untouched (it does not make outbound calls).
- **Acceptance criteria**:
  - [ ] No `Electron/…` substring appears in outbound HTTP `User-Agent` header from main process.
- **Validation**:
  - Will add `electron/tests/userAgentOverride.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-035 [x] — Make `StealthStateMachine` fail closed on illegal transitions

- **Parent epic**: EPIC-05
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: S-14
- **Goal**: An illegal transition will move the machine to `FAULT` and emit telemetry instead of throwing.
- **Affected files**: `electron/stealth/StealthStateMachine.ts` (lines 25–31).
- **Dependencies**: None
- **Implementation steps**:
  1. Will replace `throw new Error('Illegal stealth transition')` with `return { state: 'FAULT', reason: 'illegal_transition' }`.
  2. Will emit `stealth.illegal_transition` log/metric at the call site.
  3. Will audit all `transitionStealthState` callers in `StealthSupervisor.ts` to handle the new return shape.
- **Acceptance criteria**:
  - [ ] No uncaught exception possible from the state machine.
- **Validation**:
  - Will add `electron/tests/stealthStateMachineFailClosed.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-06 — IPC, cancellation, and stream control plumbing

#### NAT-036 [x] — Extend chat IPC schema with `requestId`, `qualityTier`, and abort channel

- **Parent epic**: EPIC-06
- **Priority**: P0
- **Type**: feature
- **Original finding**: P-1
- **Goal**: Renderer will be able to identify, cancel, and tier each chat stream end to end.
- **Affected files**: `electron/ipcValidation.ts` (lines 22–27), `electron/ipcHandlers.ts` (lines 423–461), `electron/preload.ts`, `electron/LLMHelper.ts` (`streamChat`), `src/lib/*` renderer chat client.
- **Dependencies**: None
- **Implementation steps**:
  1. Will redefine `geminiChatArgs` Zod schema as a tuple ending in an options object that includes:
     - `skipSystemPrompt?: boolean`
     - `qualityTier?: 'fast' | 'quality' | 'verify'`
     - `requestId: string` (UUID, required)
  2. Will add a new IPC channel `gemini-chat-cancel` that takes `requestId: string`.
  3. Will maintain a module-scoped `Map<string, AbortController>` in `ipcHandlers.ts`; populated on stream start, removed in `finally`.
  4. Will pass `{ abortSignal, qualityTier }` as the fifth argument to `streamChat`.
  5. Will route per-request tokens to a per-id channel `gemini-stream-token:${requestId}` and final to `gemini-stream-final:${requestId}`.
  6. Will expose `cancelChat(requestId)` from `preload.ts` via `contextBridge`.
  7. Will update renderer client to generate UUID per call and call `cancelChat` on user cancel.
- **Acceptance criteria**:
  - [ ] Cancel arrives at provider within 250 ms (measured by test stub).
  - [ ] `qualityTier` selectable end to end.
  - [ ] Two concurrent streams do not interleave.
- **Validation**:
  - Will add `electron/tests/streamChatCancel.test.ts` and `streamChatTierSelection.test.ts`.
  - Will add `renderer/src/__tests__/cancelChat.test.tsx`.
  - Will run `npm run test:electron` and `npm run test:renderer`.
- **Rollout notes**: Backwards-compatible by accepting and rejecting old-shape requests with a clear error during a transition window.
- **Definition of done**: standard DoD.

#### NAT-037 [x] — Reorder `streamChat` prep so first-token blocking work runs in parallel with provider connect

- **Parent epic**: EPIC-06
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-2
- **Goal**: TTFT-blocking awaits will not gate the provider connection.
- **Affected files**: `electron/LLMHelper.ts` (lines 3425–3522, 3447–3459, 3465–3488, 3511–3516).
- **Dependencies**: NAT-036
- **Implementation steps**:
  1. Will refactor `streamChat` to compute `screenshotPrepP`, `knowledgePrepP`, and `promptCacheP` as promises started concurrently with `connectToProvider()`.
  2. Will await all four with `Promise.all` only at the point where their results are needed.
  3. Will short-circuit `knowledgePrepP` to a resolved promise when `skipKnowledgeInterception` is true.
  4. Will warm `withSystemPromptCache` for the active model at app startup (kicked off from `app.whenReady`).
- **Acceptance criteria**:
  - [ ] Microbench: TTFT for fast path drops by ≥150 ms p50 in test harness.
- **Validation**:
  - Will add `electron/tests/streamChatTtftMicrobench.test.ts` measuring start → first yield with stubbed provider.
  - Will run `npm run bench:baseline`.
- **Definition of done**: standard DoD.

#### NAT-038 [x] — Latest-wins coalescing for `queueCooldownDelay`

- **Parent epic**: EPIC-06
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-3
- **Goal**: Bursts of triggers will be superseded, not queued.
- **Affected files**: `electron/IntelligenceEngine.ts` (lines 516–535, 793–836).
- **Dependencies**: None
- **Implementation steps**:
  1. Will replace the chained `await queueCooldownDelay()` with a per-`cooldownKey` `pendingTrigger: { token: number, fire: () => void }`.
  2. On a new trigger, will cancel any pending trigger with the same `cooldownKey` (clear timer + reject pending promise) before scheduling the new one.
  3. Will use a shorter cooldown for finals (300 ms) and longer for interims (1500 ms).
- **Acceptance criteria**:
  - [ ] Three triggers within 200 ms produce exactly one downstream `runWhatShouldISay` call.
- **Validation**:
  - Will add `electron/tests/triggerCoalescing.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-039 [x] — Cache and dedupe coordinator results per `(transcriptRevision, normalizedQuestion)`

- **Parent epic**: EPIC-06
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-4
- **Goal**: Duplicate intent classifications inside ~1 s windows are now served from a process-local cache shared by concurrent and sequential identical callers.
- **Affected files**: `electron/llm/providers/IntentClassificationCoordinator.ts` (cache fields + `buildDedupeKey` + cached `classify` + extracted `classifyUncached`); `electron/tests/intentCoordinatorDedupe.test.ts` (new).
- **Dependencies**: None.
- **Implementation notes**:
  1. Added a private `Map<string, { promise: Promise<CoordinatedIntentResult>, expiresAt: number }>` keyed by `${transcriptRevision}|${normalizedQuestion}`. We cache the *promise* (not the resolved value) so the first caller and any concurrent duplicates share a single underlying classify pipeline.
  2. Refactored: extracted the original `classify` body into `private async classifyUncached()`, and the new public `classify()` is a thin caching wrapper. The path through `classifyUncached` is byte-identical to the old code, so retry/fallback/contradiction semantics are unchanged.
  3. TTL defaults to `DEFAULT_DEDUPE_TTL_MS = 1500`. Configurable via `dedupeTtlMs` option (set to `0` to disable, used by tests that count provider calls).
  4. **Cache bypass when isolation is unsafe**: `buildDedupeKey` returns `null` (skipping the cache) when (a) TTL is disabled, (b) the input has no `transcriptRevision` (no isolation key — would risk serving an answer from the previous turn), or (c) the normalized question is empty. The existing 16 coordinator tests, which omit `transcriptRevision`, hit this bypass path and continue to assert raw provider call counts unchanged.
  5. **Failure eviction**: a separate `.catch` deletes the cache entry on rejection so a transient failure does not poison the next caller. The error still propagates to whoever was awaiting the original promise (since `.catch` is on a derived promise). The eviction guards against TOCTOU by checking `current.promise === promise` before deleting, so an evicted entry that was already replaced isn't double-deleted.
  6. **Lazy purge**: `purgeExpiredDedupeEntries(now)` runs on every `classify()` call. Map iteration during deletion is well-defined in ES; deleted keys aren't revisited. Bounded by the number of distinct `(revision, question)` pairs in any 1.5 s window, which in practice is a handful.
  7. Added `nowFn` option for deterministic TTL testing without sleeping.
- **Acceptance criteria**:
  - [x] Two concurrent identical classify calls share one provider call (`NAT-039: identical concurrent classify calls share a single primary invocation`).
  - [x] Sequential identical calls within TTL share one provider call (`NAT-039: repeat classify within TTL returns cached promise without re-invoking primary`).
  - [x] A bumped `transcriptRevision` invalidates the cache and produces a fresh classify (`NAT-039: bumped transcriptRevision invalidates the cache entry`).
  - [x] Inputs without `transcriptRevision` bypass the cache (`NAT-039: input without transcriptRevision bypasses dedupe entirely`).
  - [x] TTL expiry triggers a fresh primary call (`NAT-039: TTL expiry triggers a fresh primary call`).
  - [x] Failed classify is evicted and a follow-up call retries cleanly (`NAT-039: classify failures are evicted so the next caller can retry`).
- **Validation**:
  - `npx tsc -p electron/tsconfig.json --noEmit` — clean.
  - All 22 coordinator tests pass: 16 existing in `intentClassificationCoordinator.test.ts` (unchanged behavior on the no-revision path) + 6 new in `intentCoordinatorDedupe.test.ts`.
- **Definition of done**: met.

#### NAT-040 [x] — Throw on Ollama streaming error instead of yielding fake token

- **Parent epic**: EPIC-06
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-9
- **Goal**: Ollama errors will surface as typed errors, not fake content.
- **Affected files**: `electron/LLMHelper.ts` (lines 4368–4371).
- **Dependencies**: None
- **Implementation steps**:
  1. Will replace `yield "Error: Failed to stream from Ollama.";` with `throw sanitizeError(error)`.
  2. Will ensure callers convert the thrown error into the appropriate IPC error event (`gemini-stream-error:${requestId}` per NAT-036).
- **Acceptance criteria**:
  - [ ] No "Error: Failed to stream from Ollama." string ever appears in `suggested_answer` content.
- **Validation**:
  - Will add `electron/tests/ollamaStreamErrorTyped.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-041 [x] — Add per-request timeout and abort propagation to Anthropic and Gemini streams

- **Parent epic**: EPIC-06
- **Priority**: P1
- **Type**: bug-fix
- **Original findings**: P-8, P-10
- **Goal**: Anthropic and Gemini streams will be deterministically cancellable and time-bounded.
- **Affected files**: `electron/LLMHelper.ts` (lines 3935–3965 Anthropic, 4183–4204 Gemini single, 4229–4272 Gemini parallel race, 4296–4303 Gemini chunks).
- **Dependencies**: NAT-036
- **Implementation steps**:
  1. Will compose a per-call signal: `combinedSignal = anySignal([userAbort, AbortSignal.timeout(LLM_API_TIMEOUT_MS)])`.
  2. Will pass `combinedSignal` into the SDK call where supported (Anthropic `messages.stream({ signal })`, Gemini `generateContentStream({ signal })`).
  3. For SDKs that do not accept a signal, will wrap iteration so that `signal.onabort` triggers `iterator.return?.()` and a hard close of the underlying response.
  4. Will plumb `abortSignal` into `streamWithGeminiParallelRace(..., abortSignal)` and pass it into both racing iterators.
- **Acceptance criteria**:
  - [ ] Hung-stream test resolves within `LLM_API_TIMEOUT_MS + 100 ms`.
  - [ ] User cancel propagates to the SDK within 250 ms.
  - [ ] Gemini race losing iterator's underlying request closes within 500 ms.
- **Validation**:
  - Will add `electron/tests/anthropicStreamTimeout.test.ts`, `geminiStreamCancel.test.ts`, `geminiRaceLoserCancel.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-042 [x] — Acquire Groq rate limiter on streaming path

- **Parent epic**: EPIC-06
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: P-11
- **Goal**: Groq streaming bursts will not bypass client-side throttling.
- **Affected files**: `electron/LLMHelper.ts` (line 3763–3775 streaming Groq).
- **Dependencies**: None
- **Implementation steps**:
  1. Will `await this.rateLimiters.groq.acquire()` before invoking `chat.completions.create`.
  2. Will release on stream end / error.
- **Acceptance criteria**:
  - [ ] Burst of 100 concurrent submits sees no more than `tokensPerSecond` actual provider calls per second.
- **Validation**:
  - Will add `electron/tests/groqStreamingRateLimiter.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-07 — Audio pipeline quality

#### NAT-043 [x] — Polyphase resample in native module before JS

- **Parent epic**: EPIC-07
- **Priority**: P1
- **Type**: feature
- **Original finding**: A-11
- **Goal**: STT will receive 16 kHz PCM produced by `rubato` polyphase, not nearest-neighbor decimation.
- **Affected files**: `native-module/Cargo.toml`, `native-module/src/lib.rs`, `native-module/src/dsp/*` (new), `electron/audio/pcm.ts`, `electron/audio/ElevenLabsStreamingSTT.ts`.
- **Dependencies**: None
- **Implementation steps**:
  1. Will use the existing `rubato` dependency (already in Cargo.toml line 17) to build a polyphase resampler in `native-module/src/dsp/resample.rs`.
  2. Will resample 48 kHz capture down to 16 kHz inside the native module before pushing PCM to JS.
  3. Will expose a NAPI option `outputSampleRate: 16000 | 24000` to choose the rate.
  4. Will remove or simplify `electron/audio/pcm.ts:resampleToMonoPcm16` and the inline decimation in `ElevenLabsStreamingSTT.ts`.
  5. Will keep a JS-side fallback resampler for the case where the native module is unavailable, but mark it as legacy with a warning.
- **Acceptance criteria**:
  - [ ] WER on a fixed test corpus improves by ≥3% relative (corpus added in NAT-085).
- **Validation**:
  - Will run `cargo test --manifest-path native-module/Cargo.toml`.
  - Will run NAT-085 WER harness and compare.
- **Definition of done**: standard DoD plus benchmark numbers in changelog.

#### NAT-044 [x] — Stop lowercasing in `transcriptCleaner.cleanText`; preserve original casing

- **Parent epic**: EPIC-07
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: A-12
- **Goal**: Proper nouns and emphasis will not be lost before LLM/intent features.
- **Affected files**: `electron/llm/transcriptCleaner.ts` (lines 30–52).
- **Dependencies**: None
- **Implementation (actual)**:
  - Picked the smaller, lower-risk path: keep the `cleanText(text) -> string` signature but split *matching* from *rendering*. Filler / acknowledgement membership is checked on a per-token lowercased copy; the kept word is emitted with its original casing untouched.
  - Rejected the `{ original, normalized }` refactor in step 1 of the original plan because no caller actually needed the normalized surface — they all feed straight into the LLM prompt. Returning a richer object would have forced every consumer to change for no observable benefit.
  - The repeated-word collapse regex (`\b(\w+)(\s+\1)+\b`) is already case-insensitive (`/gi`) and preserves the first occurrence's casing, so it required no change.
  - `prepareTranscriptForReasoning` was already casing-preserving and is unchanged.
- **Acceptance criteria**:
  - [x] Prompts to LLM contain original-case text (verified by `NAT-044: prepareTranscriptForWhatToAnswer preserves original casing`).
  - [x] Matching code still works with normalized text (verified by `NAT-044: cleanText still strips fillers/acknowledgements case-insensitively`).
- **Validation (done)**:
  - Updated `electron/tests/transcriptCleanerReasoning.test.ts` with two new NAT-044 cases. The pre-existing assertion that `prepareTranscriptForWhatToAnswer` *must* lowercase technical identifiers (which encoded the bug as a feature) was removed.
  - Re-ran `npx tsc -p electron/tsconfig.json --noEmit` → clean.
  - Re-ran the targeted test file → 3/3 pass.

---

### EPIC-08 — Conscious mode hygiene

#### NAT-045 [x] — Use real `TokenBudgetManager` in `ConsciousPreparationCoordinator`

- **Parent epic**: EPIC-08
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: A-15
- **Goal**: Conscious preparation will use accurate token counts instead of whitespace heuristics.
- **Affected files**: `electron/conscious/ConsciousPreparationCoordinator.ts` (lines 92–103), `electron/conscious/TokenBudget.ts` (lines 31–82), `electron/shared/TokenCounter.ts`.
- **Dependencies**: None
- **Implementation steps**:
  1. Will inject a `TokenCounter` into `ConsciousPreparationCoordinator`.
  2. Will replace `split(/\s+/).length` with `tokenCounter.count(text, modelFamily)`.
  3. Will use `TokenBudgetManager` buckets to enforce per-section budgets; on overflow, will trim the lowest-priority bucket first.
- **Acceptance criteria**:
  - [ ] Token count for fixture text matches provider tokenizer within ±5%.
  - [ ] Total prompt size never exceeds the per-model limit in tests.
- **Validation**:
  - Will add `electron/tests/consciousPrepTokenBudget.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-046 [x] — Adaptive context: force-include last N turns then fill by score

- **Parent epic**: EPIC-08
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: A-14
- **Goal**: The latest critical turns will not be evicted by score-only selection.
- **Affected files**: `electron/conscious/AdaptiveContextWindow.ts` (lines 45–84).
- **Dependencies**: None
- **Implementation steps**:
  1. Will add a constant `MIN_RECENT_TURNS = 4`.
  2. Will modify the selection loop to first include the last `MIN_RECENT_TURNS` turns (regardless of score), then fill remaining budget by descending score.
  3. Will deduplicate (a turn already force-included will not be considered for scored fill).
- **Acceptance criteria**:
  - [ ] Test with a high-score old turn and a low-score recent turn includes the recent turn.
- **Validation**:
  - Will add `electron/tests/adaptiveContextRecencyFloor.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-047 [x] — Restore newlines in `clampResponse` for prose answers

- **Parent epic**: EPIC-08
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: A-13
- **Goal**: Multi-line prose will preserve structure; only collapse when text is non-list-like.
- **Affected files**: `electron/llm/postProcessor.ts` (`stripMarkdown`).
- **Dependencies**: None
- **Implementation (actual)**:
  - Replaced the two-line collapse-everything block (`/\n+/g, " "` then `/\s+/g, " "`) with a paragraph-aware pipeline:
    1. Normalize CRLF → LF.
    2. Strip trailing whitespace before each newline so wrap-time `"foo  \n"` doesn't pretend to be a structural break.
    3. Replace runs of 2+ newlines with a sentinel.
    4. Replace remaining single newlines with a space (line wrap → space).
    5. Restore the sentinel as exactly `\n\n` (one blank line).
    6. Collapse only `[ \t]+` (never `\s+`) so paragraph breaks survive the in-line whitespace pass.
  - Did **not** add list-aware logic (step 1 of the original plan). By the time newline collapsing runs, bullet markers (`-`, `*`, `1.`) have already been stripped, so list-aware detection would be a redundant guess. The actual user-visible defect was paragraph break loss, and that's what the fix restores.
  - Discovered and fixed a pre-existing latent bug while writing the code-fence regression test: the placeholder `__CODE_BLOCK_${i}__` was being mangled by the italic-stripping regex (`_text_`), permanently dropping code fences from output. Switched the placeholder to a markdown-inert control-character sentinel pair (`\u0002CODEBLOCK${i}\u0003`).
- **Acceptance criteria**:
  - [x] Prose answer with paragraph breaks retains paragraph breaks (verified end-to-end via `clampResponse`).
- **Validation (done)**:
  - Added `electron/tests/postProcessorNewlines.test.ts` with 6 cases: paragraph preservation, line-wrap collapse, trailing-whitespace handling, 3+ blank-line collapse, code-fence verbatim preservation, in-line whitespace collapse.
  - Re-ran `npx tsc -p electron/tsconfig.json --noEmit` → clean.
  - Re-ran the affected test files → 15/15 pass (6 new NAT-047 + 4 existing `llm-validation` + 5 existing `llm-integration`, including the `LLM Integration Tests` suite for `generateSuggestion`, which exercises the same code path).

#### NAT-048 [x] — Wire `ResponseFingerprinter` into `ConsciousResponseCoordinator`

- **Parent epic**: EPIC-08
- **Priority**: P2
- **Type**: feature
- **Original finding**: open question from sub-agent B
- **Goal**: Duplicate response detection is now enforced at emit time. Identical and near-identical consecutive answers within a session are suppressed before any tokens, final emit, session append, or usage push happens.
- **Affected files**: `electron/conscious/ConsciousResponseCoordinator.ts` (optional fingerprinter ctor param + suppression branch + post-emit `record()`); `electron/IntelligenceEngine.ts` (session-scoped `consciousResponseFingerprinter` field, threaded through `getConsciousResponseCoordinator`, cleared on `setSession`); `electron/tests/responseFingerprintDedup.test.ts` (new). `ResponseFingerprinter` itself is unchanged — already exported by `electron/conscious/index.ts`.
- **Dependencies**: NAT-008 (fingerprinter exists).
- **Implementation notes**:
  1. **Optional injection** keeps backward compatibility: existing 4-arg constructor calls (the unit test in `consciousResponseCoordinator.test.ts`) work unchanged. When the engine constructs a coordinator, it now passes the long-lived session-scoped fingerprinter.
  2. **Check before emit, record after emit**: the duplicate check fires *before* `setMode('reasoning_first')` so a suppressed duplicate never leaks a partial UI/mode state. The fingerprint is recorded *after* the emit so a downstream exception during emission doesn't permanently mark the answer as "seen" and suppress legitimate retries.
  3. **Hard suppression** (vs. soft downgrade): on duplicate we skip token stream, final emit, session append, usage push, and tracker completion; we mark a `response.duplicate_suppressed` latency tag for observability and drop straight back to `idle`. Rationale rejected the "downgrade to clarification" path because emitting a templated "I already covered that" requires a new LLM call or canned-string library, both of which are out of scope and add a worse failure mode (spurious clarifications when the duplicate detection false-positives).
  4. **Session-scoped lifetime**: a single `ResponseFingerprinter` instance lives on `IntelligenceEngine` and is `clear()`-ed on `setSession()`. Two reasons it's not reallocated: (a) the same instance is referenced by every coordinator the engine builds during the session — reallocating would only correctly wipe state if every coordinator was also reallocated; (b) `clear()` is the correct primitive — the fingerprinter is a pure cache and zero-arg recreation has no value over `clear()`.
  5. **Latency tracker stays in-flight on suppression**: we deliberately do *not* call `latencyTracker.complete()` for a suppressed duplicate. This makes the suppression visible in the latency snapshot (the request shows up as in-flight + tagged) rather than misleadingly recording a phantom completion at zero duration.
- **Acceptance criteria**:
  - [x] Two identical consecutive answers result in a single emission (`NAT-048: identical consecutive answers result in a single emission`).
  - [x] Near-duplicates sharing a long enough first sentence are also suppressed (`NAT-048: near-duplicate (same first sentence) is also suppressed`).
  - [x] Distinct answers are both emitted (no false positives) (`NAT-048: distinct answers are both emitted`).
  - [x] Backward compatible: no fingerprinter ⇒ legacy behavior, no suppression (`NAT-048: with no fingerprinter injected, behavior matches the legacy contract`).
  - [x] Session-switch via `clear()` re-allows previously-seen answers (`NAT-048: clearing the fingerprinter (e.g. on session switch) re-allows previously-seen answers`).
- **Validation**:
  - `npx tsc -p electron/tsconfig.json` — clean.
  - 5 new NAT-048 tests + the existing `consciousResponseCoordinator` test all pass; full electron suite green (854 / 850 pass / 4 skipped, 0 fail).
- **Definition of done**: met.

#### NAT-049 — Cap or background speculative finalize wait [x]

- **Parent epic**: EPIC-08
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-13
- **Goal**: Tail latency on speculative finalize will not block the hot path for 2 s.
- **Affected files**: `electron/IntelligenceEngine.ts`, `electron/tests/speculativeFinalizeCap.test.ts`.
- **Dependencies**: NAT-001
- **Implementation**:
  1. Reduced the synchronous finalize cap at the IntelligenceEngine call site
     from `2_000` ms to a named `SPECULATIVE_FINALIZE_WAIT_MS = 600` ms when the
     preview is not yet complete; `speculativePreview.complete === true` already
     short-circuits to `waitMs = 0` (no wait), preserving the pre-existing
     fast-path for completed previews.
  2. Added three telemetry marks so production can answer "was the cap too
     tight?" without code changes:
       * `speculative.finalize_skipped_complete` — preview was already complete,
         no wait incurred.
       * `speculative.finalize_timed_out` — finalize hit the 600 ms cap and
         aborted the speculative generator.
       * `speculative.finalize_resolved` — generator completed within the cap
         and the speculative answer was promoted.
  3. Background finalization (step 2 of the original plan) was deliberately
     deferred. The orchestrator's contract — "finalize aborts the generator on
     timeout" — means a true background promotion would require a separate
     non-aborting "observe" path on `ConsciousAccelerationOrchestrator`, plus a
     decision about whether late-arriving text can replace already-rendered
     text. That is a behavior change worth its own ticket; this fix takes the
     latency win without changing the speculate→commit contract.
- **Acceptance criteria**:
  - [x] Synchronous finalize wait is ≤ 600 ms when the preview is incomplete
    (verified by `speculativeFinalizeCap.test.ts` — observed elapsed ~605 ms,
    well under the previous 2 s cap).
  - [x] Completed previews still skip the wait entirely (verified by the
    second test in the same file — observed elapsed ~34 ms).
- **Validation**:
  - Added `electron/tests/speculativeFinalizeCap.test.ts` with two cases:
    a never-completing executor exercising the cap, and a completed executor
    asserting the zero-wait path returns the partial text.
  - `npx tsc -p electron/tsconfig.json --noEmit` clean.
  - `node --test dist-electron/electron/tests/speculativeFinalizeCap.test.js`
    → 2/2 pass; surrounding `aneClassifierLane`,
    `intentPrefetchConfidenceGate`, and `accelerationInterviewerAudio` suites
    still pass (14/14) so the cap reduction did not regress speculative
    invalidation, suppression, or pause-routing.
  - `bench:baseline` deferred to the Wave-2 verification pass at the end.
- **Definition of done**: standard DoD.

#### NAT-050 — Pass `evidence` array into verifier and downgrade on inferred-only state [x]

- **Parent epic**: EPIC-08
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: from sub-agent B (AnswerHypothesisStore + ConsciousVerifier)
- **Goal**: Inferred-only state will trigger more conservative verification.
- **Affected files**: `electron/conscious/ConsciousVerifier.ts`, `electron/conscious/ConsciousOrchestrator.ts`, `electron/tests/consciousVerifier.test.ts`.
- **Dependencies**: NAT-004
- **Implementation**:
  1. Extended `ConsciousVerifierJudgeInput` with `evidence?: Array<'suggested' | 'inferred'>` so verification can evaluate evidence state directly (instead of implicitly relying on the hypothesis object shape).
  2. Threaded `latestHypothesis?.evidence` from `ConsciousOrchestrator` into both verification call paths:
     - continuation (`handleFollowUpContinuation`)
     - reasoning-first (`executeReasoningFirst`)
  3. Added inferred-dominant hardening rules in `ConsciousVerifier`:
     - detect inferred-dominant evidence (`inferred >= suggested`)
     - build strict grounding text from question + prior suggested answer + likely themes
     - reject unsupported numeric specificity (`unsupported_numeric_claim_in_inferred_state`)
     - reject unsupported technology specificity (`unsupported_technology_claim_in_inferred_state`)
  4. Kept the new checks scoped to inferred-dominant state only, so normal suggested-backed flows preserve existing verifier behavior.
- **Acceptance criteria**:
  - [x] Inferred-only path rejects unsupported numeric claims even when relaxed grounding is present.
- **Validation**:
  - Extended `electron/tests/consciousVerifier.test.ts` with NAT-050 coverage:
    - rejects unsupported numeric claims under inferred-only evidence
    - accepts numeric claims when those values are grounded in prior evidence
  - `npx tsc -p electron/tsconfig.json --noEmit` — clean.
  - `npm run test:electron` — green (856 tests, 852 pass, 4 skipped, 0 fail).
- **Definition of done**: met.

---

### EPIC-09 — Foundation Models persistent helper

#### NAT-051 [x] — Convert Foundation helper to long-lived line-protocol process

- **Parent epic**: EPIC-09
- **Priority**: P1
- **Type**: feature
- **Original finding**: P-5
- **Goal**: Intent classification on macOS will not pay process-spawn cost per call.
- **Affected files**:
  - `applesilicon/macos-foundation-intent-helper/Sources/main.swift`
  - `electron/llm/providers/FoundationModelsIntentProvider.ts` (lines 239–297)
  - `electron/llm/providers/FoundationModelsIntentHelperPath.ts`
  - `scripts/run-foundation-intent-latency-spike.js`
- **Dependencies**: NAT-036
- **Implementation steps**:
  1. Will modify the Swift helper to read newline-delimited JSON requests from stdin, write newline-delimited JSON responses to stdout.
  2. Will keep the existing per-request schema contract.
  3. Will spawn one helper per `FoundationModelsIntentProvider` instance; multiplex requests with a `requestId` field.
  4. Will track in-flight requests in a `Map<string, { resolve, reject, timeoutHandle }>`.
  5. Will respawn helper on exit with exponential backoff (max 5 attempts in 60 s) and route in-flight to fallback.
  6. Will keep cancel support: send `{ type: 'cancel', requestId }` to stdin, helper acknowledges.
- **Acceptance criteria**:
  - [ ] Latency benchmark `npm run bench:intent:foundation` shows ≥40% p99 reduction.
  - [ ] Helper crash recovers within 1 s with no lost classifications (re-routed to fallback).
- **Validation**:
  - Will run `npm run bench:intent:foundation`.
  - Will add `electron/tests/foundationHelperPersistent.test.ts`.
  - Will run `npm run test:electron`.
- **Rollout notes**: Behind a flag `NATIVELY_FOUNDATION_PERSISTENT=1` for first release; flip to default after one week of stable operation.
- **Definition of done**: standard DoD plus benchmark numbers in changelog.

#### NAT-052 [x] — Tighten Foundation helper exit-failure mapping

- **Parent epic**: EPIC-09
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: from sub-agent D (mapExitFailure substring "rate")
- **Goal**: Helper error classification will use structured codes, not stderr substring matches.
- **Affected files**: `electron/llm/providers/FoundationModelsIntentProvider.ts` (lines 127–129), Swift helper.
- **Dependencies**: NAT-051
- **Implementation steps**:
  1. Will define a structured error JSON shape `{ kind: 'rate_limited' | 'model_not_ready' | 'invalid_response' | 'refusal' | 'unknown' }` in the helper.
  2. Will write that JSON to stderr on error; remove substring matching in TS.
- **Acceptance criteria**:
  - [ ] No false positives from stderr substring matching.
- **Validation**:
  - Will extend `foundationHelperPersistent.test.ts`.
  - Will run `cargo test` and `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-10 — LiveRAG indexer to worker

#### NAT-053 — Move `LiveRAGIndexer.tick` to a worker with embedding batching

- **Parent epic**: EPIC-10
- **Priority**: P1
- **Type**: feature
- **Original finding**: P-7
- **Goal**: Live indexing will not block the orchestration thread.
- **Affected files**: `electron/rag/LiveRAGIndexer.ts` (lines 113–191), `electron/rag/VectorStore.ts` (lines 145–169), `electron/rag/EmbeddingPipeline.ts`, new `electron/rag/liveRagIndexerWorker.ts`.
- **Dependencies**: NAT-015 (worker hygiene)
- **Implementation steps**:
  1. Will create `electron/rag/liveRagIndexerWorker.ts` as a `worker_threads` entry handling chunk insert + batch embed.
  2. Will move sync sqlite writes inside the worker.
  3. Will use `embeddingProvider.embedBatch(chunks)` where the provider supports it.
  4. Will throttle: max N chunks per tick.
  5. Will keep tick frequency, but tick now sends a message to the worker and returns.
- **Acceptance criteria**:
  - [ ] Main-thread tick time drops below 5 ms p95 in soak.
- **Validation**:
  - Will add `electron/tests/liveRagWorkerTickTime.test.ts`.
  - Will run `npm run test:soak`.
- **Definition of done**: standard DoD.

#### NAT-054 — Parallelize embedding with BM25 and phase in `ParallelContextAssembler`

- **Parent epic**: EPIC-10
- **Priority**: P1
- **Type**: bug-fix
- **Original finding**: P-6
- **Goal**: Embedding will run in parallel with BM25 and phase computations.
- **Affected files**: `electron/cache/ParallelContextAssembler.ts` (lines 168–183).
- **Dependencies**: NAT-015
- **Implementation steps**:
  1. Will start `embeddingP = embeddingProvider.embed(...)` immediately.
  2. Will run `Promise.all([embeddingP, bm25P, phaseP])`.
  3. Will preserve dimension constraints needed by confidence scoring.
- **Acceptance criteria**:
  - [ ] p95 assembly time drops by ≥30% in microbench.
- **Validation**:
  - Will add `electron/tests/parallelContextAssemblerParallelization.test.ts`.
  - Will run `npm run bench:baseline`.
- **Definition of done**: standard DoD.

---

### EPIC-11 — Unified conscious thread model

#### NAT-055 — Introduce `ThreadDirector` and consolidate thread state

- **Parent epic**: EPIC-11
- **Priority**: P2
- **Type**: refactor
- **Original finding**: H-1
- **Goal**: One service will own create/resume/suspend/reset for conversation threads; design and reasoning views derive from one source of truth.
- **Affected files**: new `electron/conscious/ThreadDirector.ts`, modify `electron/conscious/ConsciousThreadStore.ts`, `electron/conscious/ThreadManager.ts`, `electron/conscious/ConsciousOrchestrator.ts`, `electron/ConsciousMode.ts`.
- **Dependencies**: EPIC-08 complete
- **Implementation steps**:
  1. Will define a `ConversationThread` type with three views: `design`, `reasoning`, `telemetry`.
  2. Will create `ThreadDirector` exposing `openThread`, `resumeThread`, `suspendThread`, `resetThread(reason)`, and a `subscribe('thread:reset')` event.
  3. Will migrate `handleObservedInterviewerTranscript` and `recordConsciousResponse` to mutate via `ThreadDirector`.
  4. Will move topic-shift detection into `ThreadDirector`; both `QuestionReactionClassifier` and `ConsciousMode` consume the same event.
  5. Will add a structural invariant test: design view's active thread ID equals reasoning view's active thread ID at all times.
- **Acceptance criteria**:
  - [ ] Single source of truth; no direct mutation of either store outside the director.
  - [ ] Invariant test passes across the conscious eval harness.
- **Validation**:
  - Will add `electron/tests/threadDirectorInvariant.test.ts`.
  - Will run `npm run test:electron` and `npm run eval:conscious`.
- **Rollout notes**: Behind a flag `NATIVELY_THREAD_DIRECTOR=1` for one release; remove flag after stability confirmed.
- **Definition of done**: standard DoD.

---

### EPIC-12 — Unified Intent Confidence Service

#### NAT-056 — Implement `IntentConfidenceService` with one calibration map

- **Parent epic**: EPIC-12
- **Priority**: P2
- **Type**: feature
- **Original finding**: H-2
- **Goal**: Every intent consumer will read confidence from one calibrated source.
- **Affected files**: new `electron/llm/IntentConfidenceService.ts`, modify `electron/llm/IntentClassifier.ts`, `electron/llm/providers/IntentClassificationCoordinator.ts`, `electron/conscious/ConsciousIntentService.ts`, `electron/conscious/ConsciousAccelerationOrchestrator.ts`.
- **Dependencies**: EPIC-09 complete
- **Implementation steps**:
  1. Will define a calibration map `{ intent: { minConfidence: number, isStrong: number } }` versioned alongside `FoundationIntentPromptAssets.ts`.
  2. Will replace `SLM_CONFIDENCE_THRESHOLD = 0.55` and `DEFAULT_MINIMUM_PRIMARY_CONFIDENCE = 0.82` with reads from the service.
  3. Will route all `isUncertainConsciousIntent` and `isStrongConsciousIntent` calls through the service.
  4. Will add a single staleness model: `{ revision: number, age: ms }` carried on every `IntentResult`.
  5. Will expose a single `cancel(turnId)` surface.
- **Acceptance criteria**:
  - [ ] Two threshold constants are removed; only one map remains.
  - [ ] `npm run eval:intent:multi` baseline equal or better.
- **Validation**:
  - Will add `electron/tests/intentConfidenceServiceCalibration.test.ts`.
  - Will run `npm run eval:intent` and `npm run eval:intent:multi`.
- **Definition of done**: standard DoD.

---

### EPIC-13 — Unified Route Director

#### NAT-057 — Implement `RouteDirector` with EDF scheduling and parallel candidates

- **Parent epic**: EPIC-13
- **Priority**: P2
- **Type**: feature
- **Original finding**: H-3
- **Goal**: One entry point for every answer turn, supporting first-valid-wins and hard cancel.
- **Affected files**: new `electron/runtime/RouteDirector.ts`, modify `electron/latency/answerRouteSelector.ts`, `electron/inference/InferenceRouter.ts`, `electron/IntelligenceEngine.ts`, `electron/inference/{FastDraftLane, QualityLane, VerificationLane}.ts`, `electron/runtime/RuntimeBudgetScheduler.ts`.
- **Dependencies**: EPIC-06, EPIC-12 complete
- **Implementation steps**:
  1. Will define `RouteDirector.runTurn({ turnId, transcriptRevision, deadlineMs, abortSignal })`.
  2. Will introduce a `Turn` type that carries `commitToken`, revision, deadline, and abort.
  3. Will allow optional parallel `draft` + `quality` lanes for high-stakes turns; first valid result wins, loser receives hard cancel via signal.
  4. Will plumb `budgetDeadlineMs` into `RuntimeBudgetScheduler` so EDF tie-breaks honor the deadline.
  5. Will replace direct lane invocations in `IntelligenceEngine` with `routeDirector.runTurn(...)`.
  6. Will enforce the invariant: no token leaves a turn whose `transcriptRevision` differs from the session's current.
- **Acceptance criteria**:
  - [ ] All answer paths in `IntelligenceEngine` go through `RouteDirector`.
  - [ ] Loser's underlying request closes within 500 ms of cancel.
  - [ ] Deadline-driven scheduling reduces tail latency in microbench.
- **Validation**:
  - Will add `electron/tests/routeDirectorParallelCandidates.test.ts`.
  - Will run `npm run test:electron` and `npm run bench:baseline`.
- **Rollout notes**: Behind a flag `NATIVELY_ROUTE_DIRECTOR=1` for one release.
- **Definition of done**: standard DoD.

---

### EPIC-14 — Unified cache layer

#### NAT-058 — Define a single `Cache` interface with byte+count eviction and revision-prefix semantic fallback

- **Parent epic**: EPIC-14
- **Priority**: P2
- **Type**: refactor
- **Original finding**: H-4
- **Goal**: All caches in the codebase will share one interface and one eviction policy.
- **Affected files**: new `electron/cache/Cache.ts` (interface), refactors in `electron/cache/EnhancedCache.ts`, `electron/cache/CacheFactory.ts`, `electron/conscious/ConsciousCache.ts`, all consumers.
- **Dependencies**: EPIC-04 complete
- **Implementation steps**:
  1. Will define `interface Cache<K, V>` with `get`, `set`, `delete`, `clear`, `evictByPrefix`, `getStats`, optional `findSimilar(query, embedding, bindKeyPrefix)`.
  2. Will refactor `EnhancedCache` and `ConsciousCache` to implement the interface.
  3. Will enforce `maxMemoryMB` in `ConsciousCache` eviction by computing per-entry byte size on `set` (use existing estimate code from `getStats`).
  4. Will require all `findSimilar` callers to pass `(revision, sessionId)` binding.
- **Acceptance criteria**:
  - [ ] All caches expose the same interface.
  - [ ] `maxMemoryMB` enforced (verified in test with large entries).
- **Validation**:
  - Will add `electron/tests/cacheInterfaceConformance.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-15 — Event-sourced session memory

#### NAT-059 — Wire `EventCheckpointPolicy` into session persistence

- **Parent epic**: EPIC-15
- **Priority**: P3
- **Type**: feature
- **Original finding**: from sub-agent E + H-5
- **Goal**: Transcript and memory state persist as an append-only event log with periodic snapshots.
- **Affected files**: `electron/memory/EventCheckpointPolicy.ts` (lines 48–57), `electron/memory/SessionPersistence.ts` (lines 129–203), `electron/SessionTracker.ts`, `electron/MeetingPersistence.ts`, `electron/MeetingCheckpointer.ts`.
- **Dependencies**: EPIC-03 complete
- **Implementation steps**:
  1. Will extend `SessionPersistence` to write a per-session `events.log` (append-only newline-delimited JSON) keyed by event type and timestamp.
  2. Will hook `EventCheckpointPolicy` into transcript ingestion to gate writes (cooldown semantics).
  3. Will run periodic snapshot every N events (configurable; default 1000).
  4. Will provide `replayUntil(eventId)` for crash recovery; verify via fault-injection test.
  5. Will deprecate the monolithic session JSON write but keep it as a backup for one release.
- **Acceptance criteria**:
  - [ ] Session file size grows linearly with events, not quadratically with memory state.
  - [ ] Crash mid-write recovers cleanly via replay.
- **Validation**:
  - Will add `electron/tests/eventSourcedSessionRecovery.test.ts`.
  - Will run `npm run test:fault-injection`.
- **Definition of done**: standard DoD.

#### NAT-060 — Atomic write of session+index manifest

- **Parent epic**: EPIC-15
- **Priority**: P2
- **Type**: bug-fix
- **Original finding**: R-8
- **Goal**: A crash between session-file write and index-file write will not orphan or stale-point a session.
- **Affected files**: `electron/memory/SessionPersistence.ts` (lines 129–203, 265–292).
- **Dependencies**: NAT-059
- **Implementation steps**:
  1. Will combine session and index writes into a single manifest transaction file written atomically; on crash, the older manifest remains valid.
  2. Will add `loadIndex` recovery: scan files for orphans and rebuild on mismatch.
- **Acceptance criteria**:
  - [ ] Inducing a crash between writes yields a consistent state on next load.
- **Validation**:
  - Will add `electron/tests/sessionPersistenceAtomicManifest.test.ts`.
  - Will run `npm run test:fault-injection`.
- **Definition of done**: standard DoD.

#### NAT-061 — Throttle `MeetingCheckpointer` broadcast and align with idle detection

- **Parent epic**: EPIC-15
- **Priority**: P3
- **Type**: bug-fix
- **Original finding**: P-12
- **Goal**: Periodic checkpoint will not fan out to every window unnecessarily.
- **Affected files**: `electron/MeetingCheckpointer.ts` (lines 5–99).
- **Dependencies**: None
- **Implementation steps**:
  1. Will replace `BrowserWindow.getAllWindows()` broadcast with a single channel publish to a known IPC topic.
  2. Will skip the checkpoint when the orchestrator reports idle (no active turn).
- **Acceptance criteria**:
  - [ ] No `meeting-checkpointed` IPC event sent during idle stretches.
- **Validation**:
  - Will add `electron/tests/meetingCheckpointerIdle.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-16 — STT diarization or multichannel

#### NAT-062 — Single multichannel session for diarization-capable providers

- **Parent epic**: EPIC-16
- **Priority**: P3
- **Type**: feature
- **Original finding**: H-6
- **Goal**: Cross-talk between mic and system audio will be reduced via diarization or echo cancellation.
- **Affected files**: `electron/audio/DeepgramStreamingSTT.ts`, `electron/audio/SonioxStreamingSTT.ts`, `electron/main.ts` (STT setup ~1639–1752), optionally `native-module/src/dsp/echo.rs` (new).
- **Dependencies**: EPIC-07 complete
- **Implementation steps**:
  1. Will add a multichannel-session option for Deepgram and Soniox (provider-specific implementation).
  2. Will route both audio streams into the single session with channel labels.
  3. Will fall back to dual sessions on providers without diarization.
  4. Optionally will add an echo-cancellation DSP node in `native-module` (gated by feature flag) for non-diarized providers.
- **Acceptance criteria**:
  - [ ] Diarization fixture (NAT-085) passes for Deepgram and Soniox.
- **Validation**:
  - Will add `electron/tests/sttDiarizationMultichannel.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-17 — Unified HelperHost

#### NAT-063 — Implement `HelperHost` and port Foundation + virtual display helpers

- **Parent epic**: EPIC-17
- **Priority**: P3
- **Type**: refactor
- **Original finding**: H-7
- **Goal**: A single supervised helper-host pattern manages spawn, attestation, env sanitization, watchdog, and restart.
- **Affected files**: new `electron/runtime/HelperHost.ts`, modify `electron/llm/providers/FoundationModelsIntentProvider.ts`, `electron/stealth/MacosVirtualDisplayClient.ts`, `electron/runtime/RuntimeCoordinator.ts`.
- **Dependencies**: EPIC-09 complete
- **Implementation steps**:
  1. Will define `HelperHost` exposing `spawn(spec)`, `send(req)`, `cancel(reqId)`, `dispose()`.
  2. Will port Foundation helper to use it.
  3. Will port virtual display helper to use it.
  4. Will register the host as a supervisor under `RuntimeCoordinator`.
- **Acceptance criteria**:
  - [ ] Both helpers run via `HelperHost`; no remaining direct `spawn` calls in those files.
- **Validation**:
  - Will add `electron/tests/helperHost.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-18 — Unified `ProviderClient` interface

#### NAT-064 — Define `ProviderClient` and migrate Anthropic, OpenAI, Gemini, Groq, Cerebras, Ollama

- **Parent epic**: EPIC-18
- **Priority**: P3
- **Type**: refactor
- **Original finding**: H-8
- **Goal**: One provider contract; one retry/timeout wrapper; never yield strings as errors.
- **Affected files**: new `electron/llm/providers/ProviderClient.ts`, refactor `electron/LLMHelper.ts` provider sections.
- **Dependencies**: EPIC-06, EPIC-13 complete
- **Implementation steps**:
  1. Will define `interface ProviderClient { stream(request, signal): AsyncIterable<Token>; }`.
  2. Will introduce `withRetryAndTimeout(client, policy)` wrapper that owns all retry/timeout/backoff.
  3. Will migrate each provider entry point in `LLMHelper.ts` to a `ProviderClient` implementation in `electron/llm/providers/<name>Client.ts`.
  4. Will leave `LLMHelper.ts` as a thin selector + cache layer (preparing the way for EPIC-19 splits).
- **Acceptance criteria**:
  - [ ] Every provider implements `ProviderClient`.
  - [ ] Retry/timeout policy lives in one wrapper; no per-provider duplication.
  - [ ] No `yield` of error strings exists anywhere in `electron/LLMHelper.ts`.
- **Validation**:
  - Will add per-provider `*ClientContract.test.ts`.
  - Will run `npm run test:electron`.
- **Definition of done**: standard DoD.

---

### EPIC-19 — Mega-file decomposition

#### NAT-065 — Split `electron/LLMHelper.ts` into provider modules

- **Parent epic**: EPIC-19
- **Priority**: P3
- **Type**: refactor
- **Original finding**: I-4
- **Goal**: No file in `electron/llm/` exceeds 600 LOC.
- **Affected files**: `electron/LLMHelper.ts`, new files under `electron/llm/providers/` and `electron/llm/orchestration/`.
- **Dependencies**: EPIC-18 complete
- **Implementation steps**:
  1. Will move each provider's stream/non-stream/race logic into its own client file.
  2. Will move screenshot/knowledge prep into `electron/llm/orchestration/streamPrep.ts`.
  3. Will move prompt-cache logic into `electron/llm/orchestration/promptCache.ts`.
  4. Will keep `LLMHelper.ts` as a thin façade re-exporting public API.
- **Acceptance criteria**:
  - [ ] All split files <600 LOC.
  - [ ] Public API of `LLMHelper` unchanged (verified by export-shape test).
- **Validation**: `npm run test:electron`.
- **Definition of done**: standard DoD.

#### NAT-066 — Split `electron/main.ts` into bootstrap + lifecycle modules

- **Parent epic**: EPIC-19
- **Priority**: P3
- **Type**: refactor
- **Original finding**: I-4
- **Goal**: `main.ts` becomes a thin entry point delegating to bootstrap and lifecycle services.
- **Affected files**: `electron/main.ts`, new `electron/main/{bootstrap, lifecycle, logging}.ts`.
- **Dependencies**: Wave 1–3 complete
- **Implementation steps**: Will split per concerns: window setup, supervisor registration, logging setup, IPC registration, shutdown.
- **Acceptance criteria**: New entry point <400 LOC; behavior unchanged.
- **Validation**: `npm run test:electron`, full app smoke test.
- **Definition of done**: standard DoD.

#### NAT-067 — Split `electron/SessionTracker.ts`, `electron/stealth/StealthManager.ts`, `electron/ipcHandlers.ts`, `electron/services/ModelVersionManager.ts`, `electron/preload.ts`

- **Parent epic**: EPIC-19
- **Priority**: P3
- **Type**: refactor
- **Original finding**: I-4
- **Goal**: Each split file ≤600 LOC; cohesive modules.
- **Affected files**: as named.
- **Dependencies**: Wave 1–3 complete
- **Implementation steps**: One sub-task per file; preserve public exports via barrel; no behavior change.
- **Acceptance criteria**: All targeted files split; public API unchanged.
- **Validation**: `npm run test:electron` and renderer tests.
- **Definition of done**: standard DoD.

---

### EPIC-20 — Test, fixtures, observability infrastructure (cross-cutting)

#### NAT-082 — Stealth capture-fixture suite (sub-epic 20a)

- **Parent epic**: EPIC-20
- **Priority**: P0
- **Type**: test
- **Original finding**: J-9
- **Goal**: A repeatable fixture will exercise SCK / Chromium screen capture against every protected window and assert no leak.
- **Affected files**: new `electron/tests/stealthCaptureFixture.test.ts`, `scripts/run-stealth-capture-fixture.js`, possibly small helper binary in `applesilicon/macos-stealth-capture-fixture/`.
- **Dependencies**: macOS dev hardware + screen-recording entitlement.
- **Implementation steps**:
  1. Will use ScreenCaptureKit via a small helper to grab N frames from each of: shell window, content window, privacy shield, launcher, overlay.
  2. Will assert each frame is "captured-blank" (no UI pixels).
  3. Will also assert `[NSWindow level]` matches expected values.
- **Acceptance criteria**:
  - [ ] Suite passes on the current build.
  - [ ] Suite fails when `setContentProtection` is removed (smoke check).
- **Validation**: run the new script.
- **Definition of done**: standard DoD plus runbook in `DEPLOYMENT.md`.

#### NAT-083 — Conscious end-to-end harness extension

- **Parent epic**: EPIC-20
- **Priority**: P1
- **Type**: test
- **Original finding**: from sub-agent B (eval gap)
- **Goal**: Eval harness will exercise `prepareRoute → preparation → generation → verifier → emit` with mocked LLM.
- **Affected files**: `electron/conscious/ConsciousEvalHarness.ts`, fixtures under `electron/evals/`.
- **Dependencies**: NAT-001..NAT-008 (so the path is correct first)
- **Implementation steps**:
  1. Will add scenarios for `prepareRoute`, acceleration overlay, circuit breaker, topical compatibility.
  2. Will mock `LLMHelper.streamChat` to deterministic outputs.
  3. Will run alongside existing harness in `npm run eval:conscious`.
- **Acceptance criteria**: Coverage report shows the new scenarios exercised.
- **Validation**: `npm run eval:conscious`.
- **Definition of done**: standard DoD.

#### NAT-084 — Fault-injection runner extensions

- **Parent epic**: EPIC-20
- **Priority**: P1
- **Type**: test
- **Original finding**: J-9
- **Goal**: Fault-injection harness will exercise: speculative invalidation between preview and finalize; STT frame drops; helper crash mid-stream.
- **Affected files**: `electron/tests/faultInjection.test.ts`, new fixtures.
- **Dependencies**: NAT-001
- **Implementation steps**:
  1. Will add tests under `npm run test:fault-injection` for the three scenarios above.
  2. Will assert: no `suggested_answer` from invalidated speculation; STT drops surface as metrics; helper crash recovers.
- **Acceptance criteria**: All three scenarios pass.
- **Validation**: `npm run test:fault-injection`.
- **Definition of done**: standard DoD.

#### NAT-085 — WER and diarization corpus + harness

- **Parent epic**: EPIC-20
- **Priority**: P2
- **Type**: test
- **Original finding**: A-11, H-6
- **Goal**: A reproducible WER and diarization benchmark for STT changes.
- **Affected files**: new `scripts/run-stt-wer-bench.js`, fixtures under `electron/tests/fixtures/audio/`.
- **Dependencies**: None
- **Implementation steps**:
  1. Will assemble a small audio corpus (≤10 clips) with known transcripts.
  2. Will run each STT provider against the corpus and compute WER.
  3. Will also compute diarization accuracy when applicable.
- **Acceptance criteria**: Baseline numbers captured in `RELEASE_NOTES.md`.
- **Validation**: run the script.
- **Definition of done**: standard DoD.

#### NAT-086 [x] — Observability metrics emitters

- **Parent epic**: EPIC-20
- **Priority**: P1
- **Type**: infra
- **Original finding**: J-10
- **Goal**: New counters and gauges will be emitted from the runtime for the metrics named in the audit.
- **Affected files**: new `electron/runtime/Metrics.ts`, additions across the runtime.
- **Dependencies**: None
- **Implementation steps**:
  1. Will define `Metrics.counter(name, labels)`, `Metrics.gauge(name, value, labels)`.
  2. Will wire emitters at call sites for: `intent.duplicate_classify_count`, `speculation.abandoned_count`, `stream.cancel_latency_ms`, `stealth.flicker_active`, `cache.global_clear_calls`, `worker_pool.queue_depth`, `cold_tier.entries_in_memory`, `stt.dropped_frames`.
  3. Will emit to local rolling log; expose via IPC `metrics:get` for renderer dashboard work later.
- **Acceptance criteria**: All listed metrics observable in local log.
- **Validation**: smoke test in `npm run test:electron`.
- **Definition of done**: standard DoD.

---

## 4. Cross-reference index (audit finding → ticket)

- S-1 → NAT-010
- S-2, S-3 → NAT-025
- S-4 → NAT-026
- S-5 → NAT-011, NAT-012
- S-6 → NAT-027
- S-7 → NAT-028
- S-8 → NAT-029
- S-9 → NAT-030
- S-10 → NAT-031
- S-11 → NAT-032
- S-12 → NAT-033
- S-13 → NAT-034
- S-14 → NAT-035
- A-1 → NAT-001
- A-2 → NAT-002
- A-3 → NAT-003
- A-4, A-9 → NAT-004
- A-5 → NAT-005
- A-6 → NAT-006
- A-7 → NAT-007
- A-8 → NAT-008
- A-10 → NAT-009
- A-11 → NAT-043
- A-12 → NAT-044
- A-13 → NAT-047
- A-14 → NAT-046
- A-15 → NAT-045
- P-1 → NAT-036
- P-2 → NAT-037
- P-3 → NAT-038
- P-4 → NAT-039
- P-5 → NAT-051, NAT-052
- P-6 → NAT-054
- P-7 → NAT-053
- P-8, P-10 → NAT-041
- P-9 → NAT-040
- P-11 → NAT-042
- P-12 → NAT-061
- P-13 → NAT-049
- P-14 → NAT-024
- R-1 → NAT-013
- R-2 → NAT-014
- R-3 → NAT-015
- R-4 → NAT-016
- R-5 → NAT-017
- R-6 → NAT-018
- R-7 → NAT-019
- R-8 → NAT-060
- R-9 → NAT-022
- R-10 → NAT-020
- R-11 → NAT-021
- R-12 → covered by EPIC-07 single-owner work in NAT-009/NAT-043 vicinity (no separate ticket; will be revisited in EPIC-16 audit)
- R-13 → NAT-023
- H-1 → EPIC-11 / NAT-055
- H-2 → EPIC-12 / NAT-056
- H-3 → EPIC-13 / NAT-057
- H-4 → EPIC-14 / NAT-058
- H-5 → EPIC-15 / NAT-059, NAT-060
- H-6 → EPIC-16 / NAT-062
- H-7 → EPIC-17 / NAT-063
- H-8 → EPIC-18 / NAT-064
- I-4 → EPIC-19 / NAT-065, NAT-066, NAT-067
- J-9 → NAT-082, NAT-083, NAT-084
- J-10 → NAT-086

---

## 5. Open assumptions to confirm before starting

> Each item below is a small, real prerequisite that the executing agent will confirm before the listed ticket starts. If any assumption is wrong, the ticket spec must be revised.

1. NAT-051 assumes the Foundation Models Swift API supports a long-lived session model that can multiplex requests by id. The agent will confirm by reading the Apple docs referenced in `docs/adr/2026-04-18-foundation-models-intent-classification-priority.md` and the helper Swift source. If unsupported, fallback design: a small fixed pool (size 2) of warm helper subprocesses with simple round-robin.
2. NAT-043 assumes `rubato` in `native-module/Cargo.toml` is already vendored. The agent will run `cargo build -p natively-audio` to confirm.
3. NAT-082 assumes macOS dev hardware with the screen-recording entitlement is available locally. The agent will confirm before starting Wave 2.
4. NAT-026 assumes the Privacy Shield UI's only consumer is `App.tsx`; the agent will grep `rg "privacy-shield"` to confirm before refactor.
5. NAT-031 assumes `assets/bin/macos/stealth-virtual-display-helper` is regenerated by `scripts/prepare-macos-virtual-display-helper.js`; the agent will read that script before renaming.

---

## 6. Changelog convention

Each ticket appends one line to `CHANGELOG.md` under the matching epic header on merge:

```
## EPIC-XX — <epic title>
- NAT-### <ticket title> (<original finding ids>)
```

This preserves end-to-end traceability from audit finding → ticket → commit → release note.
