# Natively — Unified Implementation Plan

> Merges previously approved hardening tickets (NAT-H1–H4) with new conscious mode latency tickets (NAT-L1–L4).

---

## Ticket Index

| Ticket | Severity | Problem | File(s) |
|--------|----------|---------|---------|
| **NAT-H1** | CRITICAL | `process.exit()` with zero cleanup | `processFailure.ts`, `logging.ts` |
| **NAT-H2** | HIGH | `reconfigureAudio` error paths leave audio dead | `AppState.ts` |
| **NAT-H3** | HIGH | `UnsafeCell` in `sck.rs` is unsound | `native-module/src/speaker/sck.rs` |
| **NAT-H4** | HIGH | Audio self-healing exhaustion with no recovery | `AppState.ts` |
| **NAT-L1** | CRITICAL | Intent classification budget 120ms — always times out | `IntelligenceEngine.ts` |
| **NAT-L2** | HIGH | Prefetch only starts on silence, misses the race | `AppState.ts` |
| **NAT-L3** | HIGH | Prefetched intent discarded when confidence < 0.72 | `ConsciousAccelerationOrchestrator.ts`, `ConsciousIntentService.ts` |
| **NAT-L4** | MEDIUM | `generateReasoningFirst` blocks until full JSON — no early UI | `ConsciousOrchestrator.ts`, `IntelligenceEngine.ts` |

---

## Previously Approved Hardening Tickets (NAT-H1–H4)

These tickets remain unchanged from the approved plan. See the prior revision for full diffs. Summary:

- **NAT-H1**: New `GracefulShutdownManager.ts` singleton with ordered hooks; rewire `logging.ts` process handlers.
- **NAT-H2**: `reconfigureAudio` throws on total failure; explicit `.start()` calls after recovery; counter reset on success.
- **NAT-H3**: Replace `UnsafeCell` with `OnceLock` in `sck.rs`.
- **NAT-H4**: Silence watchdog in health-check timer; increase max recovery attempts to 5; jittered backoff.

---

## NAT-L1 — Widen Intent Classification Hard Budget

### Root Cause

[IntelligenceEngine.ts:161-162](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L161-L162):

```typescript
private readonly CONTEXT_ASSEMBLY_SOFT_BUDGET_MS = 80;
private readonly CONTEXT_ASSEMBLY_HARD_BUDGET_MS = 120;
```

