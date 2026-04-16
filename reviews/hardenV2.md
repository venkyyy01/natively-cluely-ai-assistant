# Deep Architectural Hardening Plan — V2

Comprehensive adversarial review of the entire `natively-cluely-ai-assistant` codebase.
Covers fail-safe/containment/transparency AND conscious-mode blind-spot analysis.

> [!NOTE]
> This plan supersedes the prior `reviews/harden.md` (V1). Every finding below is re-validated against current source, with 11 **new** findings (N1–N11) added, and all prior findings (F1–F10, P1–P4) preserved with updated analysis.

---

## I. Fail-Safe / Containment / Transparency

### 1. Process-Level Crash Behavior

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N1** | `critical` | **`process.exit(1)` inside `logToFileAsync`.finally()** — Both `uncaughtException` and `unhandledRejection` ([main.ts:32–43](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main.ts#L32-L43)) call `process.exit(1)` after an async file write that can itself throw. If file I/O blocks or throws, the `.finally()` callback still fires `process.exit(1)`, but this creates a race: the log can be incomplete, and any `app.on('before-quit')` cleanup is bypassed. More critically, this is **correct fail-closed behavior** — but the log-first-then-exit pattern means if the logging promise never settles (e.g., disk full, permission error), the process hangs in a half-dead state forever. |
| | | **Root cause**: No hard forced-kill timeout after the logging attempt. |
| | | **Fix**: Add a `setTimeout(() => process.exit(2), 3000)` guard. |

### 2. Stealth Containment

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N2** | `high` | **`enforceStealthFaultContainment` does insufficient containment** — ([main.ts:2982–2988](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main.ts#L2982-L2988)). On a `stealth:fault`, the method calls `syncWindowStealthProtection(true)` and records telemetry, but it does **not** pause or kill the intelligence pipeline. The meeting continues generating answers while stealth is faulted, creating potential exposure risk where sensitive UI content is rendered in a now-unprotected window. |
| | | **Root cause**: Containment only protects windows but doesn't gate intelligence output. |
| | | **Fix**: On stealth fault, either pause answer emission or suppress UI rendering. |
| **N3** | `high` | **`NativeStealthBridge.heartbeat` returns `connected: true, healthy: false` on failure but caller doesn't differentiate restart-success from restart-failure** — ([NativeStealthBridge.ts:196–268](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/stealth/NativeStealthBridge.ts#L196-L268)). The heartbeat method attempts `tryRestartAfterDisconnect` on failure; if restart succeeds but post-restart health check fails again, it still returns `connected: true, healthy: false`. The supervisor treats this as a heartbeat miss and faults, which is correct — **but the single restart attempt is never retried**. `restartAttemptedForActiveSession` permanently blocks further recovery. |
| | | **Fix**: Either allow N restart attempts with backoff, or fault the bridge immediately on first failure to avoid lingering half-alive state. |
| **N4** | `medium-high` | **`StealthArmController.disarm()` records first error but throws it, potentially leaving heartbeat/delegate in inconsistent state** — ([StealthArmController.ts:27–51](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/stealth/StealthArmController.ts#L27-L51)). The `disarm` method runs `faultNativeStealth → stopHeartbeat → setEnabled(false)` sequentially. If `faultNativeStealth` throws, the error is captured but `stopHeartbeat` and `setEnabled(false)` still run. However, if `setEnabled(false)` also throws, `firstError` retains the original fault error and the delegate disable failure is lost. |
| | | **Fix**: Aggregate all errors and expose them. |

### 3. Supervisor Bus Silent Failure Paths

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N5** | `high` | **SupervisorBus only throws on CRITICAL_EVENTS, silently swallows listener failures otherwise** — ([SupervisorBus.ts:64–93](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/runtime/SupervisorBus.ts#L64-L93)). The `CRITICAL_EVENTS` set contains `stealth:fault`, `lifecycle:meeting-starting`, `lifecycle:meeting-stopping`. All other event types (including `stealth:state-changed`, `recovery:checkpoint-written`, etc.) swallow listener errors with a `console.error`. This means a faulty handler for a state-change notification won't surface — the system thinks the transition was acknowledged. |
| | | **Fix**: At minimum, emit a bus-level error event or surface the failure count. Consider making all supervisor events non-swallowable. |

### 4. Audio Pipeline

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N6** | `medium-high` | **Audio pipeline health check runs once at startup (8s), then never again** — ([main.ts:1039–1073](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/main.ts#L1039-L1073)). `scheduleAudioPipelineHealthCheck` fires a single `setTimeout(8s)` but never re-schedules. If audio silently stops flowing after the initial check window, no alert is raised. The pipeline can become completely dead mid-meeting without detection. |
| | | **Fix**: Periodic health checks (e.g., every 60s) with configurable alerting on zero-chunk windows. |

### 5. IPC Security

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N7** | `medium` | **Some IPC channels bypass Zod validation** — ([preload.ts:484](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/preload.ts#L484)). `openExternal(url)` calls `ipcRenderer.invoke("open-external", url)` directly. If the main process handler doesn't apply the `externalUrlSchema` from `ipcValidation`, arbitrary URLs could be opened. Similar direct `ipcRenderer.invoke` calls exist for `switchToOllama`, `switchToGemini`, `testLlmConnection`, `setGeminiApiKey`, etc., without the `invokeAndUnwrap`/`invokeStatus` wrappers that enforce consistent result handling. |
| | | **Fix**: Audit all `ipcRenderer.invoke` calls and ensure server-side handlers validate every payload via `parseIpcInput`. |

---

## II. Conscious Mode Blind Spots & Hidden Assumptions

### 6. Verified Prior Findings (Updated Status)

All F1–F10 findings from V1 are **reconfirmed**. Key updates:

| V1 ID | Status | Update |
|-------|--------|--------|
| F1 | ✅ Reconfirmed | Behavioral prompts blocked → planner dead code. No change. |
| F2 | ✅ Reconfirmed | Global cooldown uses `lastTriggerByCooldownKey` map. Keys are `question || 'auto'` — still not per-thread/turn. Cooldown now emits metadata (`cooldownSuppressedMs`, `cooldownReason`), which is **good** observability, but suppression itself is still a `return null` (drop). |
| F3 | ✅ Reconfirmed | Tail-preserving trim. No change. |
| F4 | ✅ Reconfirmed | Parallel context drops assistant. No change. |
| F5 | ✅ Reconfirmed | Structured response is buffered then parsed. No change. |
| F6 | ✅ Reconfirmed | Provenance lexical limits. No change. |
| F7 | ✅ Reconfirmed | Live indexing cadence. No change. |
| F8 | ✅ Reconfirmed | Transcript chunking splits pairs. No change. |
| F9 | ✅ Reconfirmed | Latency tracker observability gaps. No change. |
| F10 | ✅ Reconfirmed | Renderer infers thread state. No change. |

### 7. New Conscious Mode Findings

| ID    | Severity   | Finding |
|-------|------------|---------|
| **N8** | `high` | **Speculative answers bypass verifier/provenance** — ([ConsciousAccelerationOrchestrator.ts:309–356](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousAccelerationOrchestrator.ts#L309-L356), [IntelligenceEngine.ts:803–836](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L803-L836)). When acceleration is enabled, `getSpeculativeAnswer` returns a pre-computed answer that was generated by `speculativeExecutor`. This answer is emitted directly via `suggested_answer` without passing through `ConsciousVerifier` or `ConsciousProvenanceVerifier`. The `verifier` metadata field is never set for speculative answers. |
| | | **Root cause**: Speculative answers prioritize latency over verification. |
| | | **Fix**: Either verify speculative answers post-hoc before emission, or clearly mark them as `unverified` in metadata. |
| **N9** | `high` | **`FallbackExecutor` auto-recovery resets consecutive failures on time alone, ignoring root cause** — ([FallbackExecutor.ts:86–95](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/FallbackExecutor.ts#L86-L95)). `checkAutoRecovery()` resets `consecutiveFailures` to 0 after a 5-minute cooldown, regardless of whether the underlying issue (LLM provider down, API key revoked, etc.) has been resolved. This creates a cycle: fail → degrade → auto-recover → fail again → degrade → auto-recover. |
| | | **Fix**: Require at least one successful tier-0 execution before auto-recovery, or probe the root cause. |
| **N10** | `medium-high` | **`ConsciousStreamingHandler.abort()` fires-and-forgets the cancelled event** — ([ConsciousStreamingHandler.ts:137–142](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousStreamingHandler.ts#L137-L142)). `this.emit(...)` returns a Promise but `abort()` doesn't await it. If a handler needs to do cleanup on cancellation, it may not complete before the caller proceeds. |
| | | **Fix**: Return the Promise from `abort()` and document whether callers should await it. |
| **N11** | `medium` | **`DesignStateStore` has unbounded growth potential per-facet via `inferFacets` multi-tagging** — ([DesignStateStore.ts:112–165](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/DesignStateStore.ts#L112-L165), [DesignStateStore.ts:527–543](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/DesignStateStore.ts#L527-L543)). A single transcript can be tagged into multiple facets. Each facet is trimmed to `MAX_FACET_ENTRIES = 14`, but with 10 facets × 14 entries = 140 entries max. If an interviewer uses keyword-dense language, every turn gets added to many facets. While bounded, the trim is per-facet and uses linear scans. |
| | | **Fix**: Add a global cap (e.g., 100 total entries) and instrument size alerts. |

---

## III. Cross-Cutting Architectural Risks

### 8. Missing Tests for Critical Paths

| Area | Gap |
|------|-----|
| Stealth fault → intelligence pipeline pause | No test verifies that answer generation is suppressed on stealth fault |
| Speculative answer + verifier bypass | No test that speculative answers are tagged `unverified` or verified post-hoc |
| Process-level crash handlers | No test for the `setTimeout` guard on `process.exit` race |
| Audio pipeline mid-meeting death | No test for audio health check re-scheduling |
| IPC validation coverage | `ipcContracts.test.ts` exists but doesn't cover all direct `ipcRenderer.invoke` paths |
| Bus error propagation for non-critical events | `supervisorBus.test.ts` exists but doesn't test error swallowing for non-critical types |
| `FallbackExecutor` auto-recovery without root-cause resolution | `fallbackExecutor.test.ts` exists but doesn't model repeated fail-recover-fail cycles |
| Cooldown recursion depth | No test for stack growth under rapid duplicate triggers |
| Hypothesis confidence recalibration | No test verifies confidence ever decreases |
| Thread continuation classifier bypass | No test injects wrong classifier output and verifies routing |
| Meeting save retry/failure visibility | `meetingPersistence.test.ts` tests happy path but not repeated-failure-with-alerting |
| Profile data prompt injection | No test injects adversarial profile content and verifies sanitization |

### 9. Observability Gaps

| Signal | Current State | Recommended |
|--------|---------------|-------------|
| Verifier outcome in answer metadata | Present for conscious mode only (F9) | Also tag `unverified` for speculative, standard paths |
| Context selection provenance | `evidenceHash` present but opaque | Add `contextItemIds` or selection-rank trace |
| Stealth fault → pipeline pause correlation | No signal linking these | Add `stealth_containment_active` flag to answer metadata |
| Audio pipeline chunk rates | Health check at 8s only | Periodic histogram exported to telemetry |
| FallbackExecutor tier transitions | `tierFailures` counter exists | Emit event on each degradation/recovery transition |
| Conscious mode state mutations | No SupervisorBus events emitted | Emit `conscious:thread_action`, `conscious:hypothesis_update` events |
| Cooldown recursion depth | Not tracked | Add `cooldown_recursion_depth` histogram metric |
| Meeting save failures | Console-only logging | Emit renderer-visible notification + retry count metric |
| Hypothesis confidence trajectory | No external signal | Emit `hypothesis:confidence_update` with before/after values |

---

## IV. Prioritized Remediation Roadmap

### Priority 0 — Immediate (1 sprint)

1. **N1**: Add `setTimeout(() => process.exit(2), 3000)` guard in both `uncaughtException` and `unhandledRejection` handlers.
2. **N2**: On `stealth:fault`, emit a `stealth_containment_active` flag and conditionally suppress answer output emission (or mask UI rendering in renderer).
3. **N8**: Add verifier pass (or explicit `verifier: { deterministic: 'skipped', provenance: 'skipped' }` tag) to speculative answer metadata. Add test.
4. **F2** (update): Transition cooldown from global-reject to per-cooldown-key queue with explicit `intelligence-cooldown` events (already partially done — complete the mechanism).
5. **F3**: Implement head-reserved prompt budgeting — reserve first N tokens for system/schema/evidence, trim transcript from head.
6. **X1**: Guard cooldown recursion with a max-depth counter to prevent stack overflow under rapid triggers.
7. **X3**: Add semantic topical-compatibility check before overriding `threadAction` to `'continue'` in orchestrator route.

### Priority 1 — Near-term (1–2 sprints)

8. **N5**: Make SupervisorBus configurable for fail-shut on all events, or at minimum emit a `bus:listener-error` meta-event.
9. **N6**: Convert audio health check to periodic (60s interval) with counter-based staleness detection.
10. **N3**: Allow N restart attempts in `NativeStealthBridge.heartbeat` with exponential backoff, or fault immediately on first failure.
11. **N9**: Require at least one successful probe before `FallbackExecutor.checkAutoRecovery()` resets degradation level.
12. **N7**: Audit all IPC channels; ensure every `ipcRenderer.invoke` target validates via `parseIpcInput`.
13. **F4**: Make assistant-history filter configurable, not unconditional.
14. **F6**: Expand provenance technology vocabulary dynamically from profile/evidence context.
15. **F9**: Add `contextItemIds`, `verifierOutcome`, and `stealthContainmentActive` to `LatencyMetadata`.
16. **X2**: Add confidence decay to `AnswerHypothesisStore` when `shouldContinueThread` is false or topic shifts occur.
17. **X4**: Add retry queue + renderer notification for `MeetingPersistence` save failures.
18. **X5**: Emit `conscious:phase_changed` and `conscious:thread_action` events on SupervisorBus for state mutation visibility.

### Priority 2 — Structural (2–4 sprints)

19. **F1**: Decide behavioral routing policy; remove dead planner branch or enable it.
20. **F5**: Implement progressive structured output (emit `openingReasoning` early, then sections).
21. **F7**: Trigger live indexing on interviewer-finalized turns, not just timer.
22. **F10**: Backend-emit authoritative thread state snapshots; renderer renders, doesn't infer.
23. **N4**: Aggregate all `disarm` errors and surface them.
24. **N10**: Make `ConsciousStreamingHandler.abort()` return `Promise<void>`.
25. **N11**: Add global entry cap to `DesignStateStore`, instrument overflow alerts.
26. **X6**: Add profile data sanitization layer (strip control chars, enforce length, validate structure) before prompt injection.
27. Schema governance: single canonical conscious JSON schema with version, adapter layer for alternate prompt families.
28. Quality replay harness: deterministic replay for routing, context, verifier, fallback.

---

## V. Verification Plan

### Automated Tests

| Test | Validates |
|------|-----------|
| `process.exit` timeout guard | N1 — process terminates within 3s even if log write hangs |
| Stealth fault → answer suppression | N2 — no `suggested_answer` events emitted while containment active |
| Speculative answer verifier metadata | N8 — speculative answers have `verifier: skipped` or pass verification |
| Bus error propagation | N5 — listener errors surfaced for all event types |
| Audio periodic health | N6 — health check fires at intervals, detects zero-chunk window |
| FallbackExecutor fail-recover-fail | N9 — auto-recovery blocks without root-cause resolution |
| IPC payload validation | N7 — all IPC channels reject invalid/malicious payloads |
| Cooldown per-key tests | F2 — rapid follow-ups on different keys not suppressed |
| Prompt head preservation | F3 — system/schema instructions survive under overflow |
| Cooldown recursion max-depth | X1 — recursion capped, no stack overflow under rapid duplicate triggers |
| Hypothesis confidence decay | X2 — confidence decreases on topic shift or negative signal |
| Thread continuation semantic check | X3 — misclassified topic shift does not force thread continuation |
| Meeting save retry queue | X4 — failed saves are retried, renderer receives notification |
| Profile data sanitization | X6 — malicious profile content is stripped before LLM consumption |

### Manual Verification

- Deploy to staging and simulate stealth fault during active meeting → verify answer output is suppressed
- Run long meeting (>1 hour) with audio device disconnected mid-session → verify detection and user notification
- Test with malformed IPC payloads from a patched renderer → verify rejection
- Inject adversarial profile text (prompt injection, control chars) → verify sanitization
- Trigger rapid duplicate questions (>10 in 3s) → verify no stack overflow and all triggers are tracked

---

## VII. Cross-Agent Cross-Validated Findings

> [!NOTE]
> The findings below were raised by a separate agent review and independently verified against the current codebase. Only findings that surfaced **genuinely new** risks not already covered by N1–N11 or F1–F10 are included. Duplicate or overstated claims were excluded during verification.

### X1. Cooldown recursion can cause unbounded stack growth

- **Severity**: `high`
- **Status**: `validated`
- **Evidence**:
  - [IntelligenceEngine.ts:682–690](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L682-L690): When cooldown is active and no abort controller exists, the code `await`s a `setTimeout(cooldownSuppressedMs)` and then **recursively calls** `this.runWhatShouldISay(...)` with accumulated suppression time. Each recursive call is a full stack frame.
  - If a rapid stream of duplicate triggers arrives (e.g., STT producing near-identical questions rapidly), each deferred call re-enters `runWhatShouldISay`, which checks cooldown again, and may defer again.
- **Why this matters**:
  - Under sustained load or clock skew, the call stack grows without bound until the `whatToSayAbortController` fires or the cooldown window finally expires.
  - There is no max-depth guard.
- **Relationship to F2**: F2 identifies the cooldown as too coarse; X1 identifies an implementation-level stack safety issue within the same mechanism.
- **Fix**: Add a `maxRecursionDepth` counter (e.g., 3). If exceeded, emit event and return null rather than recursing.

### X2. AnswerHypothesis confidence is monotonically non-decreasing

- **Severity**: `high`
- **Status**: `validated`
- **Evidence**:
  - [AnswerHypothesisStore.ts:133](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/AnswerHypothesisStore.ts#L133): `Math.min(0.96, this.latestHypothesis.confidence + (reaction.confidence * 0.12))` — confidence only increases.
  - [AnswerHypothesisStore.ts:109](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/AnswerHypothesisStore.ts#L109): `Math.min(0.9, Math.max(this.latestHypothesis.confidence, baseConfidence))` — thread continuation also only ratchets up.
  - `noteObservedReaction` at line 127 skips the update entirely when `!reaction.shouldContinueThread` — but never applies a decay.
  - `reset()` at line 178 clears to null, but that only fires on mode disable, not on misclassification.
- **Why this matters**:
  - An incorrect early hypothesis locks in high confidence permanently.
  - The LLM planner receives `LIKELY_USER_ANSWER_CONFIDENCE: 0.96` and treats it as a strong signal — even if the hypothesis is stale or wrong.
  - There is no recalibration event, no decay over time, no external correction mechanism.
- **Failure scenario**: Interviewer says "let's switch gears" (topic shift). `QuestionReactionClassifier` correctly returns `shouldContinueThread: false`. Hypothesis store skips the update (no decay). Next question triggers a new reaction where `shouldContinueThread: true`, and confidence ratchets up again from the stale high baseline.
- **Fix**: Add a `recalibrate()` method triggered when `shouldContinueThread` is false and confidence is >0.7. Apply a multiplicative decay (e.g., `confidence * 0.6`). Track confidence trajectory as a metric.

### X3. Thread continuation trusts classifier output without semantic verification

- **Severity**: `high`
- **Status**: `validated`
- **Evidence**:
  - [ConsciousOrchestrator.ts:84–86](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousOrchestrator.ts#L84-L86): If `currentReasoningThread && latestReaction?.shouldContinueThread && preRouteDecision.threadAction === 'start'`, the orchestrator overrides to `threadAction: 'continue'`.
  - [QuestionReactionClassifier.ts:161–162](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/QuestionReactionClassifier.ts#L161-L162): `generic_follow_up` classification returns `shouldContinueThread: true` if `wordCount >= 3 && hasGenericFollowUpCue(lower)`. The `hasGenericFollowUpCue` function matches extremely broad patterns like `/\b(this|that|it|those|these|them|there|then)\b/i`.
  - This means **any 3+ word sentence containing "that", "this", or "then"** will force thread continuation — even if it's a completely different topic.
- **Why this matters**:
  - "That's interesting, but let's talk about security instead" would match `\b(that)\b` and be classified as `generic_follow_up` with `shouldContinueThread: true`, overriding the routing decision.
  - The orchestrator does **not** check topical compatibility between the question and the active thread's `rootQuestion` before forcing continuation.
- **Relationship to F6/C-03**: The provenance verifier might catch a resulting bad answer, but the routing decision itself is unchecked.
- **Fix**: After `shouldContinueThread` returns true, verify that the new question has semantic overlap with `activeReasoningThread.rootQuestion` or `lastQuestion`. Either use lexical overlap (BM25 with thread keywords) or embedding similarity threshold before allowing override.

### X4. Meeting persistence save failures are fire-and-forget with console-only logging

- **Severity**: `high`
- **Status**: `validated`
- **Evidence**:
  - [MeetingPersistence.ts:100–104](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/MeetingPersistence.ts#L100-L104): `savePromise.catch(err => console.error(...)).finally(...)`. Background save failures are caught and logged to console only.
  - [MeetingPersistence.ts:233–238](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/MeetingPersistence.ts#L233-L238): The final save catch calls `markMeetingProcessingFailed(meetingId, error)` — which **does** mark it in the database. However, no retry queue exists, and no renderer notification indicates the failure to the user.
  - [SessionPersistence.ts:167–169](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/memory/SessionPersistence.ts#L167-L169): Scheduled debounced saves also catch errors with `console.warn` only.
- **Partial mitigation already present**: `markMeetingProcessingFailed` + `recoverUnprocessedMeetings` provides a crash-recovery path. However:
  - No retry is attempted within the same session.
  - No user-visible indicator surfaces a save failure.
  - `recoverUnprocessedMeetings` only runs at app startup, not on failure.
- **Fix**: Add a bounded retry queue (max 3 attempts with backoff) within `processAndSaveMeeting`. Emit a renderer-visible `meeting-save-failed` IPC event so the UI can show a persistent notification.

### X5. Phase detection is siloed — no cross-check with conversation state

- **Severity**: `medium-high`
- **Status**: `validated`
- **Evidence**:
  - [InterviewPhase.ts:89–105](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/InterviewPhase.ts#L89-L105): `InterviewPhaseDetector.detectPhase()` operates purely on keyword/pattern matching against the current transcript, with `transitionsFrom` as a validity check. It does **not** consult `ConsciousThreadStore`, `AnswerHypothesisStore`, or `DesignStateStore` state.
  - [ConsciousThreadStore.ts:41–42](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousThreadStore.ts#L41-L42): The thread store calls `detectPhaseFromTranscript(normalized)` as a callback — the detector has no access to thread context.
  - [ConsciousAccelerationOrchestrator.ts:125–128](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousAccelerationOrchestrator.ts#L125-L128): Acceleration orchestrator also sets phase independently.
- **Why this matters**:
  - Multiple components (thread store, acceleration orchestrator, adaptive context window) each maintain their own phase reference without a reconciliation mechanism.
  - Phase can diverge across subsystems — e.g., the thread store may believe it's in `deep_dive` while the acceleration orchestrator thinks it's in `scaling_discussion`.
  - No event is emitted when phase changes, making divergence invisible.
- **Fix**: Centralize phase authority in a single `PhaseManager` that emits `conscious:phase_changed` events via SupervisorBus. All consumers subscribe rather than detect independently.

### X6. Profile data injection has no input sanitization against prompt injection

- **Severity**: `medium-high`
- **Status**: `partially validated`
- **Evidence**:
  - [IntelligenceEngine.ts:757–759](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L757-L759): `const profileData = knowledgeOrchestrator?.getProfileData?.()` — profile data is fetched and passed directly to context assembly.
  - The `KnowledgeOrchestrator` lives in `premium/electron/knowledge/` (not available in this worktree for direct inspection), but the integration point shows no sanitization layer between fetched profile data and LLM prompt assembly.
  - Profile data (resume text, JD) is user-uploaded content that flows verbatim into `CONVERSATION:` or evidence blocks.
- **Caveat**: The premium module may have internal validation. Without direct source access to `KnowledgeOrchestrator.getProfileData()`, this finding is partially validated at the integration boundary.
- **Why this matters**:
  - If a user uploads a resume containing adversarial text (e.g., "Ignore previous instructions..."), that text flows directly into the LLM prompt.
  - This is a **self-adversarial** risk (the user is attacking their own session), so the blast radius is limited — but it can corrupt answer quality or cause the LLM to produce unexpected output.
- **Fix**: Add a sanitization layer at the `getProfileData()` boundary: strip control characters, enforce maximum length, and optionally detect/log prompt injection patterns.

---

### Rejected / Overstated Claims from External Review

The following claims from the external agent were evaluated and **rejected** or **downgraded**:

| External Claim | Verdict | Reason |
|----------------|---------|--------|
| "handleSuggestionTrigger silently catches errors" | **Rejected** | `handleSuggestionTrigger` ([IntelligenceEngine.ts:568–573](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L568-L573)) delegates to `runWhatShouldISay` — no silent catch at this level. Error handling is in the inner function. |
| "Conscious mode state changes emit no SupervisorBus events" | **Duplicate** | Already covered by N5 (SupervisorBus scope) and now X5 (phase siloed). The conscious stores are internal state — the gap is in missing bus events, not missing stores. |
| "ProvenanceVerifier allowlist is trivially bypassed" | **Duplicate** | Already F6 in V1 and N8 in V2. The `extractDynamicTechnologyCandidates()` function at [ConsciousProvenanceVerifier.ts:97–124](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/conscious/ConsciousProvenanceVerifier.ts#L97-L124) provides heuristic dynamic extraction beyond the static list, which the external review failed to acknowledge. |
| "`isStale` check races with stream iteration" | **Downgraded to low** | The `isStale` closure ([IntelligenceEngine.ts:1025](file:///Users/venkatasai/Downloads/natively-cluely-ai-assistant/.worktrees/todo-completion/electron/IntelligenceEngine.ts#L1025)) uses `requestSequence` (monotonic counter) and `transcriptRevision` — both are checked atomically. A TOCTOU gap exists theoretically but the consequence is a fallback, which is fail-safe. |
| "LLM judge verdict is trusted without consistency check" | **Duplicate** | Already P2 in V1 (`requireJudge` behavior). |
| "Consciousness state persists across meetings without sanitization" | **Rejected** | `reset()` is called via `setConsciousModeEnabled(false)` and `clearConsciousModeThread()`. `createSuccessorSession` in `SessionTracker` creates a fresh tracker. |
| "No circuit breaker between conscious orchestration layers" | **Downgraded to design suggestion** | `FallbackExecutor` already provides degradation tiers. A formal circuit-breaker pattern would help but the current fallback chain is functional. |
| "pendingRestorePromise can be overwritten" | **Downgraded to low** | The restore path is sequential; concurrent restores are an edge case with no observed failure mode. |

---

## VIII. Definition of Done

- [ ] Every change has a route-level regression test + at least one adversarial case
- [ ] No silent fallback/drop path remains without explicit reason emission
- [ ] Prompt schema/version is unambiguous at generation + parse boundaries
- [ ] On-call diagnostics can reconstruct: **question → selected context → verifier verdict → fallback reason → stealth containment state**
- [ ] All `process.exit` paths have bounded-time guarantees
- [ ] All supervisor bus events are non-silently swallowed or explicitly classified
- [ ] Hypothesis confidence can decrease — recalibration mechanism exists
- [ ] Cooldown recursion is bounded with max-depth guard
- [ ] Meeting save failures are retried and surfaced to renderer
- [ ] Thread continuation decisions are semantically validated
