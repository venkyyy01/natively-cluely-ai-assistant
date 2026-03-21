# Conscious Mode Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Conscious Mode reliable in live system-design interview practice by preserving thread context through tangents, enforcing realtime-safe fallback, and preventing silent suggestion failures.

**Architecture:** Extend the current single-thread Conscious Mode flow into a small realtime state machine shared by transcript-triggered and manual invocations. Add explicit thread lifecycle, in-flight arbitration, and guarded fallback behavior in `SessionTracker`, `ConsciousMode`, and `IntelligenceEngine`, then lock it down with transcript-driven tests.

**Tech Stack:** Electron main process TypeScript, Node test runner, existing LLM orchestration classes, renderer assist formatting

---

## File Map

- Create: `electron/consciousModeConfig.ts`
  - centralized realtime defaults for debounce, timeout, resume TTL, and failure thresholds
- Modify: `electron/ConsciousMode.ts`
  - add richer routing decisions, confidence results, suspend/resume helpers, transcript semantics helpers, and arbitration primitives
- Modify: `electron/SessionTracker.ts`
  - store active/suspended thread state, failure streaks, cycle arbitration state, dedupe metadata, and safe write rules
- Modify: `electron/IntelligenceEngine.ts`
  - enforce realtime decision flow, bounded Conscious attempt, same-cycle fallback, and no-stale-write arbitration
- Modify: `electron/main.ts`
  - keep manual and IPC suggestion triggers aligned with the engine's cycle arbitration entry points
- Modify: `electron/llm/WhatToAnswerLLM.ts`
  - support narrowed Conscious context packet generation for resumed or ambiguity-safe fallback cycles
- Modify: `electron/llm/FollowUpLLM.ts`
  - support resumed-thread follow-up prompts using structured thread summary
- Modify: `src/components/NativelyInterface.tsx`
  - own renderer-side typed/manual submission behavior so manual prompts enter the safe live arbitration path
- Modify: `src/types/electron.d.ts`
  - update any preload/electron typing if manual override behavior or diagnostics change
- Test: `electron/tests/consciousModeRouting.test.ts`
  - extend classifier coverage, transcript-trigger semantics, ambiguity handling, stale-thread rejection, and malformed fallback behavior
- Test: `electron/tests/consciousModeOffRegression.test.ts`
  - confirm normal mode behavior still works unchanged when Conscious Mode is off
- Test: `electron/tests/consciousModeFollowupThread.test.ts`
  - add suspend/resume/expiry behavior and multi-tangent coverage
- Create: `electron/tests/consciousModeRealtimeFallback.test.ts`
  - end-to-end tests for bounded fallback, failure streak degradation, and thread-memory non-mutation on failed cycles
- Create: `electron/tests/consciousModeTranscriptSemantics.test.ts`
  - transcript revision, duplicate finals, partial promotion, and out-of-order event handling
- Create: `electron/tests/consciousModeManualOverride.test.ts`
  - typed/manual branch arbitration, typed input during fallback, and write-safety coverage
- Create: `electron/tests/consciousModeRenderFailurePolicy.test.ts`
  - render failure, persistence failure, and duplicate-visible-output suppression
- Create: `electron/tests/fixtures/consciousModeTranscripts.ts`
  - shared transcript fixtures for tangents, interruptions, STT fragmentation, overlap, late return, and degraded-provider scenarios

### Task 1: Expand Conscious Mode domain model

**Files:**
- Modify: `electron/ConsciousMode.ts`
- Test: `electron/tests/consciousModeRouting.test.ts`

- [ ] **Step 1: Write the failing classifier tests**

Add tests for:
- temporary tangent vs hard reset
- suspended-thread resume vs fresh start
- ambiguous overlap choosing safe fresh behavior
- explicit resume phrases and topic-shift phrases

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeRouting.test.ts`
Expected: FAIL on missing routing states and ambiguity behavior.

- [ ] **Step 3: Write minimal domain changes**

Implement in `electron/ConsciousMode.ts`:
- richer thread/action types for `start`, `continue`, `suspend`, `resume`, `reset`, `ignore`
- confidence-scored route result
- helpers for continuation, topic shift, resume phrases, tangent detection, and safe ambiguity handling

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeRouting.test.ts`
Expected: PASS for the new routing cases.

- [ ] **Step 5: Commit**

```bash
git add electron/ConsciousMode.ts electron/tests/consciousModeRouting.test.ts
git commit -m "feat: expand conscious mode routing states"
```

### Task 2: Centralize realtime defaults and intake semantics

**Files:**
- Create: `electron/consciousModeConfig.ts`
- Modify: `electron/SessionTracker.ts`
- Create: `electron/tests/consciousModeTranscriptSemantics.test.ts`
- Create: `electron/tests/fixtures/consciousModeTranscripts.ts`

