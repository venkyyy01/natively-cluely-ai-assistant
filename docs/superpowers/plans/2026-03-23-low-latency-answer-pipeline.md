# Low-Latency Answer Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make standard answer generation start visibly faster by removing non-essential blocking work from the critical path, while preserving correctness across conscious mode, profile/knowledge mode, and custom/cURL providers.

**Architecture:** Introduce a deterministic, provider-agnostic route selector for answer requests, add lightweight latency instrumentation, and keep a minimal fast route separate from enriched paths. Reuse compact transcript/prompt artifacts and guard all deferred work with request IDs and transcript revisions so background work never contaminates the wrong turn.

**Tech Stack:** Electron, TypeScript, node:test, existing `IntelligenceEngine` / `LLMHelper` / `SessionTracker` infrastructure.

---

### Task 1: Add baseline latency instrumentation and route logging

**Files:**
- Create: `electron/latency/AnswerLatencyTracker.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/answerLatencyTracker.test.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerLatencyTracker.test.js` and verify it fails**
- [ ] **Step 3: Implement a minimal tracker with request IDs, route names, provider capability class, spans, and safe completion**
- [ ] **Step 4: Re-run the same test and verify it passes**
- [ ] **Step 5: Capture a pre-change baseline from the current route-level timings before any further behavior changes**

### Task 2: Add deterministic route selection

**Files:**
- Create: `electron/latency/answerRouteSelector.ts`
- Create: `electron/latency/providerCapability.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/answerRouteSelector.test.ts`

- [ ] **Step 1: Write failing route-selection tests covering manual, follow-up, conscious, profile-required, knowledge-required, fast-standard, and non-streaming provider capability cases**
- [ ] **Step 2: Run the selector test and verify it fails**
- [ ] **Step 3: Implement the selector and provider capability classification with exact normalization and phrase rules from the spec**
- [ ] **Step 4: Re-run the selector test and verify it passes**

### Task 3: Wire fast standard route into `runWhatShouldISay`

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/accelerationAnswerPath.test.ts`
- Test: `electron/tests/consciousModeRouting.test.ts`
- Test: `electron/tests/consciousModeOffRegression.test.ts`
- Test: `electron/tests/manualAndFollowupRegression.test.ts`
- Test: `electron/tests/nonStreamingProviderFastPath.test.ts`

- [ ] **Step 1: Extend tests so route decisions and call ordering are observable in the answer path**
- [ ] **Step 2: Run targeted tests and verify the new expectations fail**
- [ ] **Step 3: Implement route-based orchestration so `fast_standard_answer` skips blocking intent/temporal enrichment and non-streaming/custom providers still record the correct capability-aware timing semantics**
- [ ] **Step 4: Re-run targeted tests and verify they pass**

### Task 4: Add compact transcript snapshot reuse

**Files:**
- Modify: `electron/SessionTracker.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/sessionTrackerSnapshotCache.test.ts`

- [ ] **Step 1: Write a failing test for transcript revision-based snapshot reuse/invalidation with session isolation and snapshot-type scoping**
- [ ] **Step 2: Run the new test and verify it fails**
- [ ] **Step 3: Implement compact snapshot caching keyed by session ID, transcript revision, route type, and snapshot type**
- [ ] **Step 4: Re-run the test and verify it passes**

### Task 5: Add provider-agnostic prompt-shell reuse

**Files:**
- Modify: `electron/llm/prompts.ts`
- Create: `electron/latency/FastPromptCache.ts`
- Modify: `electron/LLMHelper.ts`
- Test: `electron/tests/fastPromptCache.test.ts`
- Test: `electron/tests/fastStandardPrompt.test.ts`

- [ ] **Step 1: Write a failing test for the dedicated `fast_standard_prompt` family and its low-latency contract**
- [ ] **Step 2: Run the prompt test and verify it fails**
- [ ] **Step 3: Implement the dedicated `fast_standard_prompt` family in `electron/llm/prompts.ts` without changing richer prompt families**
- [ ] **Step 4: Write a failing test for cache key isolation by provider family, capability class, language, prompt version, and route**
- [ ] **Step 5: Run the cache test and verify it fails**
- [ ] **Step 6: Implement prompt-shell caching with explicit TTL/max-size bounds and invalidation rules without changing provider execution semantics**
- [ ] **Step 7: Re-run both prompt and cache tests and verify they pass**

### Task 6: Add deferred enrichment guards before broad fast-path rollout

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/SessionTracker.ts`
- Test: `electron/tests/answerEnrichmentIsolation.test.ts`

- [ ] **Step 1: Write a failing test proving stale background work is discarded after transcript revision changes or newer requests**
- [ ] **Step 2: Run the test and verify it fails**
- [ ] **Step 3: Implement request-ID/transcript-revision checks for deferred work**
- [ ] **Step 4: Re-run the test and verify it passes**

### Task 7: Verify provider and mode safety

**Files:**
- Modify: `electron/tests/ipcContracts.test.ts` if needed
- Test: `electron/tests/consciousModeRouting.test.ts`
- Test: `electron/tests/consciousModeOffRegression.test.ts`
- Test: `electron/tests/accelerationModeIntegration.test.ts`
- Test: `electron/tests/accelerationAnswerPath.test.ts`
- Test: `electron/tests/answerRouteSelector.test.ts`
- Test: `electron/tests/answerLatencyTracker.test.ts`
- Test: `electron/tests/answerEnrichmentIsolation.test.ts`
- Test: `electron/tests/manualAndFollowupRegression.test.ts`
- Test: `electron/tests/customProviderFastPath.test.ts`
- Test: `electron/tests/nonStreamingProviderFastPath.test.ts`

- [ ] **Step 1: Run the targeted electron test suite**
- [ ] **Step 2: Run electron typecheck**
- [ ] **Step 3: Check that baseline-vs-new latency logs include route and capability metadata and show reduced pre-stream work on fast route**
- [ ] **Step 4: Fix any regressions without broadening scope**
- [ ] **Step 5: Re-run tests and verify clean pass**
