# Profile, Conscious Mode, and Overlay Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore profile-grounded interview answers with graceful fallback, improve Conscious Mode for system design follow-ups, and make the overlay resizable plus clickthrough-capable.

**Architecture:** Keep the existing route-selection and window-helper architecture, but tighten the decision boundaries. Add focused regression tests around answer routing and window behavior, then minimally extend the answer path so profile-first and conscious-system-design requests use the right pipeline while ordinary questions still stay fast.

**Tech Stack:** TypeScript, Node `node:test`, Electron BrowserWindow IPC, React preload bridge

---

### Task 1: Fix profile-first routing with graceful fallback

**Files:**
- Modify: `electron/latency/answerRouteSelector.ts`
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/answerRouteSelector.test.ts`
- Test: `electron/tests/profileModeRouting.test.ts`

- [ ] **Step 1: Write the failing tests**

Add route-selection coverage for: (1) `tell me about yourself` -> `enriched_standard_answer`; (2) `walk me through your resume` -> `enriched_standard_answer`; (3) `tell me about a project you worked on with React` -> `enriched_standard_answer` when profile mode is active; and (4) `how would you design a rate limiter?` stays `fast_standard_answer` even with profile mode on. Add an engine-level test that proves profile-mode interception falls back to normal output when knowledge enrichment throws or returns no usable result.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerRouteSelector.test.js dist-electron/electron/tests/profileModeRouting.test.js`
Expected: FAIL because current routing is too narrow and fallback behavior is not asserted.

- [ ] **Step 3: Write minimal implementation**

Expand deterministic profile-required heuristics, route profile-first questions to `enriched_standard_answer`, and ensure the engine still returns normal output if knowledge/profile enrichment does not produce usable context.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerRouteSelector.test.js dist-electron/electron/tests/profileModeRouting.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 1 files and create a focused commit.

### Task 2: Improve Conscious Mode for system design structure and thread continuity

**Files:**
- Modify: `electron/ConsciousMode.ts`
- Modify: `electron/llm/WhatToAnswerLLM.ts`
- Modify: `electron/llm/prompts.ts`
- Test: `electron/tests/consciousModeRouting.test.ts`
- Test: `electron/tests/consciousModeFollowupThread.test.ts`
- Test: `electron/tests/consciousPrompts.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests for: (1) system-design continuation phrases like `what are the tradeoffs`, `how would you shard this`, and `what happens during failover` continuing an active thread; (2) a new technical design question resetting the old thread but staying in Conscious Mode; (3) a non-design topic shift not reusing the prior thread; and (4) prompt-contract assertions that the response order explicitly prioritizes requirements, architecture, tradeoffs, bottlenecks, and scale/reliability before code.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js`
Expected: FAIL because current continuation heuristics and system-design prompt contract are insufficient.

- [ ] **Step 3: Write minimal implementation**

Broaden system-design continuation detection, preserve thread continuity for design pushback/scale/failure-mode questions, and specialize the reasoning-first prompt so answers follow requirements → architecture → tradeoffs → scale/reliability before code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 2 files and create a focused commit.

### Task 3: Make overlay resizing and clickthrough controllable

**Files:**
- Modify: `electron/WindowHelper.ts`
- Modify: `electron/ipc/registerWindowHandlers.ts`
- Modify: `electron/ipcValidation.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Modify: `src/components/SettingsOverlay.tsx`
- Modify: `src/components/settings/GeneralSettingsSection.tsx`
- Test: `electron/tests/ipcContracts.test.ts`
- Test: `electron/tests/ipcValidation.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend window IPC contract tests to cover: (1) overlay resize requests still route to `setOverlayDimensions`; (2) a new clickthrough toggle contract forwards `enabled=true/false` to the overlay window helper; and (3) IPC validation rejects malformed clickthrough payloads. Add renderer-facing assertions where practical for the new settings toggle contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcContracts.test.js dist-electron/electron/tests/ipcValidation.test.js`
Expected: FAIL because no clickthrough IPC exists and overlay behavior is fixed-only.

- [ ] **Step 3: Write minimal implementation**

Allow overlay resizing in `WindowHelper`, add an IPC/preload API for clickthrough mode, and use Electron mouse-ignore behavior in the overlay window while preserving normal interaction when clickthrough is disabled.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/ipcContracts.test.js dist-electron/electron/tests/ipcValidation.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint the task**

Stage only the Task 3 files and create a focused commit.

### Task 4: Run verification stack

**Files:**
- Verify: `electron/tests/answerRouteSelector.test.ts`
- Verify: `electron/tests/profileModeRouting.test.ts`
- Verify: `electron/tests/consciousModeRouting.test.ts`
- Verify: `electron/tests/consciousModeFollowupThread.test.ts`
- Verify: `electron/tests/consciousPrompts.test.ts`
- Verify: `electron/tests/ipcContracts.test.ts`
- Verify: `electron/tests/ipcValidation.test.ts`

- [ ] **Step 1: Run typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run targeted Electron tests**

Run: `npx tsc -p electron/tsconfig.json && node --test dist-electron/electron/tests/answerRouteSelector.test.js dist-electron/electron/tests/profileModeRouting.test.js dist-electron/electron/tests/consciousModeRouting.test.js dist-electron/electron/tests/consciousModeFollowupThread.test.js dist-electron/electron/tests/consciousPrompts.test.js dist-electron/electron/tests/ipcContracts.test.js dist-electron/electron/tests/ipcValidation.test.js`
Expected: PASS.

- [ ] **Step 3: Run Electron coverage gate**

Run: `npm run verify:electron:coverage`
Expected: PASS.

- [ ] **Step 4: Run app-level overlay smoke test**

Run the app, switch to overlay mode, verify overlay resize still works, enable clickthrough and confirm underlying apps receive clicks, then disable clickthrough and confirm overlay interaction returns.
