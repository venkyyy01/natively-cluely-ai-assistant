# Remaining TODO Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every remaining unchecked item in `TODO.md`, including narrow LLM-side caching limited to system-prompt/final-payload/exact-duplicate request reuse in `electron/LLMHelper.ts`, without regressing existing interview, meeting, IPC, or renderer behavior.

**Architecture:** Work in serialized phases around shared hot files, but dispatch independent subagents in parallel inside each phase. Put LLM prompt/caching changes in `electron/LLMHelper.ts` and `electron/llm/prompts.ts`, keep `Conscious Mode` isolated behind new structured-response paths, and close IPC TODOs with explicit validation/type coverage rather than ad hoc edits.

**Tech Stack:** Electron, TypeScript, React, node:test, Vite, Electron IPC, localStorage/electron-store patterns, existing analytics service.

---

## File Structure / Ownership Map

- `docs/superpowers/specs/2026-03-20-todo-remaining-work-design.md`
  - Approved design source of truth.
- `TODO.md`
  - Final reconciliation target; update only after each tranche is verified.
- `electron/llm/prompts.ts`
  - Core interview/system prompts; add Conscious Mode prompt families here.
- `electron/LLMHelper.ts`
  - Final provider prompt assembly, system-prompt mapping, exact-request caching, budgeting, retry consistency.
- `electron/IntelligenceEngine.ts`
  - Routing, structured reasoning-first generation, qualifying-question detection.
- `electron/IntelligenceManager.ts`
  - Facade and event forwarding for new structured output.
- `electron/SessionTracker.ts`
  - Rolling reasoning thread state and reset logic.
- `electron/main.ts`
  - Trigger path integration for Conscious Mode.
- `electron/ipcHandlers.ts`
  - Shared root IPC hot file; serialize changes carefully.
- `electron/ipc/registerProfileHandlers.ts`
  - Profile handler validation and result contracts.
- `electron/ipc/registerRagHandlers.ts`
  - RAG handler validation/result contracts.
- `electron/ipc/registerSettingsHandlers.ts`
  - Conscious Mode toggle plumbing and remaining settings handler normalization.
- `electron/preload.ts`
  - Typed wrappers for all renderer-callable IPC.
- `src/types/electron.d.ts`
  - Renderer typings for preload API.
- `src/components/NativelyInterface.tsx`
  - In-session dropdown toggle placement and reasoning-first rendering wiring.
- `src/components/SuggestionOverlay.tsx`
  - Structured output presentation if this remains the active assist surface.
- `src/components/SettingsOverlay.tsx`
  - Split into smaller settings sections.
- `src/components/settings/*`
  - Target location for extracted settings sections.
- `src/lib/analytics/analytics.service.ts`
  - Conscious Mode analytics contract.
- `electron/services/CalendarManager.ts`
  - OAuth callback redesign.
- `electron/utils/transformersLoader.js`
  - Remove eval-based loading.
- `electron/llm/IntentClassifier.ts`
  - Update loader use and routing support if needed.
- `electron/rag/providers/LocalEmbeddingProvider.ts`
  - Update loader use if needed.
- `src/App.tsx`
  - Shared renderer state/query ownership cleanup.
- `renderer/src/App.test.tsx`
  - Replace boilerplate tests with app-relevant tests.
- `electron/tsconfig.json`
  - Stricter TS flags tranche.
- `package.json`
  - Postinstall evaluation and simplification if justified.

## Parallelization Rules

Never run implementation subagents in parallel when they touch the same hot file:

- `electron/LLMHelper.ts`
- `electron/ipcHandlers.ts`
- `electron/preload.ts`
- `src/types/electron.d.ts`
- `src/components/NativelyInterface.tsx`
- `electron/main.ts`

Safe parallel groups after prerequisites land:

- Prompt definitions in `electron/llm/prompts.ts` vs analytics test scaffolding
- `electron/services/CalendarManager.ts` vs `electron/utils/transformersLoader.js`
- `src/components/SettingsOverlay.tsx` extraction vs `renderer/src/App.test.tsx` replacement, if the tests do not depend on in-flight extracted components

Required execution order by phase:

1. Task 3
2. Task 1
3. Task 4
4. Task 4B
5. Task 5
6. Task 6
7. Task 7
8. Task 8
9. Task 11
10. Task 9
11. Task 10
12. Task 12

