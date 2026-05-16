# Conscious Mode Hardening Review (Current Code)

This document replaces the previous draft with findings validated against the current branch.
It keeps only code-accurate claims and turns them into an actionable hardening plan.

## Scope

- Reviewed current implementation across routing, retrieval, verifier/provenance, prompt assembly, live indexing, renderer integration, and latency tracking.
- Cross-checked behavior with tests where available.
- Focused on what is true **now**, not historical behavior.

## Validated Findings

### F1. Behavioral prompts are hard-blocked before conscious routing

- Severity: `high`
- Status: `validated`
- Evidence:
  - `electron/ConsciousMode.ts:256` returns `{ qualifies: false, threadAction: 'ignore' }` for behavioral prompts.
  - `electron/conscious/ConsciousAnswerPlanner.ts:45` supports `questionMode: 'behavioral'` with dedicated delivery format/style.
  - `electron/tests/consciousModeRouting.test.ts:191` expects behavioral prompts to be ignored.
- Why this matters:
  - The planner has behavioral logic, but routing never sends behavioral questions down that path.
  - This is either a product policy mismatch or dead capability.

### F2. A global 3s cooldown can drop valid triggers

- Severity: `high`
- Status: `validated`
- Evidence:
  - `electron/IntelligenceEngine.ts:102` sets `triggerCooldown = 3000`.
  - `electron/IntelligenceEngine.ts:524` rejects with `return null` when cooldown is active and mode is not `what_to_say`.
- Why this matters:
  - It is a coarse global gate, not keyed by question/thread/meeting turn.
  - Rapid interviewer follow-ups can be missed.

### F3. Prompt trimming is tail-preserving and can cut instruction/evidence head

- Severity: `high`
- Status: `validated`
- Evidence:
  - `electron/LLMHelper.ts:790` `joinPrompt(...)` calls `trimTextToTokenBudget(..., true)`.
  - `electron/LLMHelper.ts:771` tail-preserving trim returns `...[truncated]\n` + tail.
  - `electron/conscious/ConsciousContextComposer.ts:51` prepends evidence block before transcript.
- Why this matters:
  - When prompts overflow, system/schema/evidence near the top can be truncated first.

### F4. Parallel context assembly drops assistant turns in accelerated path

- Severity: `medium-high`
- Status: `validated`
- Evidence:
  - `electron/cache/ParallelContextAssembler.ts:165` and `electron/cache/ParallelContextAssembler.ts:261` filter out `speaker === 'assistant'`.
  - `electron/IntelligenceEngine.ts:247` uses this assembler in accelerated context flow.
- Why this matters:
  - Follow-up continuity can degrade where previous assistant guidance is relevant.
  - This impact is strongest when acceleration/parallel context path is active.

### F5. Structured conscious response is buffered then parsed once (no progressive structured emit)

- Severity: `medium-high`
- Status: `validated`
- Evidence:
  - `electron/llm/WhatToAnswerLLM.ts:121` accumulates full stream into `full`.
  - `electron/llm/WhatToAnswerLLM.ts:151` parses only after stream end.
  - `electron/conscious/ConsciousResponseCoordinator.ts:34` emits a single full token chunk for structured result.
- Why this matters:
  - Structured mode behaves all-or-nothing at output boundary.

### F6. Provenance verification is lexical and limited by static term set

- Severity: `medium`
- Status: `validated`
- Evidence:
  - `electron/conscious/ConsciousProvenanceVerifier.ts:9` hardcoded `KNOWN_TECH_TERMS`.
  - `electron/conscious/ConsciousProvenanceVerifier.ts:108` numeric checks use token presence in grounding context.
  - `electron/tests/consciousProvenanceVerifier.test.ts` validates lexical grounding behavior.
- Why this matters:
  - High precision for listed terms, but weaker coverage for unlisted technologies/variants.

### F7. Live indexing cadence is slow for truly live retrieval

