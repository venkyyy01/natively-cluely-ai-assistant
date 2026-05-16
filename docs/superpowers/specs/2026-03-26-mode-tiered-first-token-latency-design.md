# Mode-Tiered First-Token Latency Design

Date: 2026-03-26
Status: Draft
Owner: OpenCode

## Goal

Make Natively feel immediately responsive by enforcing a mode-tiered latency policy:

- normal mode must target roughly `200 ms` to `900 ms` first-token latency in real use
- profile mode must stay profile-aware but degrade gracefully to near-normal latency
- Conscious Mode may remain richer, but should still avoid unnecessary delay, especially on follow-up turns

## Product Decision

The answer system should no longer treat all modes equally on the latency axis.

Instead, the system should optimize each mode according to user value:

1. **Normal mode:** prioritize time-to-first-token above all optional enrichment
2. **Profile mode:** prioritize groundedness, but only when the question clearly needs profile context; otherwise avoid unnecessary slowdown
3. **Conscious Mode:** reserve this mode for system design interviews and live coding interviews where screenshots are added to context, while still making follow-up continuation cheaper than full fresh reasoning

## Latency SLO Definition

The normal-mode target must be measured with exact timestamps.

### Measurement Contract

- **start timestamp:** when `runWhatShouldISay()` accepts the request
- **streaming-provider end timestamp:** when the first visible token/update is emitted to the renderer
- **non-streaming-provider end timestamp:** when the first complete answer payload is emitted to the renderer

### Normal Mode SLO

For `fast_standard_answer` in normal mode:

- **p50 target:** `<= 200 ms` when local orchestration is the main determinant
- **p95 target:** `<= 900 ms` under typical local usage

### Required Segmentation

Latency reporting must segment by:

- route
- provider capability (`streaming`, `buffered`, `non_streaming_custom`)
- whether fallback occurred
- whether interim-question substitution occurred

If `providerRequestStarted` is late, treat that as a local pipeline regression rather than a provider problem.

## Non-Negotiable Constraints

- Do not regress correctness in profile-grounded answers for resume/background questions
- Do not regress Conscious Mode system-design structure or thread continuity
- Do not change manual answer or follow-up refinement semantics
- Do not introduce provider-specific assumptions that break custom/cURL/non-streaming providers
- Every latency change must be paired with instrumentation and regression tests

## Current Problem

The codebase already has route separation (`fast_standard_answer`, `enriched_standard_answer`, `conscious_answer`), but the system still lacks a strict latency contract per mode.

That allows expensive work to creep into the pre-stream path:

- transcript/context preparation beyond what is necessary for the first token
- knowledge/profile interception for requests that do not truly require it
- Conscious Mode redoing work on design follow-ups that should behave as continuations
- no explicit budget boundary preventing future regressions in normal-mode startup cost

## Desired User-Visible Behavior

### Normal Mode

For ordinary `what should I say` requests, the app should begin answering almost immediately.

Normal mode should feel like a low-latency assist overlay, not a full reasoning engine.

This means the system should prefer speed over optional enrichment whenever the request is not clearly profile-specific or Conscious-Mode-specific.

Target envelope for this mode:

- aspirational best case: around `200 ms` first token
- acceptable steady-state target: within `900 ms`
- anything consistently above that should be treated as a latency regression unless caused by provider/network conditions outside the local hot path

### Profile Mode

When the interviewer asks resume/background questions, the answer should use the loaded profile first.

However, if profile enrichment is unavailable, slow, or fails to produce useful context, the system should fall back automatically to the normal fast path rather than stall.

Profile mode should therefore be latency-bounded rather than latency-unbounded.

Correctness rule:

- if usable grounding is available within budget, use it
- if grounding is unavailable or late, fall back safely, but mark the result internally as ungrounded fallback rather than silently treating it as strongly profile-grounded

Fallback contract for profile-required questions:

- do not stall indefinitely waiting for profile context
- do not fabricate resume-specific claims when profile grounding is missing
- return a generic-safe interview answer if the budget is exceeded
- record explicit fallback metadata so the system can distinguish grounded answers from safe fallback answers

### Conscious Mode

Conscious Mode is not a general-purpose rich-answer mode.

It should be used only for:

- system design interviews
- live coding interviews where screenshots are captured and added to context

Fresh Conscious Mode answers may remain more deliberate than normal mode.