Dependency note:

- Task 1 must not begin until Task 3 has defined the structured Conscious Mode contract, because prompt families must reflect the approved response shape.

## Task 0: Reconcile `TODO.md` after each verified tranche

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: After each completed task tranche, re-read the related unchecked TODO items**

- [ ] **Step 2: Only mark items complete when fresh verification evidence exists**

- [ ] **Step 3: Reconcile stale `Recommended Execution Order` and `Exit Criteria` entries as soon as their source truth is verified**

Run: `git diff -- TODO.md`
Expected: only bookkeeping changes supported by already-verified source changes.

**Gate:** No later task begins until this reconciliation step has been performed for the previous verified tranche.

## Task 1: Add Conscious Mode prompt families in prompt source

**Files:**
- Modify: `electron/llm/prompts.ts`
- Test: Create `electron/tests/consciousPrompts.test.ts`

- [ ] **Step 1: Write the failing tests for Conscious Mode prompt exports and required sections**

```ts
test('exports conscious mode prompt family', async () => {
  // expect opening reasoning / implementation / pushback / follow-up prompts to exist
});

test('conscious opening prompt forbids code-first responses', async () => {
  // expect prompt text to require spoken reasoning before implementation
});
```

- [ ] **Step 2: Run the targeted electron tests and watch them fail**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousPrompts.test.js`
Expected: FAIL because Conscious Mode prompt exports do not exist yet.

- [ ] **Step 3: Add Conscious Mode prompt constants in `electron/llm/prompts.ts`**

Create a prompt family for:

- opening spoken reasoning
- implementation path
- pushback handling
- follow-up continuation

Keep existing prompt constants unchanged for non-Conscious flows.

- [ ] **Step 4: Re-run the targeted tests again and make them pass**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousPrompts.test.js`
Expected: PASS

## Task 3: Implement Conscious Mode structured response contract and reasoning-first routing

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/IntelligenceManager.ts`
- Modify: `electron/SessionTracker.ts`
- Modify: `electron/llm/WhatToAnswerLLM.ts`
- Modify: `electron/llm/AnswerLLM.ts`
- Modify: `electron/llm/FollowUpLLM.ts`
- Test: Create `electron/tests/consciousModeRouting.test.ts`
- Test: Create `electron/tests/consciousModeFollowupThread.test.ts`
- Test: Create `electron/tests/consciousModeOffRegression.test.ts`

- [ ] **Step 1: Write failing tests for structured reasoning-first output and thread continuation**

```ts
test('routes qualifying technical questions to reasoning-first output when conscious mode is enabled', async () => {
  // expect openingReasoning first and no code-first response
});

test('continues reasoning thread for pushback follow-up', async () => {
  // expect prior approach/tradeoffs to carry forward
});
```

- [ ] **Step 2: Run the new tests and verify they fail for the expected reason**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousModeOffRegression.test.js`
Expected: FAIL because structured mode/routing does not exist yet.

- [ ] **Step 3: Add the structured response type and minimal engine support**

Implement fields for:

- `openingReasoning`
- `implementationPlan`
- `tradeoffs`
- `edgeCases`
- `scaleConsiderations`
- `pushbackResponses`
- `likelyFollowUps`
- `codeTransition`

- [ ] **Step 4: Add qualifying-question detection and follow-up reset/continue rules**

Cover explicit positive and negative examples from the spec.

- [ ] **Step 5: Add backward-compatibility coverage for mode-off behavior**

Verify existing non-Conscious behavior remains unchanged when the toggle is disabled.

- [ ] **Step 6: Re-run targeted tests until green**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousModeOffRegression.test.js`
Expected: PASS

- [ ] **Step 7: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 4: Add Conscious Mode persistence, IPC, preload, and renderer typings

**Files:**
- Modify: `electron/ipc/registerSettingsHandlers.ts`
- Modify: `electron/ipcHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Modify: existing app settings persistence path used by settings handlers
- Test: Create `electron/tests/consciousModeIpc.test.ts`

- [ ] **Step 1: Write failing tests for toggle get/set and persistence behavior**