- [ ] **Step 1: Write the failing intake/config tests**

Cover:
- centralized defaults for debounce, timeout, resume TTL, and failure threshold
- partial buffering in intake state
- partial promotion after the configured debounce window
- duplicate final transcript suppression
- revised partial replacement
- empty/low-confidence turn rejection
- out-of-order late events not corrupting active thread state
- overlapping speaker-attribution failure closes safely without thread mutation

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeTranscriptSemantics.test.ts`
Expected: FAIL because centralized defaults and transcript semantics are missing.

- [ ] **Step 3: Write minimal intake/config implementation**

Implement:
- `electron/consciousModeConfig.ts` as the single runtime defaults source
- `SessionTracker.handleTranscript` as the authoritative intake and buffering owner for partial buffering, promotion bookkeeping, and duplicate suppression
- dedupe/revision bookkeeping needed by downstream arbitration
- shared transcript fixtures for realistic test coverage

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeTranscriptSemantics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/consciousModeConfig.ts electron/SessionTracker.ts electron/tests/consciousModeTranscriptSemantics.test.ts electron/tests/fixtures/consciousModeTranscripts.ts
git commit -m "feat: centralize conscious mode realtime defaults"
```

### Task 3: Add realtime thread lifecycle state

**Files:**
- Modify: `electron/SessionTracker.ts`
- Modify: `electron/tests/consciousModeTranscriptSemantics.test.ts`

- [ ] **Step 1: Write the failing thread-lifecycle tests**

Cover:
- active vs suspended thread lifecycle
- resume TTL expiry
- failure streak increment/reset
- cycle ownership metadata for safe supersession

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeTranscriptSemantics.test.ts`
Expected: FAIL because richer thread state does not exist yet.

- [ ] **Step 3: Write minimal thread-state implementation**

Implement in `electron/SessionTracker.ts`:
- suspended thread storage and lifecycle helpers
- explicit safe write methods for successful Conscious cycles only
- failure streak tracking with reset-after-success behavior
- cycle ownership metadata for in-flight arbitration

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeTranscriptSemantics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/SessionTracker.ts electron/tests/consciousModeTranscriptSemantics.test.ts
git commit -m "feat: add conscious mode realtime session state"
```

### Task 4: Add manual typed-override arbitration

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/main.ts`
- Modify: `src/components/NativelyInterface.tsx`
- Modify: `src/types/electron.d.ts`
- Create: `electron/tests/consciousModeManualOverride.test.ts`

- [ ] **Step 1: Write the failing manual-override tests**

Cover:
- typed/manual input forks a manual branch safely
- typed/manual input during live fallback does not corrupt live thread memory
- typed/manual input can attach to the active thread only when clearly related
- newer authoritative live cycle supersedes stale manual/live completions appropriately

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeManualOverride.test.ts`
Expected: FAIL because manual override arbitration is not implemented.

- [ ] **Step 3: Write minimal manual-arbitration implementation**

Implement only the changes required so typed/manual prompts cooperate with the live Conscious pipeline and safe write rules. Do not change preload/types unless tests prove a runtime contract mismatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeManualOverride.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/IntelligenceEngine.ts electron/main.ts src/components/NativelyInterface.tsx src/types/electron.d.ts electron/tests/consciousModeManualOverride.test.ts
git commit -m "feat: arbitrate conscious mode manual overrides"
```

### Task 5: Enforce same-cycle fallback in the engine

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/consciousModeRouting.test.ts`
- Create: `electron/tests/consciousModeRealtimeFallback.test.ts`

- [ ] **Step 1: Write the failing engine tests**

Add tests for:
- malformed Conscious output falls back without mutating thread memory
- timeout/late Conscious result cannot overwrite fallback render
- fallback uses current turn and optional valid active summary only
- provider unavailable or rate-limited paths fall back without dead air
- structurally valid but irrelevant Conscious output is rejected and falls back normally
- repeated Conscious failures degrade to normal mode for the session

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeRouting.test.ts electron/tests/consciousModeRealtimeFallback.test.ts`
Expected: FAIL because arbitration and failure streak logic are missing.

- [ ] **Step 3: Write minimal engine implementation**

Implement in `electron/IntelligenceEngine.ts`:
- bounded Conscious attempt helper
- explicit cycle id / supersession checks
- same-cycle fallback path with no double-render
- no-memory-write on failed or superseded Conscious cycles

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeRouting.test.ts electron/tests/consciousModeRealtimeFallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/IntelligenceEngine.ts electron/tests/consciousModeRouting.test.ts electron/tests/consciousModeRealtimeFallback.test.ts
git commit -m "fix: add robust conscious mode fallback"
```

