# Mode-Tiered First-Token Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal mode hit a measurable low-latency first-token path while keeping profile mode bounded with graceful fallback and restricting Conscious Mode to system-design or screenshot-backed live-coding flows.

**Architecture:** Tighten route-specific orchestration in `IntelligenceEngine` so `fast_standard_answer` has the smallest possible pre-stream path, `enriched_standard_answer` uses a bounded enrichment timeout with explicit fallback metadata, and `conscious_answer` distinguishes fresh starts from continuation-only turns plus live-coding screenshot eligibility. Expand latency instrumentation so these mode-specific behaviors are observable and regression-testable.

**Tech Stack:** TypeScript, Electron, Node `node:test`, existing `IntelligenceEngine` / `SessionTracker` / `AnswerLatencyTracker` / route selector infrastructure

---

### Task 1: Extend latency instrumentation for SLO-grade visibility

**Files:**
- Modify: `electron/latency/AnswerLatencyTracker.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Test (extend): `electron/tests/answerLatencyTracker.test.ts`

- [ ] **Step 1: Write the failing test**

Extend tracker coverage so snapshots can record route, provider capability for all three classes (`streaming`, `buffered`, `non_streaming_custom`), `firstToken` or `firstVisibleAnswer`, `requestId`, `transcriptRevision`, `fallbackOccurred`, `profileFallbackReason`, `interimQuestionSubstitutionOccurred`, profile-enrichment lifecycle states (`attempted`, `completed`, `failed`, `timed_out`), and Conscious path metadata (`fresh_start` vs `thread_continue`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerLatencyTracker.test.js`
Expected: FAIL because the tracker does not yet support the additional metadata contract.

- [ ] **Step 3: Write minimal implementation**

Add optional metadata fields and helper methods that preserve current tracker behavior while allowing route-specific timing markers for streaming and non-streaming providers.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerLatencyTracker.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 1 files and create a focused commit.

### Task 2: Make normal mode hot path explicit and minimal

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/llm/WhatToAnswerLLM.ts`
- Test (extend): `electron/tests/accelerationAnswerPath.test.ts`
- Test (extend): `electron/tests/whatToSayConcurrency.test.ts`
- Test (extend): `electron/tests/consciousModeOffRegression.test.ts`

- [ ] **Step 1: Write the failing tests**

Add or extend tests so normal-mode requests prove that the latest final/interim interviewer turn is used immediately, optional enrichment is skipped before provider start, and the tracker marks `providerRequestStarted` before any profile or Conscious-only work can occur. When an interim question is used instead of the final question, assert that the tracker records `interimQuestionSubstitutionOccurred: true`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/accelerationAnswerPath.test.js dist-electron/electron/tests/whatToSayConcurrency.test.js dist-electron/electron/tests/consciousModeOffRegression.test.js`
Expected: FAIL because the hot path is not yet explicitly budgeted or observable.

- [ ] **Step 3: Write minimal implementation**

Refactor the normal `fast_standard_answer` branch so it only resolves the latest question, constructs the smallest safe transcript context, chooses the compact prompt shell, and starts provider streaming immediately.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/accelerationAnswerPath.test.js dist-electron/electron/tests/whatToSayConcurrency.test.js dist-electron/electron/tests/consciousModeOffRegression.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 2 files and create a focused commit.

### Task 3: Bound profile enrichment and make fallback explicit

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/latency/answerRouteSelector.ts`
- Test (extend): `electron/tests/profileModeRouting.test.ts`
- Test (extend): `electron/tests/answerRouteSelector.test.ts`

- [ ] **Step 1: Write the failing tests**

Add coverage proving that profile-required questions attempt enrichment, enforce a bounded enrichment budget, emit explicit fallback metadata on timeout/error/no-context, and keep generic technical prompts on the fast route even when profile mode is enabled.

Use deterministic phrase matching only. Encode the full canonical positive fixture set from the spec, including `tell me about yourself`, `walk me through your resume`, `walk me through your background`, `tell me about your background`, `why are you a fit for this role`, `tell me about a project you worked on`, and `what experience do you have with redis in your previous role`, plus negative fixtures such as `how would you design a rate limiter` and `have you worked with redis`.

Note: some negative fixtures here (e.g. `what are the tradeoffs`, `how would you shard this`) are also used as positive continuation fixtures in Task 4. This dual role is intentional — they are not profile-required questions but are valid Conscious Mode continuations when an active design thread exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/profileModeRouting.test.js dist-electron/electron/tests/answerRouteSelector.test.js`
Expected: FAIL because the bounded fallback contract is not yet encoded in tests or implementation.

- [ ] **Step 3: Write minimal implementation**