- [ ] **Step 2: Run tests and confirm failure**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeIpc.test.js`
Expected: FAIL because Conscious Mode IPC does not exist yet.

- [ ] **Step 3: Add getter/setter IPC with explicit success/error result contracts**

Use backend-backed persisted truth; do not make this localStorage-only.

- [ ] **Step 4: Add preload wrappers and `src/types/electron.d.ts` declarations**

No renderer-facing `any` contracts.

- [ ] **Step 5: Re-run targeted tests**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeIpc.test.js`
Expected: PASS

- [ ] **Step 6: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 4B: Wire Conscious Mode into transcript-trigger integration in `electron/main.ts`

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/IntelligenceManager.ts`
- Test: Extend `electron/tests/consciousModeRouting.test.ts`

- [ ] **Step 1: Write a failing integration-style test for transcript-trigger routing through `electron/main.ts`**

- [ ] **Step 2: Run the targeted test and confirm failure**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js`
Expected: FAIL because the trigger path is not yet wired end-to-end.

- [ ] **Step 3: Route qualifying interviewer technical questions to the reasoning-first path when Conscious Mode is enabled**

- [ ] **Step 4: Verify non-Conscious behavior stays unchanged when the toggle is off**

- [ ] **Step 5: Re-run the targeted test**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js`
Expected: PASS

- [ ] **Step 6: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 5: Implement Conscious Mode renderer toggle placement and structured speaking blocks

**Files:**
- Modify: `src/components/NativelyInterface.tsx`
- Modify: `src/components/SuggestionOverlay.tsx`
- Modify: `src/lib/analytics/analytics.service.ts`
- Test: Modify `renderer/src/App.test.tsx`
- Test: Create `renderer/src/consciousMode.test.tsx`

- [ ] **Step 1: Write failing renderer tests for exact toggle placement and structured sections**

- [ ] **Step 2: Run renderer tests and verify failure**

Run: `npm --prefix renderer test -- --runInBand consciousMode.test.tsx`
Expected: FAIL because the toggle/sections do not exist yet.

- [ ] **Step 3: Add `Conscious Mode` in the dropdown below Fast Mode/transcript toggles**

Match current styling/interaction.

- [ ] **Step 4: Render explicit sections**

At minimum:

- `Say This First`
- `Then Build It`
- `Tradeoffs`
- `If They Push Back`
- `If They Ask For Code`

- [ ] **Step 5: Add analytics events/assertions**

At minimum verify the exact contract from the spec:

- `mode_selected` fires when Conscious Mode is enabled/disabled
- reasoning-first generation is tracked with properties that distinguish Conscious Mode output from standard interview assist
- follow-up extension tracking is distinct from a fresh reasoning thread where practical

- [ ] **Step 6: Re-run renderer tests**

Run: `npm --prefix renderer test -- --runInBand consciousMode.test.tsx`
Expected: PASS

- [ ] **Step 7: Add naturalness guardrail assertions**

Verify in tests/fixtures that:

- `Say This First` renders before implementation sections
- the opening reasoning stays bounded and code does not appear first

- [ ] **Step 8: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 6: Normalize remaining root IPC handlers in `electron/ipcHandlers.ts`

**Files:**
- Modify: `electron/ipcHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Test: Modify `electron/tests/ipcValidation.test.ts`
- Test: Create `electron/tests/ipcContracts.test.ts`

- [ ] **Step 1: Write failing tests or fixtures for one raw handler family per file**

- [ ] **Step 2: Run targeted tests and confirm they fail**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcValidation.test.js dist-electron/electron/tests/ipcContracts.test.js`
Expected: FAIL due to mixed contracts/unvalidated payloads.

- [ ] **Step 3: Normalize handlers per the approved inventory in the spec appendix**

For the root handler slice, ensure:

- validated inputs where applicable
- consistent `success/data/error` envelope
- preload wrappers exist for affected renderer-callable root channels
- `src/types/electron.d.ts` entries exist for the affected root channels

- [ ] **Step 4: Re-run targeted tests**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcValidation.test.js dist-electron/electron/tests/ipcContracts.test.js`
Expected: PASS

- [ ] **Step 5: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 7: Normalize remaining settings/profile/RAG IPC inventories and close preload typing