- Severity: `medium`
- Status: `validated`
- Evidence:
  - `electron/rag/LiveRAGIndexer.ts:16` 30s interval.
  - `electron/rag/LiveRAGIndexer.ts:17` minimum 3 new segments.
  - `electron/rag/LiveRAGIndexer.ts:141` sequential embedding + per-chunk delay.
- Why this matters:
  - Newly spoken content may not be indexed quickly enough for immediate answer windows.

### F8. Transcript preprocessing/chunking can separate paired conversational context

- Severity: `medium`
- Status: `validated`
- Evidence:
  - `electron/rag/TranscriptPreprocessor.ts:179` drops cleaned segments with fewer than 3 words.
  - `electron/rag/SemanticChunker.ts:117` splits on speaker change.
  - `electron/rag/SemanticChunker.ts:129` overlap is only carried for same-speaker continuation.
- Why this matters:
  - Retrieval can lose short acknowledgments and cross-speaker adjacency.

### F9. Answer latency tracking is good for timing, thin for quality forensics

- Severity: `medium-high`
- Status: `validated`
- Evidence:
  - `electron/latency/AnswerLatencyTracker.ts:15` metadata contains route/fallback/profiling signals.
  - No native fields for evidence IDs, ranking decisions, schema version, verifier detail payload, or selected-vs-rejected context.
- Why this matters:
  - Hard to diagnose answer quality regressions from telemetry alone.

### F10. Renderer thread state is inferred, not synchronized from backend source of truth

- Severity: `medium`
- Status: `validated`
- Evidence:
  - `src/components/NativelyInterface.tsx:642` derives thread behavior from rendered answer classification.
  - Backend thread state is authoritative in `electron/SessionTracker.ts:1246`.
- Why this matters:
  - UI thread indicators can drift from backend thread transitions.

## Partially Valid / Corrected Findings

### P1. Embedding dimension mismatch is not universally silent-zero anymore

- Severity: `medium`
- Status: `partial`
- Evidence:
  - `electron/SessionTracker.ts:931` reuses embedding only if dimensions match, otherwise re-embeds shortlist entries.
  - `electron/conscious/AdaptiveContextWindow.ts:139` still returns zero similarity on mismatch.
- Correction:
  - Mismatch handling has improved in ranked conscious context path.
  - It is still fragile in adaptive selection path and mixed embedding sources.

### P2. Judge timeout behavior depends on `requireJudge`

- Severity: `medium`
- Status: `partial`
- Evidence:
  - `electron/conscious/ConsciousVerifierLLM.ts:76` returns `null` on timeout.
  - `electron/conscious/ConsciousVerifier.ts:71` returns failure when `requireJudge` is true.
  - `electron/IntelligenceEngine.ts:313` builds verifier with `requireJudge` from capability probe.
- Correction:
  - Current production wiring tends to fail closed when judge is required.
  - Fail-open only applies in flows using `requireJudge: false`.

### P3. Prompt/schema drift exists, but mainly as latent risk across prompt families and compiler modes

- Severity: `medium`
- Status: `partial`
- Evidence:
  - Active structured path contract: `electron/llm/prompts.ts:1146` (`CONSCIOUS_REASONING_SYSTEM_PROMPT`).
  - Alternate conscious contract in compiler path: `electron/llm/PromptCompiler.ts:106` (`reasoning/answer/confidence` schema).
  - Additional prompt families include `openingReasoning/spokenResponse` contracts in `electron/llm/prompts.ts:672`.
- Correction:
  - Runtime structured conscious path currently uses the dedicated JSON contract and backend formatting.
  - Drift risk is real if alternate compiler/fallback paths become primary without schema normalization.

### P4. "Live RAG not used by conscious mode" was overstated