But once a system-design thread exists, follow-up questions like tradeoffs, sharding, failover, hot spots, and scaling should reuse existing reasoning context and avoid the full startup cost of a new design answer.

For live coding usage, Conscious Mode should rely on screenshot-backed context rather than purely transcript-only reasoning.

## Proposed Architecture

## 1. Mode-Tiered Pre-Stream Budgets

Introduce an explicit conceptual budget for work allowed before provider streaming begins.

### Normal Mode Pre-Stream Contract

Allowed before streaming:

- resolve latest interviewer question
- use latest interim interviewer text when present
- build a tiny transcript snapshot only if strictly required
- select compact fast prompt shell
- start provider stream

Explicitly excluded from normal-mode pre-stream path:

- blocking intent classification
- profile/knowledge interception
- temporal context building
- extended prompt assembly
- background enrichment that can happen after or instead of the first token

### Profile Mode Pre-Stream Contract

Allowed before streaming:

- all normal-mode hot-path work
- profile interception only for strict profile-required questions
- a bounded profile enrichment attempt

Concrete budget:

- profile enrichment may consume at most `250 ms` of additional pre-stream time beyond the normal hot path

Required fallback rule:

- if profile enrichment fails, times out, or yields no usable context, route must degrade to the normal fast answer path immediately
- fallback must record a reason such as `timeout`, `no_context`, or `error`
- fallback answers must be treated as generic-safe answers, not profile-grounded answers

### Conscious Mode Pre-Stream Contract

Allowed before streaming:

- Conscious Mode qualification
- thread lookup / continuation decision
- Conscious prompt family selection
- minimal continuation-state assembly
- screenshot-context eligibility checks for live coding flows

Concrete budget:

- continuation-path pre-stream work should target `<= 150 ms` local orchestration overhead before provider start
- fresh Conscious starts may exceed that, but continuation must remain materially cheaper than fresh-start setup

Optimization rule:

- follow-up continuation should be cheaper than a fresh Conscious Mode start
- if continuation detection is ambiguous, prefer a fresh Conscious start over stale reuse

## 2. Explicit Hot-Path Guardrails

The code should express which work is hot-path-critical and which work is optional.

This should be enforced with route-specific orchestration rather than comments or convention.

For the normal route, the engine should have a narrow execution branch whose only purpose is to get to `providerRequestStarted` and `firstToken` as fast as possible.

For the profile route, the engine should wrap enrichment in a safe budgeted gate.

For Conscious Mode, the engine should split fresh-start reasoning from continuation reasoning so continuation is not penalized by unnecessary setup.

Ambiguity handling:

- normal mode prefers the cheapest safe path
- profile mode prefers enriched routing only on strict deterministic profile-required matches
- Conscious Mode prefers continuation only on deterministic continuation matches; otherwise it starts fresh

Deterministic rules for implementation/testing:

### Strict Profile-Required Questions

Use deterministic phrase matching only.

Positive examples:

- `tell me about yourself`
- `walk me through your resume`
- `walk me through your background`
- `tell me about your background`
- `why are you a fit for this role`
- `tell me about a project you worked on`
- `what experience do you have with x in your previous role`

Negative examples:

- `how would you design a rate limiter`
- `what are the tradeoffs`
- `how would you shard this`
- `have you worked with redis`

### Deterministic Continuation Matches

Treat these as continuation phrases when an active Conscious thread exists:

- `what are the tradeoffs`
- `how would you shard this`
- `what happens during failover`
- `what if traffic spikes`
- `where is the bottleneck`
- `what metrics would you watch`

### Conscious Mode Eligibility

Conscious Mode should only route on when at least one of these is true:

- the question is a system-design / architecture / scaling discussion
- the user is in a live-coding flow and screenshot context is available for the current turn

Conscious Mode should not activate for generic behavioral, profile, company-fit, or ordinary what-to-say questions.

### Clear Topic Shift Reset Criteria

Reset the Conscious thread when the next interviewer prompt clearly changes the domain away from the current design discussion, for example:

- switching from system design to behavioral/company/launch-plan topics
- introducing a new technical problem statement rather than asking a follow-up on the existing one

### Usable Grounding Within Budget

Grounding counts as usable only if the profile/knowledge layer returns concrete profile-derived context relevant to the current question within the configured budget. Empty, null, timed-out, or error responses are not usable grounding.

## 3. Profile Enrichment as a Bounded Interceptor

