# Foundation Models Intent Classification (Acceleration Mode) - Ticketed Implementation Plan

## Goal

Use Apple Foundation Models as the highest-priority intent classifier in acceleration mode on supported macOS Apple Silicon devices, with exponential backoff retries and deterministic fallback to existing classifier defaults. Keep Windows behavior unchanged.

## Architecture Summary

- Introduce an intent-provider abstraction.
- Add a Foundation Models-backed provider behind a Swift helper process.
- Add a coordinator that enforces priority order + retry/backoff + fallback.
- Preclassify intent during silence in acceleration orchestrator and cache by transcript revision.
- Reuse prefetched intent in the normal conscious pipeline without changing downstream route/planner/verifier shape.

## Ticket Breakdown

### FM-INT-001: Add intent provider abstraction and result contracts

**Files to create**

- `electron/llm/providers/IntentInferenceProvider.ts`

**Changes**

- Define provider interface:
  - `name`
  - `isAvailable(): Promise<boolean>`
  - `classify(input): Promise<IntentResult>`
  - optional `getHealth()`
- Define `IntentClassificationInput` contract:
  - `lastInterviewerTurn`
  - `preparedTranscript`
  - `assistantResponseCount`
  - `transcriptRevision?`
- Define typed error categories used by coordinator:
  - `unavailable`, `rate_limited`, `refusal`, `timeout`, `invalid_response`, `unknown`

**Acceptance**

- TypeScript compiles.
- Existing classifier can be adapted to this interface without behavior changes.

---

### FM-INT-002: Wrap current classifier as legacy provider

**Files to create**

- `electron/llm/providers/LegacyIntentProvider.ts`

**Files to edit**

- `electron/llm/IntentClassifier.ts`

**Changes**

- Keep existing `classifyIntent` behavior intact.
- Export a stable function to be used by `LegacyIntentProvider`.
- `LegacyIntentProvider.classify(...)` delegates to existing path.

**Acceptance**

- Existing tests around `IntentClassifier` remain green.
- No behavior change on Windows/non-acceleration paths.

---

### FM-INT-003: Add Foundation Models helper protocol and Swift CLI helper

**Files to create**

- `applesilicon/macos-foundation-intent-helper/Package.swift`
- `applesilicon/macos-foundation-intent-helper/Sources/main.swift`
- `applesilicon/macos-foundation-intent-helper/README.md`

**Helper contract (stdin JSON -> stdout JSON)**

Request:

```json
{
  "version": 1,
  "question": "...",
  "preparedTranscript": "...",
  "assistantResponseCount": 2,
  "promptVersion": "foundation_intent_prompt_v2",
  "schemaVersion": "foundation_intent_schema_v1",
  "locale": "en-US",
  "candidateIntents": ["behavioral","coding","deep_dive","clarification","follow_up","example_request","summary_probe","general"]
}
```

Response:

```json
{
  "ok": true,
  "intent": "behavioral",
  "confidence": 0.91,
  "answerShape": "Tell one concrete story in first person.",
  "provider": "apple_foundation_models",
  "promptVersion": "foundation_intent_prompt_v2",
  "schemaVersion": "foundation_intent_schema_v1"
}
```

Error response:

```json
{
  "ok": false,
  "errorType": "rate_limited|refusal|unavailable|model_not_ready|unsupported_locale|timeout|invalid_response|unknown",
  "message": "..."
}
```

**Swift implementation notes**

- `import FoundationModels`
- Check `SystemLanguageModel.default.availability` before classification.
- Use `LanguageModelSession.respond(to:generating:...)` with guided generation (`Generable` intent envelope).
- Keep prompt concise and deterministic for small on-device context.

**Acceptance**

- Helper runs on supported macOS and returns valid JSON envelope.
- Unsupported/unavailable states return typed error envelope.

---

### FM-INT-004: Add TS provider for Foundation Models helper

**Files to create**

- `electron/llm/providers/FoundationModelsIntentProvider.ts`

**Files to edit**

- `electron/config/optimizations.ts`

**Changes**

- Add optional optimization flags:
  - `useFoundationModelsIntent: boolean` (default true)
  - `foundationIntentRetryBaseMs: number` (default 100)
  - `foundationIntentMaxRetries: number` (default 2)
- Provider should:
  - hard gate by platform (`darwin/arm64`) + acceleration mode + flag
  - spawn helper process with bounded timeout
  - parse and validate response envelope
  - map helper errors to typed provider errors

**Acceptance**

- Provider returns `IntentResult` on success.
- Provider returns typed errors on helper failure.

---

### FM-INT-005: Add coordinator with priority, exponential backoff, and fallback

**Files to create**

- `electron/llm/providers/IntentClassificationCoordinator.ts`

**Files to edit**

- `electron/llm/index.ts`
- `electron/IntelligenceEngine.ts`

**Changes**

- Coordinator order:
  1. Foundation provider (when available)
  2. Legacy provider fallback
- Retry/backoff policy for Foundation transient errors:
  - `attempt 1`: immediate
  - `attempt 2`: `base * 2^1 + jitter`
  - `attempt 3`: `base * 2^2 + jitter`
- Do not retry on deterministic hard-unavailable errors.
- After exhaustion, fallback to legacy in same request.

**Acceptance**

- Logs/telemetry show provider path and fallback reason.
- On simulated refusal/rate-limit, coordinator retries then falls back.

---

### FM-INT-006: Prefetch intent in acceleration orchestrator and cache by transcript revision

**Files to edit**