**Files:**
- Modify: `electron/ipc/registerSettingsHandlers.ts`
- Modify: `electron/ipc/registerProfileHandlers.ts`
- Modify: `electron/ipc/registerRagHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Test: Modify `electron/tests/ipcValidation.test.ts`
- Test: Modify `electron/tests/ipcContracts.test.ts`

- [ ] **Step 1: Write failing tests or fixtures for one handler family per inventory file**

- [ ] **Step 2: Run targeted tests and confirm they fail**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcValidation.test.js dist-electron/electron/tests/ipcContracts.test.js`
Expected: FAIL due to mixed contracts/unvalidated payloads.

- [ ] **Step 3: Normalize handlers per the approved inventory appendix in the spec**

For each upgraded channel, ensure:

- validated inputs where applicable
- consistent `success/data/error` envelope
- preload wrapper exists
- `src/types/electron.d.ts` entry exists
- renderer call sites use the typed preload wrappers rather than ad hoc/untyped calls for the affected channels
- shared payload/result types are introduced where repeated anonymous objects currently exist

- [ ] **Step 4: Re-run targeted tests**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcValidation.test.js dist-electron/electron/tests/ipcContracts.test.js`
Expected: PASS

- [ ] **Step 5: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 8: Redesign Calendar OAuth callback flow and remove eval-based transformers loader

**Files:**
- Modify: `electron/services/CalendarManager.ts`
- Modify: `electron/utils/transformersLoader.js`
- Modify: `electron/llm/IntentClassifier.ts`
- Modify: `electron/rag/providers/LocalEmbeddingProvider.ts`
- Test: Create `electron/tests/calendarAuthFlow.test.ts`
- Test: Create `electron/tests/transformersLoader.test.ts`

- [ ] **Step 1: Write failing tests or verification harnesses for callback flow and loader use**

- [ ] **Step 2: Perform OAuth redirect-mechanism discovery before coding**

Document whether the current Google OAuth app configuration supports app-protocol deep linking or requires hardened localhost fallback.

- [ ] **Step 3: Run tests and confirm failure or missing behavior**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/calendarAuthFlow.test.js dist-electron/electron/tests/transformersLoader.test.js`
Expected: FAIL or missing coverage proving the current paths are not yet compliant.

- [ ] **Step 4: Implement the OAuth primary/fallback path from the spec**

Preferred:

- app-to-browser-to-app deep link if supported

Fallback:

- hardened `127.0.0.1` single-use listener with strict path/state/PKCE/timeout teardown

- [ ] **Step 5: Remove eval-based loader usage and replace with packaging-safe loading**