Profile mode should no longer behave like an all-or-nothing enrichment path.

Instead:

1. route only when the question clearly requires profile grounding
2. attempt profile/knowledge enrichment within a bounded window
3. if successful, stream enriched answer
4. if not successful quickly enough, degrade to fast standard answer using the same latest-question contract

This preserves correctness where profile grounding matters while protecting responsiveness.

## 4. Conscious Continuation Fast Lane

Conscious Mode should distinguish between:

- **fresh reasoning starts**
- **thread continuations**

Continuation turns should reuse:

- active reasoning thread metadata
- current system-design problem framing
- known architecture/components from the thread

Continuation turns should avoid rebuilding the same setup framing when the interviewer is only asking:

- tradeoffs
- bottlenecks
- sharding
- replication
- failover
- scaling
- operational metrics

This keeps Conscious Mode rich without making every follow-up feel like a cold start.

Thread safety rules:

- continuation reuse must be anchored to request ID and transcript revision
- clear topic shifts must reset the active thread before routing
- stale continuation work must be discarded if a newer request or transcript revision appears
- on uncertainty, prefer fresh-start reasoning instead of unsafe continuation reuse

## 5. Latency Instrumentation Expansion

The current latency tracker should be extended so we can prove the system is improving rather than guessing.

Add route-aware observations for:

- time to `providerRequestStarted`
- time to `firstToken`
- whether profile enrichment was attempted
- whether profile enrichment completed, failed, timed out, or fell back
- `profileFallbackReason`
- whether Conscious Mode used `fresh_start` or `thread_continue`
- transcript revision and request ID for discarding stale work safely
- provider capability class

This instrumentation is required both for debugging and for future regression prevention.

For non-streaming providers, use `firstVisibleAnswer` as the comparable end marker instead of `firstToken`, while keeping the same start timestamp.

## Safety Rules

### Normal Mode Safety

- must not accidentally pick enriched routing for generic technical/system-design questions
- must not let background work overwrite the newest in-flight answer

### Profile Mode Safety

- must not stall on missing/slow profile data
- must not silently lose profile grounding on questions that clearly require it when enrichment is available in budget
- must mark fallback explicitly when a profile-required question degrades to generic output
- must never present fallback output as if it were resume-grounded output

### Conscious Mode Safety

- must not reuse an old design thread after a clear topic shift
- must preserve the existing structured answer contract for fresh system-design questions
- must discard stale continuation work when transcript revision or request ordering changes
- must not activate for non-system-design questions unless the live-coding + screenshot-context eligibility rule is satisfied

## Testing Strategy

Add or extend regression tests for:

### Normal Mode

- latest question and interim question are used immediately
- no profile interception on generic fast-path prompts
- first-token path preserves newest request under overlap/races

### Profile Mode

- profile-required questions attempt enrichment
- slow/failed enrichment falls back to fast standard answer
- generic non-profile questions avoid the enriched path even when profile mode is enabled
- fallback metadata is emitted when profile mode degrades to generic output
- tests assert the profile enrichment budget and fallback ordering

### Conscious Mode

- continuation questions use a continuation path
- fresh design questions still use the richer structured path
- non-design topic shifts clear thread state
- ambiguous continuation cases choose fresh-start reasoning safely
- tests assert continuation pre-stream budget remains below the fresh-start path
- live-coding Conscious Mode only activates when screenshot context is present

### Instrumentation

- latency tracker records fallback metadata and continuation metadata
- non-streaming providers record `firstVisibleAnswer` timing instead of `firstToken`
- route-specific ordering is observable in tests

## Recommended Implementation Order

1. extend latency instrumentation to distinguish fast/profile/conscious subpaths
2. tighten the normal-mode hot path so nothing optional runs before stream start
3. add bounded fallback behavior for profile enrichment
4. add Conscious continuation-specific fast lane
5. verify with targeted tests and Electron coverage gate

## Success Criteria

This work is successful when:

- normal mode first-token latency trends toward the `200-900 ms` target envelope under typical local usage
- normal mode latency is reported as an actual SLO with `p50 <= 200 ms` and `p95 <= 900 ms` for the fast route, segmented by provider capability
- profile mode remains grounded for resume/background questions but no longer feels blocked when enrichment is slow
- Conscious Mode follow-ups feel faster than fresh Conscious answers
- no regressions appear in route selection, profile correctness, or Conscious thread continuity