### Task 6: Add render/persist fail-closed policy and degradation recovery

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Modify: `electron/SessionTracker.ts`
- Modify: `electron/tests/consciousModeRealtimeFallback.test.ts`
- Create: `electron/tests/consciousModeRenderFailurePolicy.test.ts`
- Modify: `electron/tests/consciousModeOffRegression.test.ts`

Telemetry and diagnostic writes should live in `electron/SessionTracker.ts` unless implementation exposes a clearly better existing runtime state surface.

- [ ] **Step 1: Write the failing failure-policy tests**

Cover:
- render failure -> fallback if still possible -> no thread-memory write
- render success + persistence failure -> visible answer kept, no thread-memory write
- duplicate visible output suppression for one cycle
- failure streak degrade and reset after one validated Conscious success
- telemetry and diagnostic state records fallback, degrade, resume, and reset events

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeRealtimeFallback.test.ts electron/tests/consciousModeRenderFailurePolicy.test.ts electron/tests/consciousModeOffRegression.test.ts`
Expected: FAIL until failure policy is fully enforced.

- [ ] **Step 3: Write minimal failure-policy implementation**

Implement only the behavior needed for fail-closed rendering/persistence handling and degradation recovery.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeRealtimeFallback.test.ts electron/tests/consciousModeRenderFailurePolicy.test.ts electron/tests/consciousModeOffRegression.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/IntelligenceEngine.ts electron/SessionTracker.ts electron/tests/consciousModeRealtimeFallback.test.ts electron/tests/consciousModeRenderFailurePolicy.test.ts electron/tests/consciousModeOffRegression.test.ts
git commit -m "fix: harden conscious mode failure policy"
```

### Task 7: Preserve follow-up reasoning across tangents and returns

**Files:**
- Modify: `electron/llm/FollowUpLLM.ts`
- Modify: `electron/llm/WhatToAnswerLLM.ts`
- Test: `electron/tests/consciousModeFollowupThread.test.ts`

- [ ] **Step 1: Write the failing follow-up thread tests**

Add tests for:
- suspended thread resume after tangent
- expiry leading to fresh answer
- ambiguous resume preferring safe fresh output
- follow-up prompts preserving reasoning-first behavior after resume

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/consciousModeFollowupThread.test.ts`
Expected: FAIL for suspend/resume/expiry cases.

- [ ] **Step 3: Write minimal prompt plumbing**

Update the LLM helpers so resumed threads can use a compact summary packet instead of raw transcript-only context, without changing normal mode behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/tests/consciousModeFollowupThread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/llm/FollowUpLLM.ts electron/llm/WhatToAnswerLLM.ts electron/tests/consciousModeFollowupThread.test.ts
git commit -m "feat: preserve conscious mode followup threads"
```

### Task 8: Full verification and packaging

**Files:**
- Modify: implementation files from previous tasks only if verification exposes defects

- [ ] **Step 1: Run focused Conscious Mode test suite**

Run:
```bash
node --test electron/tests/consciousModeRouting.test.ts electron/tests/consciousModeFollowupThread.test.ts electron/tests/consciousModeRealtimeFallback.test.ts electron/tests/consciousModeTranscriptSemantics.test.ts electron/tests/consciousModeManualOverride.test.ts electron/tests/consciousModeRenderFailurePolicy.test.ts electron/tests/consciousModeOffRegression.test.ts
```

Expected: all Conscious Mode tests PASS.

- [ ] **Step 2: Assert realtime fallback budget and single-visible-answer behavior**

Run:
```bash
node --test electron/tests/consciousModeRealtimeFallback.test.ts electron/tests/consciousModeRenderFailurePolicy.test.ts
```

Expected: PASS with explicit assertions that fallback stays within the configured budget and each cycle produces exactly one visible answer.

- [ ] **Step 3: Run broader repo verification required by changed runtime code**

Run:
```bash
bash .agents/skills/code-change-verification/scripts/run.sh
```

Expected: install/build/build-check/dist-check/lint/test all PASS.

- [ ] **Step 4: Build a fresh app bundle**

Run:
```bash
npm run app:build
```

Expected: fresh mac app artifacts generated successfully.

- [ ] **Step 5: Install fresh local app copy**

Run:
```bash
rm -rf "$HOME/Applications/Natively.app"
ditto "release/mac-arm64/Natively.app" "$HOME/Applications/Natively.app"
xattr -d com.apple.quarantine "$HOME/Applications/Natively.app" 2>/dev/null || true
open "$HOME/Applications/Natively.app"
```

Expected: local app launches.

- [ ] **Step 6: Commit final verification fixes**

```bash
git add electron docs/superpowers/specs/2026-03-21-conscious-mode-realtime-design.md docs/superpowers/plans/2026-03-21-conscious-mode-realtime-implementation.md
git commit -m "feat: harden conscious mode realtime flow"
```