- [ ] **Step 6: Re-run targeted verification in development context**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/calendarAuthFlow.test.js dist-electron/electron/tests/transformersLoader.test.js && npm run build`
Expected: PASS

- [ ] **Step 7: Run packaged verification for both sensitive paths**

Run: `npm run app:build`
Expected: completes and provides packaged-build evidence needed to close the TODO item.

- [ ] **Step 8: Capture runtime evidence for the packaged/dev-sensitive paths**

Concrete validation requirement:

- launch the built app artifact produced by `npm run app:build`
- exercise the Calendar auth entry path far enough to prove the selected callback mechanism is wired in the packaged app
- exercise the transformers-dependent code path used by `electron/llm/IntentClassifier.ts` and `electron/rag/providers/LocalEmbeddingProvider.ts` in the packaged app
- record the observed packaged runtime result before closing the TODO item

## Task 9: Extract `SettingsOverlay` sections

**Files:**
- Modify: `src/components/SettingsOverlay.tsx`
- Create/Modify: `src/components/settings/*`
- Test: Create `renderer/src/settingsOverlaySections.test.tsx`

- [ ] **Step 1: Write failing renderer tests for extracted settings behavior**

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm --prefix renderer test -- --runInBand settingsOverlaySections.test.tsx`
Expected: FAIL

- [ ] **Step 3: Extract at least two cohesive sections from `src/components/SettingsOverlay.tsx`**

At minimum:

- STT/provider settings section
- one additional independent settings area

- [ ] **Step 4: Re-run tests**

Run: `npm --prefix renderer test -- --runInBand settingsOverlaySections.test.tsx`
Expected: PASS

- [ ] **Step 5: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 10: Replace renderer boilerplate tests and clean up shared renderer ownership

**Files:**
- Modify: `renderer/src/App.test.tsx`
- Modify: `src/App.tsx`
- Test: `renderer/src/App.test.tsx`

- [ ] **Step 1: Write failing app-relevant renderer tests in `renderer/src/App.test.tsx`**

- [ ] **Step 2: Run the renderer test and confirm failure**

Run: `npm --prefix renderer test -- --runInBand App.test.tsx`
Expected: FAIL because the test is still boilerplate or does not cover app behavior.

- [ ] **Step 3: Replace boilerplate tests and tighten `src/App.tsx` ownership boundaries where needed**

- [ ] **Step 4: Re-run the renderer test**

Run: `npm --prefix renderer test -- --runInBand App.test.tsx`
Expected: PASS

- [ ] **Step 5: Run tranche verification**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 11: Add narrow LLM-side caching, budgeting, and retry consistency in `electron/LLMHelper.ts`

**Files:**
- Modify: `electron/LLMHelper.ts`
- Test: Create `electron/tests/llmHelperCaching.test.ts`
- Test: Create `electron/tests/llmHelperRetryBudgeting.test.ts`

- [ ] **Step 1: Write the failing tests for exact-match prompt/request caching**

```ts
test('reuses cached response for identical provider/model/system-prompt/final-payload inputs', async () => {
  // same fully assembled request twice => one provider send
});

test('misses cache when final payload changes', async () => {
  // change context/question/model and expect a second provider send
});
```

- [ ] **Step 2: Write the failing tests for budgeting/retry behavior**

```ts
test('applies model-specific input budgeting before dispatch', async () => {
  // oversized input trimmed/summarized according to selected model path
});

test('does not retry non-retryable failures', async () => {
  // verify retry policy split
});
```

- [ ] **Step 3: Run the targeted tests and watch them fail**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/llmHelperCaching.test.js dist-electron/electron/tests/llmHelperRetryBudgeting.test.js`
Expected: FAIL because the cache/policy behavior does not exist yet.

- [ ] **Step 4: Implement only the narrow cache in `electron/LLMHelper.ts`**

Add:

- system prompt cache for provider-mapped/injected prompt strings
- final request payload cache for repeated assembly work
- exact-match short-TTL response cache and optional in-flight dedupe keyed by provider/model/system-prompt-hash/final-payload-hash

Do not cache partial stream tokens. Do not cache broad session state.

- [ ] **Step 5: Implement model-specific budgeting and retry normalization in `electron/LLMHelper.ts`**

- [ ] **Step 6: Re-run the targeted tests and make them pass**

Run: `tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/llmHelperCaching.test.js dist-electron/electron/tests/llmHelperRetryBudgeting.test.js`
Expected: PASS

- [ ] **Step 7: Run type/build verification for this tranche**

Run: `npm run typecheck && npm run build`
Expected: exit 0

## Task 12: Complete lower-priority architecture cleanup

**Files:**
- Modify: `electron/ipcHandlers.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `electron/tsconfig.json`

- [ ] **Step 1: Write failing tests/checks where stricter TS or behavior changes are expected**

- [ ] **Step 2: Run the checks and capture the current failure/gap**

Run: `npm run typecheck && npm run build`
Expected: identify the current strictness/postinstall/ownership gaps.

- [ ] **Step 3: Extract at least one remaining cohesive handler group from `electron/ipcHandlers.ts`**

- [ ] **Step 4: Clean up `src/App.tsx` ownership boundaries and evaluate `postinstall` work in `package.json`**

- [ ] **Step 5: Enable stricter Electron TypeScript flags that the repo can pass**

- [ ] **Step 6: Run full project verification**

Run: `npm run typecheck && npm run build && npm run test:electron && npm run test:renderer`
Expected: PASS

## Review Loop Per Task

For every task above:

- implementation subagent completes the task and reports exact files changed and tests run
- spec-review subagent checks against `docs/superpowers/specs/2026-03-20-todo-remaining-work-design.md`
- code-quality review subagent checks cleanliness, safety, and regression risk
- if either reviewer finds issues, send the same implementer back with the review findings, then re-run that review

## Final Verification

Before claiming the full TODO is complete, run the freshest full verification stack that the final diff requires:

```bash
npm run typecheck
npm run build
npm run test:electron
npm run test:renderer
```

If runtime/package-sensitive changes landed in the final diff, also run:

```bash
npm run app:build
```

## Execution Handoff

Use option 1 from the writing-plans workflow:

- **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, keep hot-file edits serialized, run spec review then code-quality review before moving on.