- `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- `electron/services/AccelerationManager.ts`

**Changes**

- Add optional `intentClassifier` callback in orchestrator options.
- During silence-triggered speculative window, run preclassification in semantic lane.
- Store prefetched result keyed by:
  - `transcriptRevision`
  - normalized question
- Add APIs:
  - `getPrefetchedIntent(query, transcriptRevision)`
  - internal invalidation on transcript revision change / `clearState()`

**Acceptance**

- Prefetched intent available for same revision.
- Prefetched intent invalidates when transcript revision advances.

---

### FM-INT-007: Consume prefetched intent in conscious preparation and route phase

**Files to edit**

- `electron/IntelligenceEngine.ts`
- `electron/conscious/ConsciousPreparationCoordinator.ts`
- `electron/conscious/ConsciousIntentService.ts`
- `electron/conscious/ConsciousOrchestrator.ts`

**Changes**

- Extend intent resolution input with optional `prefetchedIntent`.
- Prefer prefetched intent when transcript revision matches current request.
- If no prefetched intent, call coordinator classify path.
- Keep existing downstream behavior unchanged (`intentResult` shape preserved).

**Acceptance**

- Conscious flow uses prefetched intent when present.
- No regressions in verifier/planner interfaces.

---

### FM-INT-008: Add tests for provider priority, retries, fallback, and platform gating

**Files to create**

- `electron/tests/intentClassificationCoordinator.test.ts`
- `electron/tests/foundationModelsIntentProvider.test.ts`

**Files to edit**

- `electron/tests/aneClassifierLane.test.ts`
- `electron/tests/consciousOrchestratorPurity.test.ts`
- `electron/tests/consciousModeNodeImport.test.ts`

**Test cases**

1. Uses Foundation provider first on eligible mac + acceleration enabled.
2. Retries Foundation on refusal/rate-limit with exponential backoff.
3. Falls back to legacy provider after retry exhaustion.
4. Uses legacy directly on Windows.
5. Prefetched intent cached and reused for same transcript revision.
6. Cache invalidates on revision change.

**Acceptance**

- All new tests pass.
- Existing classifier tests continue to pass.

---

### FM-INT-009: Build/packaging integration for Foundation helper (mac only)

**Files to edit**

- `scripts/prepare-macos-virtual-display-helper.js` (or split new script)
- `package.json`
- build resource config location used by Electron packaging

**Changes**

- Add script to build/copy Foundation helper binary into app resources for mac builds.
- Ensure helper path resolution works in dev + packaged modes.
- Do not affect Windows packaging.

**Acceptance**

- mac build includes helper binary.
- app can resolve helper path in packaged run.

---

### FM-INT-010: Runtime telemetry and operational guardrails

**Files to edit**

- `electron/IntelligenceEngine.ts`
- `electron/conscious/ConsciousIntentService.ts`
- any existing telemetry/log sink module used by latency tracker

**Changes**

- Add metadata fields:
  - `intentProviderUsed`
  - `intentRetryCount`
  - `intentFallbackReason`
  - `prefetchedIntentUsed`
- Ensure no PII leakage in logs.

**Acceptance**

- Debug logs clearly show provider selection and fallback reason.
- No raw transcript dump added beyond existing policies.

---

## Exact File-Level Change Matrix

### New files

- `electron/llm/providers/IntentInferenceProvider.ts`
- `electron/llm/providers/LegacyIntentProvider.ts`
- `electron/llm/providers/FoundationModelsIntentProvider.ts`
- `electron/llm/providers/IntentClassificationCoordinator.ts`
- `electron/tests/intentClassificationCoordinator.test.ts`
- `electron/tests/foundationModelsIntentProvider.test.ts`
- `applesilicon/macos-foundation-intent-helper/Package.swift`
- `applesilicon/macos-foundation-intent-helper/Sources/main.swift`
- `applesilicon/macos-foundation-intent-helper/README.md`

### Modified files

- `electron/llm/IntentClassifier.ts`
- `electron/llm/index.ts`
- `electron/config/optimizations.ts`
- `electron/services/AccelerationManager.ts`
- `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- `electron/IntelligenceEngine.ts`
- `electron/conscious/ConsciousPreparationCoordinator.ts`
- `electron/conscious/ConsciousIntentService.ts`
- `electron/conscious/ConsciousOrchestrator.ts`
- `electron/tests/aneClassifierLane.test.ts`
- `electron/tests/consciousOrchestratorPurity.test.ts`
- `electron/tests/consciousModeNodeImport.test.ts`
- `package.json`
- mac helper build/packaging script file(s)

## Delivery Phases

### Phase 1 (safe wiring)

- FM-INT-001, FM-INT-002, FM-INT-005 (legacy-only coordinator), FM-INT-008 partial tests

### Phase 2 (acceleration preclassify)

- FM-INT-006, FM-INT-007, FM-INT-010

### Phase 3 (Foundation provider)

- FM-INT-003, FM-INT-004, FM-INT-009, FM-INT-008 full tests

## Rollout Strategy

1. Ship with Foundation provider behind flag `useFoundationModelsIntent` default true only when acceleration enabled.
2. Keep legacy fallback always active.
3. Monitor telemetry for fallback frequency and retry patterns.
4. If instability observed, disable via flag without code rollback.

## Done When

- On supported mac acceleration mode, intent classification uses Foundation Models first.
- On Foundation refusal/transient failures, exponential backoff and fallback operate correctly.
- On Windows, behavior remains unchanged.
- Conscious flow consumes prefetched intent without breaking routing/planner/verifier.
- Tests cover provider selection, retries, fallback, and prefetch reuse/invalidation.