- Severity: `medium`
- Status: `partial`
- Evidence:
  - Conscious preparation includes a live block via `electron/conscious/ConsciousPreparationCoordinator.ts:131` and `electron/conscious/ConsciousRetrievalOrchestrator.ts:157`.
  - That block is built from current context items, not direct vector retrieval from `VectorStore`.
- Correction:
  - Conscious mode does use a live retrieval block.
  - It does not directly query indexed vector chunks in that path.

## Stale / Incorrect Claims Removed

- `ConsciousProvenanceVerifier` does **not** use hypothesis text as grounding.
  - Verified by implementation and test: `electron/tests/consciousProvenanceVerifier.test.ts:98`.
- Compaction constants in prior draft were outdated.
  - Current values/flow: `electron/SessionTracker.ts:193` threshold, `electron/SessionTracker.ts:2088` compaction path, summarize 500 oldest entries.
- `spokenResponse` mismatch claim for active structured route was inaccurate.
  - Active structured response type is defined in `electron/ConsciousMode.ts:3` and consumed through formatted output path.

## Prioritized Hardening Plan

### Priority 0 (Immediate: 1 sprint)

1. Behavioral routing decision and alignment
   - Decide policy: support behavioral in conscious mode or intentionally keep blocked.
   - If support: update `electron/ConsciousMode.ts` block and tests in `electron/tests/consciousModeRouting.test.ts`.
   - If keep blocked: remove behavioral planner branch or mark it intentionally unreachable.

2. Replace global cooldown drop behavior
   - Move from fixed global reject (`return null`) to per-question/thread debounce or queueing.
   - Emit explicit event/reason when suppression happens.

3. Protect prompt head content during trimming
   - Reserve token budget for system/schema/evidence head.
   - Trim transcript/context body first.

4. Add quality-grade metadata to emitted answer events
   - Include route, fallback reason, schema version, verifier outcome summary, and context-selection hash.

### Priority 1 (Near-term: 1-2 sprints)

1. Assistant-history policy for accelerated retrieval
   - Keep filter optional/configurable instead of unconditional.
   - Add tests for continuity-sensitive follow-ups.

2. Unify embedding metadata and mismatch handling
   - Track embedding model/dimension at entry level.
   - Harmonize `AdaptiveContextWindow` behavior with shortlist re-embed strategy.

3. Strengthen provenance checks
   - Expand technology detection beyond static list (or derive vocabulary from profile/JD/evidence context).
   - Keep strict no-hypothesis-grounding rule.

4. Improve live retrieval freshness policy
   - Trigger indexing on interviewer-finalized turns and long pauses.
   - Reduce sequential bottlenecks where safe.

### Priority 2 (Structural: 2-4 sprints)

1. Schema governance
   - Single canonical conscious schema + versioning across prompts/compiler/parser.
   - Explicit adapter layer for any alternate prompt family.

2. Structured staged output
   - Emit minimal "say this" content early, then enrich sections progressively.

3. Backend-driven thread state for renderer
   - Emit authoritative thread snapshots/events; renderer should render, not infer thread transitions.

4. Quality replay harness
   - Build deterministic replay set for routing, context assembly, verifier outcomes, and fallback behavior.

## Test Updates Required

- Routing tests
  - Update/add cases based on chosen behavioral policy.
- Cooldown tests
  - Verify no silent drops for rapid follow-ups.
- Prompt budget tests
  - Assert system/schema/evidence preservation under overflow.
- Retrieval tests
  - Validate assistant-history inclusion behavior under acceleration.
- Verifier/provenance tests
  - Keep tests proving hypothesis is never accepted as grounding.
- Telemetry tests
  - Assert required metadata exists in answer events/snapshots.

## Definition of Done for Hardening Work

- Every change has a route-level regression test and at least one adversarial case.
- No silent fallback/drop path remains without explicit reason emission.
- Prompt schema/version is unambiguous at generation + parse boundaries.
- On-call diagnostics can reconstruct: question -> selected context -> verifier verdict -> fallback reason.