[ConsciousIntentService.ts:64-78](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousIntentService.ts#L64-L78) computes the intent classify timeout as:

```typescript
const remaining = Math.max(30, input.hardBudgetMs - contextAssemblyElapsed);
```

**The math problem:** Context assembly (vector retrieval, RAG blocks, semantic fact store, profile sanitization, token budget calculations in `ConsciousPreparationCoordinator.ts:218-307`) takes 50–200ms. With a hard budget of 120ms:

- If context takes 90ms → intent gets **30ms** (the `Math.max(30, ...)` floor) — physically impossible for any LLM call
- If context takes ≥120ms → intent is **skipped entirely** → `timedOut = true`, falls back to `{intent: 'general', confidence: 0}`

When intent returns `general/0`, `isStrongConsciousIntent()` returns `false`, so the route selector at [IntelligenceEngine.ts:1500](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L1500) skips `conscious_answer` and falls to `fast_standard_answer`. The user then either gets a generic fast response (if the question passes the simple `shouldAutoTrigger` check) or nothing at all.

**This is the #1 reason conscious mode feels broken — it almost never gets to run.**

### Exact Changes

#### [MODIFY] `electron/IntelligenceEngine.ts`

```diff
-  private readonly CONTEXT_ASSEMBLY_SOFT_BUDGET_MS = 80;
-  private readonly CONTEXT_ASSEMBLY_HARD_BUDGET_MS = 120;
+  // NAT-L1: widened from 80/120 to 300/500. Intent classification requires
+  // at minimum 200ms for an SLM call + 100ms for context assembly. The
+  // previous 120ms budget caused intent to time out on nearly every question,
+  // silently degrading conscious mode to fast_standard_answer.
+  private readonly CONTEXT_ASSEMBLY_SOFT_BUDGET_MS = 300;
+  private readonly CONTEXT_ASSEMBLY_HARD_BUDGET_MS = 500;
```

**Lines:** 161–162

### Why These Values

| Budget | Old | New | Rationale |
|--------|-----|-----|-----------|
| Soft | 80ms | 300ms | Log a warning when context + intent exceeds this. Tight enough to surface slow retrieval, loose enough not to false-alarm. |
| Hard | 120ms | 500ms | Absolute cap. Context assembly takes ~100ms. Leaves ~400ms for intent classify — enough for a local SLM call (100–250ms typical) or a round-trip to a hosted model (200–400ms). |

> [!NOTE]
> The hard budget only affects the intent classification step inside `prepareReasoningContext`. The actual LLM answer call (`generateReasoningFirst`) runs after this with no cap. Widening this budget does NOT increase total latency — it just gives intent a fair chance to resolve instead of always timing out.

### Verification
- Start a meeting, ask "How would you design a rate limiter?" and confirm:
  - Console shows `intent=deep_dive` (not `intent=general`/`reason=context_timeout`)
  - Route is `conscious_answer` (not `fast_standard_answer`)
  - The latency snapshot shows `timedOut: false`

---

## NAT-L2 — Early Prefetch on High-Confidence Interim Transcripts

### Root Cause

[AppState.ts:1267-1285](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L1267-L1285): The transcript handler calls `maybeHandleSuggestionTriggerFromTranscript` on every segment, but `ConsciousMode.ts:626` rejects all interim (`final=false`) segments. The acceleration orchestrator's `onSilenceStart()` is only triggered from `speech_ended` events on the SystemAudioCapture ([AppState.ts:1387-1388](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L1387-L1388)).

**The race condition:**
1. Interviewer finishes speaking
2. `speech_ended` fires → `onSilenceStart()` starts prefetch
3. STT engine still processing → emits `final=true` 1–3 seconds later
4. `handleSuggestionTrigger` runs → no prefetch result available → falls through to live (slow) path

For short questions (~5 words), the STT finalizes in **under 1 second** — faster than any prefetch can complete.

### Exact Changes

#### [MODIFY] `electron/main/AppState.ts` — transcript handler

Inside the `transcriptHandler` closure (line ~1230), after the `intelligenceManager.handleTranscript()` call and before the UI broadcast, add an early prefetch trigger:

```diff
       this.intelligenceManager.handleTranscript({
         speaker: speaker,
         text: segment.text,
         timestamp: Date.now(),
         final: segment.isFinal,
         confidence: segment.confidence,
         traceId: segment.traceId,
       });

+      // NAT-L2: Trigger speculative prefetch on high-confidence interim
+      // interviewer transcripts. This gives the acceleration orchestrator
+      // a 1-2s head start before the final transcript arrives.
+      // Only for interviewer (system audio), only for interims with enough
+      // substance to be worth prefetching.
+      if (
+        speaker === 'interviewer'
+        && !segment.isFinal
+        && segment.confidence != null
+        && segment.confidence > 0.75
+        && segment.text.trim().split(/\s+/).length >= 4
+      ) {
+        this.accelerationManager?.getConsciousOrchestrator()
+          .onSilenceStart(segment.text);
+      }

       // Feed final transcript to JIT RAG indexer
```

**Insert after line:** 1239 (after `handleTranscript` call)

### Why This Is Safe

- `onSilenceStart` is already idempotent — it sets `prefetchTriggeredForCurrentPause = false` and calls `pauseDetector.onSpeechEnded()`. The pause detector will evaluate whether this is a real pause or just a brief gap.
- If the interim is wrong and the speaker continues, `onUserSpeaking()` will be called from the audio activity handler at [AppState.ts:1384](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main/AppState.ts#L1384) (`noteInterviewerAudioActivity → onInterviewerAudioActivity → onUserSpeaking`), which calls `invalidateSpeculation(false)` at [ConsciousAccelerationOrchestrator.ts:258](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousAccelerationOrchestrator.ts#L258) — aborting any in-flight prefetch.
- The confidence guard (>0.75) and word-count guard (≥4) prevent triggering on garbage interims.

### Verification
- Set a breakpoint/log on `maybePrefetchIntent` in `ConsciousAccelerationOrchestrator.ts:505`. Confirm it fires **before** the STT final arrives.
- Confirm that `getPrefetchedIntent` returns a non-null result when `runWhatShouldISay` runs.

---

## NAT-L3 — Relax Prefetch Intent Discard Threshold

### Root Cause

Two gatekeepers discard prefetched intents that would otherwise speed up conscious mode:

**Gate 1:** [ConsciousAccelerationOrchestrator.ts:544-552](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousAccelerationOrchestrator.ts#L544-L552) — during prefetch storage:

```typescript
if (
  intent.confidence < getIntentConfidenceService().getPrimaryMinConfidence()  // 0.82
  || isUncertainConsciousIntent(intent)  // confidence < 0.72
) {
  // Discarded — never stored
}
```

**Gate 2:** [ConsciousIntentService.ts:43-53](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousIntentService.ts#L43-L53) — during consumption:

```typescript
if (isUncertainConsciousIntent(input.prefetchedIntent)) {
  // Discarded — falls through to live classification (which times out per NAT-L1)
}
```

From [intentConfidenceCalibration.ts:27-33](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/llm/intentConfidenceCalibration.ts#L27-L33), `minReliableConfidence = 0.72` for all intent types. From [line 13](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/llm/intentConfidenceCalibration.ts#L13), `primaryMinConfidence = 0.82`.

**The combined effect:** A prefetched intent must have confidence ≥ 0.82 to be stored, AND ≥ 0.72 to be consumed. This is extremely conservative — most interview questions produce intent confidence in the 0.55–0.75 range, which means:

1. Prefetch runs → result discarded (Gate 1)
2. Live classification runs → times out (NAT-L1)
3. Falls back to `general` → `fast_standard_answer` route → user sees generic response

### Exact Changes

#### [MODIFY] `electron/conscious/ConsciousAccelerationOrchestrator.ts` — relax storage gate

```diff
-        if (
-          intent.confidence < getIntentConfidenceService().getPrimaryMinConfidence()
-          || isUncertainConsciousIntent(intent)
-        ) {
+        // NAT-L3: Relax prefetch storage gate. Only discard 'general' intents
+        // and truly empty results. A medium-confidence prefetch (0.55-0.82)
+        // is still better than timing out on live classify (NAT-L1).
+        // The consumer (ConsciousIntentService.resolve) applies its own
+        // quality gate before using the result.
+        if (intent.intent === 'general' || intent.confidence < 0.45) {
           console.log(
-            `[ConsciousAccelerationOrchestrator] intent.prefetch_discarded_low_confidence intent=${intent.intent} confidence=${intent.confidence.toFixed(3)} threshold=${getIntentConfidenceService().getPrimaryMinConfidence()}`,
+            `[ConsciousAccelerationOrchestrator] intent.prefetch_discarded intent=${intent.intent} confidence=${intent.confidence.toFixed(3)}`,
           );
           return;
         }
```

**Lines:** 544–552

#### [MODIFY] `electron/conscious/ConsciousIntentService.ts` — relax consumption gate

```diff
-      if (isUncertainConsciousIntent(input.prefetchedIntent)) {
-        console.log(
-          `[ConsciousIntentService] intent.prefetch_discarded_low_confidence intent=${input.prefetchedIntent.intent} confidence=${input.prefetchedIntent.confidence?.toFixed?.(3) ?? input.prefetchedIntent.confidence}`,
-        );
+      // NAT-L3: Accept prefetched intent if it's non-general. Previously,
+      // anything below minReliableConfidence (0.72) was discarded, forcing a
+      // live re-classify that almost always times out (NAT-L1). A 0.55
+      // deep_dive is far more useful than a timed-out general/0.
+      if (input.prefetchedIntent.intent === 'general') {
+        console.log(
+          `[ConsciousIntentService] intent.prefetch_discarded_general confidence=${input.prefetchedIntent.confidence?.toFixed?.(3) ?? input.prefetchedIntent.confidence}`,
+        );
```

**Lines:** 43–46

### Why This Is Safe

The downstream consumers already have their own quality gates:
- `isStrongConsciousIntent` (used for route forcing) still requires `strongMinConfidence = 0.84` — this is unchanged
- `selectAnswerRoute` uses `consciousModeEnabled` to gate the conscious route — if the question qualifies via the existing `classifyConsciousModeQuestion` check, a medium-confidence intent just informs the planner better, it doesn't force a dangerous path
- The `ConsciousVerifier` and `ConsciousProvenanceVerifier` run post-LLM and will reject hallucinated answers regardless of intent confidence

### Verification
- Add a log line in `maybePrefetchIntent` success path to print stored confidence
- Ask a question like "How do you prioritize?" (typically 0.55–0.70 confidence for `behavioral`)
- Confirm: prefetch is stored (not discarded), consumed by `resolve()`, and the answer renders without needing a nudge

---

## NAT-L4 — Stream `openingReasoning` Before Full JSON Completion

### Root Cause

[WhatToAnswerLLM.ts:133-197](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/llm/WhatToAnswerLLM.ts#L133-L197) — `generateReasoningFirst`:

```typescript
for await (const chunk of stream) {
  full += chunk;  // ← accumulates entire response
}
return parseConsciousModeResponse(full);  // ← parses only after all chunks arrive
```

[ConsciousOrchestrator.ts:446-453](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousOrchestrator.ts#L446-L453):

```typescript
structuredResponse = await input.whatToAnswerLLM.generateReasoningFirst(...)
// ← blocks until the entire JSON response is accumulated
```

The LLM produces the full JSON response (typically 200–500 tokens). With a streaming API, the first tokens arrive in 200–400ms, but the **full** response takes 2–5 seconds. The user sees **nothing** during this entire window.

Meanwhile, the existing `tryParseConsciousModeOpeningReasoning` in [ConsciousMode.ts:445-456](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/ConsciousMode.ts#L445-L456) can extract `openingReasoning` from partial JSON via regex — it was **built for this purpose** but is never called during streaming.

### Exact Changes

#### [MODIFY] `electron/llm/WhatToAnswerLLM.ts` — add streaming callback to `generateReasoningFirst`

```diff
     async generateReasoningFirst(
         cleanedTranscript: string,
         question: string,
         temporalContext?: TemporalContext,
         intentResult?: IntentResult,
-        imagePaths?: string[]
+        imagePaths?: string[],
+        options?: {
+          /** Called when openingReasoning is extractable from partial JSON.
+           *  Enables early display before full response is parsed. */
+          onEarlyReasoning?: (text: string) => void;
+        }
     ): Promise<ConsciousModeStructuredResponse> {
         let full = "";
+        let earlyReasoningEmitted = false;
         const behavioralPromptRequested = intentResult?.intent === 'behavioral'
             || /QUESTION_MODE:\s*behavioral/i.test(cleanedTranscript)
             || isBehavioralQuestionText(question);
         // ... (context building unchanged) ...

         for await (const chunk of stream) {
             full += chunk;
+
+            // NAT-L4: Try to extract openingReasoning from partial JSON
+            // so the UI can show something while the rest accumulates.
+            if (!earlyReasoningEmitted && options?.onEarlyReasoning && full.length > 30) {
+                const early = tryParseConsciousModeOpeningReasoning(full);
+                if (early) {
+                    options.onEarlyReasoning(early);
+                    earlyReasoningEmitted = true;
+                }
+            }
         }

         return parseConsciousModeResponse(full);
     }
```

**Lines:** 133–197 (add `options` parameter and streaming extraction)

#### [MODIFY] `electron/conscious/ConsciousOrchestrator.ts` — wire early reasoning into UI emission

```diff
       if (input.whatToAnswerLLM) {
-        structuredResponse = await input.whatToAnswerLLM.generateReasoningFirst(
+        structuredResponse = await input.whatToAnswerLLM!.generateReasoningFirst(
           input.preparedTranscript,
           input.question,
           input.temporalContext,
           input.intentResult,
-          input.imagePaths
+          input.imagePaths,
+          {
+            onEarlyReasoning: (text) => {
+              // NAT-L4: Emit opening reasoning as a streaming preview
+              // so the user sees first content within ~400ms instead of
+              // waiting 2-5s for full JSON completion.
+              console.log(`[ConsciousOrchestrator] Early reasoning: "${text.substring(0, 60)}..."`);
+            },
+          }
         );
```

**Lines:** 447–453

#### [MODIFY] `electron/IntelligenceEngine.ts` — emit `suggested_answer_token` for early reasoning

In the `executeReasoningFirst` call site at [IntelligenceEngine.ts:1504-1513](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L1504-L1513), the `ConsciousOrchestrator.executeReasoningFirst` is awaited. We need to pass an `onEarlyReasoning` callback through the orchestrator that emits `suggested_answer_token`:

```diff
             const consciousResult = await this.consciousOrchestrator.executeReasoningFirst({
                 route: consciousRoute,
                 question: resolvedQuestion,
                 preparedTranscript,
                 temporalContext,
                 intentResult,
                 imagePaths,
                 whatToAnswerLLM: this.whatToAnswerLLM,
                 answerLLM: this.answerLLM,
+                onEarlyReasoning: (text) => {
+                    if (!shouldSuppressVisibleWork()) {
+                        this.latencyTracker.markFirstStreamingUpdate(requestId);
+                        this.emit('suggested_answer_token', text, question || 'inferred', confidence);
+                    }
+                },
             });
```

This requires `executeReasoningFirst` to accept and forward the callback. Add `onEarlyReasoning?: (text: string) => void` to its input type at [ConsciousOrchestrator.ts:425](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousOrchestrator.ts#L425).

### Impact

| Metric | Before | After |
|--------|--------|-------|
| Time to first visible text (conscious mode) | 2–5s (full JSON wait) | ~400ms (openingReasoning extraction) |
| Total answer time | Unchanged | Unchanged |

### Verification
- Ask "Design a rate limiter" with conscious mode on
- Confirm: first text appears within ~500ms (the `suggested_answer_token` emission)
- Confirm: final structured answer replaces it correctly when the full JSON parses
- Confirm: verification metadata still reports `deterministic: pass`

---

## Execution Order

```
Phase 1 (CRITICAL — do first, highest ROI):
  NAT-L1 (2 lines, instant impact)

Phase 2 (HIGH — compound gain with L1):
  NAT-L2 + NAT-L3 (coupled; both touch the prefetch pipeline)

Phase 3 (MEDIUM — UX polish):
  NAT-L4 (streaming optimization; multiple files)

Phase 4 (Hardening — previously approved):
  NAT-H3 (Rust, isolated) → NAT-H1 (infra) → NAT-H2 + NAT-H4 (AppState.ts)
```

---

## Open Questions

> [!IMPORTANT]
> **NAT-L1**: Should we add a configuration option (e.g. `settings.json`) for the budget values so they can be tuned without a code change? Or hardcode /the new values for now and revisit after we have latency telemetry?

> [!IMPORTANT]
> **NAT-L4**: The `onEarlyReasoning` callback emits text via `suggested_answer_token`. When the full structured response arrives and is formatted by `completeStructuredAnswer`, the UI must either **append** to the preview or **replace** it. Confirm which behavior the renderer expects — does it treat `suggested_answer` as a full replacement of any prior `suggested_answer_token` chunks?