Implement a profile-enrichment timeout gate with an explicit `250 ms` pre-stream budget, attach `profileFallbackReason` metadata when the system degrades to generic output, and preserve the existing latest-question routing contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/profileModeRouting.test.js dist-electron/electron/tests/answerRouteSelector.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 3 files and create a focused commit.

### Task 4: Restrict Conscious Mode and add continuation fast lane

**Files:**
- Modify: `electron/ConsciousMode.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/llm/prompts.ts`
- Test (extend): `electron/tests/consciousModeRouting.test.ts`
- Test (extend): `electron/tests/consciousModeFollowupThread.test.ts`
- Test (extend): `electron/tests/consciousPrompts.test.ts`
- Test (create): `electron/tests/manualAndFollowupRegression.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that require Conscious Mode to route only for system-design questions or screenshot-backed live-coding turns, distinguish `fresh_start` from `thread_continue`, reset safely on clear topic shifts, and prefer `fresh_start` when continuation detection is ambiguous.

Use deterministic phrase matching only for continuation fixtures such as `what are the tradeoffs`, `how would you shard this`, `what happens during failover`, and `what metrics would you watch`, plus explicit stale-work cases where transcript revision or request ordering changes should discard continuation reuse, and ambiguous fixtures that must choose `fresh_start` safely.

Required screenshot-eligibility tests:
- Conscious Mode + live-coding question + **no screenshot context** → must NOT route to `conscious_answer`
- Conscious Mode + live-coding question + **screenshot context present** → must route to `conscious_answer`

Required boundary test:
- A continuation phrase (e.g. `what are the tradeoffs`) with **no active Conscious thread** → must route to normal mode (`fast_standard_answer`), not `fresh_start` Conscious

Also create `manualAndFollowupRegression.test.ts` to verify that manual answer and follow-up refinement semantics are not regressed by the new routing restrictions. Cover at minimum: manual answer triggers bypass mode-tiered routing, and follow-up refinement requests preserve existing behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js`
Expected: FAIL because the stricter eligibility and continuation metadata are not yet fully enforced.

- [ ] **Step 3: Write minimal implementation**

Enforce Conscious eligibility around system design or screenshot-backed live coding, add explicit continuation-vs-fresh-start tagging, anchor continuation reuse to request ID and transcript revision, discard stale continuation work, prefer `fresh_start` on ambiguous continuation inputs, and keep continuation setup within a `<= 150 ms` local orchestration target that is cheaper than fresh-start orchestration.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 4 files and create a focused commit.

### Task 5: Verify end-to-end latency contracts and safety

**Files:**
- Verify: `electron/tests/answerLatencyTracker.test.ts`
- Verify: `electron/tests/accelerationAnswerPath.test.ts`
- Verify: `electron/tests/whatToSayConcurrency.test.ts`
- Verify: `electron/tests/consciousModeOffRegression.test.ts`
- Verify: `electron/tests/profileModeRouting.test.ts`
- Verify: `electron/tests/answerRouteSelector.test.ts`
- Verify: `electron/tests/consciousModeRouting.test.ts`
- Verify: `electron/tests/consciousModeFollowupThread.test.ts`
- Verify: `electron/tests/consciousPrompts.test.ts`
- Verify: `electron/tests/manualAndFollowupRegression.test.ts`

- [ ] **Step 1: Run typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run targeted Electron tests**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerLatencyTracker.test.js dist-electron/electron/tests/accelerationAnswerPath.test.js dist-electron/electron/tests/whatToSayConcurrency.test.js dist-electron/electron/tests/consciousModeOffRegression.test.js dist-electron/electron/tests/profileModeRouting.test.js dist-electron/electron/tests/answerRouteSelector.test.js dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js dist-electron/electron/tests/manualAndFollowupRegression.test.js`
Expected: PASS.

- [ ] **Step 3: Run Electron coverage gate**

Run: `npm run verify:electron:coverage`
Expected: PASS.

- [ ] **Step 4: Capture latency evidence**

Run the app locally and record route-level latency logs for normal mode, profile-required fallback, and Conscious continuation so you can confirm the new metadata is emitted.

- [ ] **Step 5: Run repeatable latency harness**

Create `scripts/benchmark-fast-path.ts` — a controlled local benchmark that mocks the provider with a fixed-delay stub (e.g. 50 ms simulated provider latency), runs at least 100 iterations of `fast_standard_answer`, segments timing samples by route and provider capability (`streaming`, `buffered`, `non_streaming_custom`), and reports p50/p95 first-token latency from the collected run. The harness must isolate local orchestration cost from real provider/network variance.

- [ ] **Step 6: Check SLO evidence**

Verify the harness output shows normal-mode `fast_standard_answer` trending toward `p50 <= 200 ms` and `p95 <= 900 ms`, or clearly report any remaining gap with the corresponding pre-stream markers.
