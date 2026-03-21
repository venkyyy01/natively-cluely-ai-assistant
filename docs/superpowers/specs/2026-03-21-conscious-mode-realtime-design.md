# Conscious Mode Realtime Design

## Goal

Make Conscious Mode behave like a reliable realtime interview-assist mode for system design practice.

When the `Conscious Mode` toggle is on:

- live interviewer transcript flow remains the primary trigger path
- typed/manual input is optional and supported, but never required
- qualifying technical/system-design prompts route through reasoning-first generation
- malformed, slow, or failed Conscious Mode generation falls back to normal answer generation in the same cycle
- the app never stops producing help because Conscious Mode misfired

## Product Intent

Conscious Mode is not a separate manual tool. It is a realtime coaching mode that builds the habit of explaining reasoning before code.

The mode should help users:

- verbalize an approach before implementation
- answer pushback like `why this approach?`, `what are the tradeoffs?`, and `how would this scale?`
- preserve technical context through messy realtime interviews
- recover safely from tangents, interruptions, transcript noise, and model failures

## Non-Goals

- replacing the normal live assist pipeline with a fully separate engine
- making Conscious Mode own recap/shorten/non-answer actions in the first phase
- forcing every transcript line through reasoning-first generation
- trusting transcript position alone as evidence of context continuity

## Current Problem Summary

Today, Conscious Mode is persisted correctly, but runtime behavior is fragile:

- enablement can succeed while reasoning-first generation silently falls back or produces nothing useful
- malformed structured output can cause the experience to feel like Conscious Mode is not working
- transcript continuity is too brittle for tangents, interruptions, and returns to a prior technical topic
- the app can stop generating useful input in critical moments instead of degrading gracefully

## Design Principles

1. Reliability beats sophistication.
2. No dead air: always provide a usable answer.
3. Preserve technical context separately from ambient conversation.
4. Resume threads only with evidence, not guesswork.
5. Favor safe fresh answers over stale carried-over context.
6. Typed/manual prompts may override routing temporarily without destroying live state.

## Recommended Approach

Keep a single live suggestion pipeline and treat Conscious Mode as a routing and presentation layer on top of the existing `What to answer` flow.

### Why this approach

- preserves the proven live transcript trigger path
- minimizes drift between normal and Conscious Mode behavior
- allows immediate same-cycle fallback to standard generation
- keeps implementation focused on routing, context management, and validation instead of duplicating the whole engine

## Architecture

### 1. Transcript Intake Layer

Responsible for ingesting raw speech-derived turns with:

- speaker role
- text
- confidence
- final/non-final status
- timestamps
- interruption markers

This layer should buffer partial transcript fragments briefly so half-questions do not trigger new reasoning attempts too early.

#### Transcript Event Semantics

- `final` interviewer events are authoritative by default.
- `partial` interviewer events are advisory and should be buffered during the debounce window.
- partials may be promoted only when no final arrives within the debounce window and transcript confidence remains high.
- if the STT provider emits revised text for the same utterance, the latest revision replaces earlier partial text before classification.
- duplicate final events must be deduplicated using speaker + normalized text + close timestamp window.
- once a final event has already triggered routing, later duplicates must not retrigger answer generation.
- out-of-order late events should be stored in raw history, but must not rewrite active thread state unless explicitly recognized as corrections to the latest utterance.
- empty, whitespace-only, or very short low-confidence turns are ignored.
- overlapping speaker-attribution errors should fail closed to conservative routing and must not mutate technical-thread memory.

### 2. Conversation State Controller

Maintain four distinct context buckets:

- `active technical thread`
- `suspended technical thread`
- `manual typed branch`
- `ambient conversation`

This is the core boundary that prevents transcript pollution.

### 3. Intent and Continuity Classifier

Each interviewer turn should be classified into one of these actions:

- `continue active thread`
- `pushback within active thread`
- `clarification within active thread`
- `temporary tangent`
- `return to suspended thread`
- `start fresh thread`
- `noise/admin/non-answerable chatter`

The classifier should use layered signals instead of raw keyword matching:

- technical/system-design intent
- question-likeness
- semantic overlap with active/suspended thread summary
- explicit continuation phrases
- explicit topic-shift phrases
- elapsed time since last technical turn
- transcript confidence
- interruption markers (`wait`, `hold on`, `actually`, `before that`)

### 4. Conscious Mode Planner

Build a bounded reasoning packet from the selected thread.

The packet should contain:

- current question
- root question
- current frame/subtopic
- assumptions already stated
- chosen approach so far
- tradeoffs already covered
- open follow-up prompts
- only recent relevant turns, not the full raw transcript

This planner should never dump all ambient transcript into the model prompt.

### 5. Fallback Executor

Run Conscious Mode generation inside a bounded realtime budget.

If the response is:

- too slow
- empty
- malformed
- structurally invalid
- clearly irrelevant to the current thread

then the same trigger cycle must immediately route to normal answer generation.

### 6. Renderer

Render Conscious Mode output in the same assist surface as normal mode so the experience remains seamless.

The output should prioritize:

- opening reasoning
- implementation path
- tradeoffs
- edge cases / scale
- pushback responses
- optional code transition

## Context Model

### Active Technical Thread

Represents the currently active technical problem.

Fields:

- `threadId`
- `rootQuestion`
- `currentQuestion`
- `frameLabel` (example: `rate limiter design`)
- `summary`
- `assumptions`
- `approach`
- `tradeoffsCovered`
- `openFollowUps`
- `lastStableStructuredResponse`
- `followUpCount`
- `lastUpdatedAt`
- `confidence`

### Suspended Technical Thread

Represents a recently active thread temporarily paused by a tangent or interruption.

It should retain the same structured summary but with:

- `suspendedAt`
- `resumeTTL`
- `resumeConfidence`

Only one suspended thread is needed in the first phase unless future testing proves multiple concurrent thread stacks are necessary.

If a second tangent occurs while one thread is already suspended:

- keep only the most recent suspended technical thread with the highest resume confidence eligible for automatic resume
- older suspended state may be archived for diagnostics only
- Phase 1 must not allow unbounded nested suspended-thread stacks

### Ambient Conversation

Contains:

- admin/setup discussion
- social chatter
- clarifications not tied to technical reasoning
- behavioral detours
- low-value transcript noise

Ambient conversation remains in raw transcript history but is excluded from Conscious Mode prompt assembly unless explicitly referenced by the interviewer.

### Manual Typed Branch

Represents explicit user-entered prompts.

Rules:

- typed input is high-priority and can temporarily override routing
- typed input may attach to the current active thread if clearly related
- typed input may fork a temporary branch if unrelated
- finishing a manual branch must not destroy the live active/suspended thread state

## Realtime Decision Flow

1. Receive transcript event.
2. Buffer non-final/fragmentary text for a short debounce window.
3. Normalize and classify the interviewer turn.
4. Choose one action:
   - continue active thread
   - suspend active thread and answer tangent safely
   - resume suspended thread
   - start fresh thread
   - ignore as noise/admin chatter
5. Build a bounded reasoning packet if Conscious Mode qualifies.
6. Attempt Conscious Mode generation under a short timeout budget.
7. Validate the structured response.
8. If valid, render Conscious Mode output and update the thread.
9. If invalid or late, immediately generate a normal answer in the same cycle.
10. Record telemetry/state for failure streaks, resumes, resets, and fallbacks.

## Concrete Runtime Defaults

These are Phase 1 defaults and should live in one centralized configuration surface.

- transcript debounce window: `350ms`
- partial promotion threshold: high confidence only after debounce
- Conscious Mode structured generation budget: `1200ms`
- fallback trigger after Conscious timeout: immediate in the same cycle
- suspended thread resume TTL: `5 minutes`
- high continuation confidence: `>= 0.75`
- medium continuation confidence: `0.45 - 0.74`
- low continuation confidence: `< 0.45`
- repeated Conscious failure threshold in one session: `3 consecutive failures`

These are starting values for implementation and verification, not final tuning commitments.

## Tangents, Interruptions, and Returns

### Temporary Tangent

Examples:

- scheduling and logistics
- compensation discussion
- `can you hear me?`
- a short digression before returning to the design question

Behavior:

- move active thread to `suspended`
- do not inject tangent content into technical reasoning memory
- answer safely in normal mode if needed

### Interruption Inside an Answer

Examples:

- `wait, before that...`
- `hold on, why Redis?`
- `actually, what if one region goes down?`

Behavior:

- treat the interruption marker as a control signal first
- if semantically attached, continue the same thread as pushback/clarification
- otherwise suspend and re-evaluate

### Return To Prior Topic

Examples:

- `back to the cache design`
- `so how would this scale?`
- `coming back to your original approach`

Behavior:

- compare against the suspended thread summary and frame label
- require high enough resume confidence to reattach
- if confidence is medium, reuse a narrower summary plus explicit assumptions
- if confidence is low, start fresh or fall back to normal mode

### Hard Topic Shift

Examples:

- switching from system design to behavioral
- changing from `rate limiter` to `microservice migration`
- moving from one technical problem to a clearly unrelated one

Behavior:

- retire or archive the previous thread
- start a new thread
- avoid bringing stale assumptions into the new response

## Confidence Model

Continuation decisions should be driven by a composite confidence score, not one heuristic.

Inputs:

- semantic similarity to thread frame
- explicit resume/continuation phrases
- explicit topic-shift phrases
- transcript quality/confidence
- time since last thread activity
- whether the interviewer turn is question-like
- whether the turn matches known pushback/follow-up patterns

Suggested policy:

- `high confidence` -> continue or resume thread
- `medium confidence` -> continue with narrowed context and explicit assumptions
- `low confidence` -> start fresh or use normal-mode fallback

## Failure Policy

### Core Rule

Conscious Mode must never suppress normal answer generation.

Global safety rule: if any stage after transcript intake fails or returns inconsistent state - classifier, planner, generation, validation, rendering, telemetry, or state update - the system must fail closed to normal answer generation and must not update technical-thread memory from the failed path.

### Timeout Behavior

- Conscious Mode gets a short bounded attempt window suitable for realtime use.
- If the window is missed, normal answer generation starts immediately.

### Validation Failures

If structured output is malformed or unusable:

- do not show a broken Conscious Mode response
- do not freeze the assist surface
- immediately emit a normal answer instead

### Fallback Context Policy

When the system falls back to normal mode in the same cycle:

- use the current interviewer turn as the primary input
- optionally include only the currently valid active-thread summary if continuation confidence was medium or high
- never inject malformed Conscious output or stale suspended-thread content into the fallback prompt

### Repeated Failure Handling

If Conscious Mode fails repeatedly in one session:

- temporarily degrade to standard live-answer mode for the rest of that session
- keep the toggle on as user intent
- allow automatic recovery on a later strong technical prompt or next session
- surface the issue only subtly in diagnostics/settings, not as a disruptive overlay

## State Write Rules

To avoid stale-context hallucinations, thread memory must only be updated from validated successful paths.

### Update Allowed

Update `lastStableStructuredResponse`, `summary`, `assumptions`, `approach`, `openFollowUps`, and `lastUpdatedAt` only when:

- Conscious Mode produced a valid structured response
- the response was accepted for display
- the selected thread action was `start`, `continue`, or `resume`

### Update Forbidden

Do not mutate technical-thread memory when:

- Conscious Mode timed out
- Conscious Mode returned malformed or empty output
- fallback normal-mode generation was used
- transcript confidence was too low for safe continuation
- classifier, planner, validation, or state-update code failed mid-cycle

### Suspend vs Retire

- move a thread to `suspended` only for tangents or uncertain short detours within TTL
- retire a thread on explicit topic shift, TTL expiry, or low-confidence reattachment after a different technical frame becomes active

### Resume Behavior

- on valid resume, update the existing thread rather than creating a new thread
- on ambiguous resume, prefer narrowed context plus explicit assumptions
- on expired TTL, treat the turn as fresh unless the interviewer explicitly re-establishes the prior frame

### Typed Override Writes

- typed/manual prompts may read from the active thread
- typed/manual prompts should write back into thread memory only when they are clearly attached to that technical frame and produce a validated response
- unrelated typed branches must not overwrite live active-thread state

## In-Flight Arbitration

Realtime overlaps must resolve deterministically.

### Precedence Order

1. newest authoritative interviewer `final` event
2. explicit typed/manual override from the user
3. in-flight Conscious generation attempt
4. in-flight normal fallback generation
5. late completions from superseded attempts

### Concurrency Rules

- if a newer authoritative interviewer event arrives before the current Conscious attempt renders, the older attempt is superseded and its result must not render or mutate thread memory
- if typed/manual input arrives during an in-flight live cycle, it may fork a manual branch, but it must not overwrite the authoritative live thread unless explicitly attached and validated
- if fallback generation has already started for a cycle, any later Conscious completion from that same superseded cycle is ignored for rendering and state writes; it may be recorded for telemetry only
- if a newer live cycle starts, all older late results become telemetry-only and are ineligible for rendering or memory mutation

### Ambiguous Match Rule

If both active and suspended thread matches score above threshold without a clear winner:

- do not resume either thread automatically
- prefer a safe fresh answer or narrowed fallback using only the current turn plus minimal assumptions
- require explicit interviewer resume evidence before reattaching one prior thread

### Render and Persistence Failure Policy

- if generation succeeds but render fails, emit the normal fallback answer if still within realtime budget and do not write Conscious-thread memory from the failed render path
- if render succeeds but post-render persistence fails, keep the visible rendered answer for that cycle but do not update thread memory; mark the cycle as degraded in telemetry
- duplicate visible outputs from the same cycle are never allowed; once one visible answer has been committed for a cycle, all later completions are suppressed from rendering

### Failure Streak Reset

The consecutive Conscious failure counter resets after one successful validated Conscious response or on session restart.

## Output Behavior

When Conscious Mode succeeds, it should optimize for spoken reasoning-first coaching.

The answer should help the user say:

1. the main idea first
2. why this approach is reasonable
3. tradeoffs and constraints
4. edge cases and scale/failure considerations
5. only then, how they would move toward implementation/code

It should also produce strong follow-up support for prompts like:

- `why this approach?`
- `what are the tradeoffs?`
- `what if traffic spikes 10x?`
- `what if one dependency goes down?`
- `what would you monitor first?`

## Real-World Edge Cases To Support

- interviewer and candidate overlap in speech
- partial STT fragments that later become one question
- repeated short pushbacks (`why?`, `what if?`, `scale?`)
- a tangent inside a technical thread followed by return
- a return to an old thread after several minutes
- shared vocabulary across unrelated topics
- low-confidence STT with key nouns misheard
- explicit typed override during a live session
- typed override arriving during an active fallback cycle
- malformed Conscious Mode structured output
- latency spikes or provider instability
- no provider / provider degraded / provider rate-limited
- duplicate or revised STT events for the same utterance
- tangent while another thread is already suspended
- return after thread expiry
- two plausible prior contexts with overlapping vocabulary
- low-confidence but high-importance entities such as region names, storage names, or scale numbers misheard by STT

## Testing Strategy

### Unit Tests

- continuity classifier behavior
- suspend/resume/reset state transitions
- confidence threshold routing
- malformed structured response rejection
- fallback policy never suppresses normal answer generation

### Integration Tests

- live technical question -> Conscious Mode success
- live technical question -> Conscious Mode malformed -> normal fallback
- tangent -> suspend -> return -> resume
- tangent during suspended state -> keep only highest-confidence suspended thread
- interruption -> pushback continuation
- hard topic shift -> reset
- typed override during active live thread
- typed override during fallback cycle
- duplicate final transcript event does not retrigger generation
- revised partial transcript updates before final classification
- out-of-order late event does not corrupt active thread
- resume after suspended TTL expiry starts fresh safely
- repeated failures -> session degrade

### Scenario Fixtures

Add transcript fixtures representing realistic interview sessions with:

- tangents
- interruptions
- STT fragmentation
- system design pushback
- long pauses
- return to older topic

### Latency Verification

Verify that fallback to normal mode happens within a bounded realtime budget and does not leave the UI without an answer.

## Validation Metrics

Phase 1 verification should track:

- fallback rate
- empty-render rate
- malformed-structured-response rate
- stale-resume incident rate
- median Conscious generation latency
- median fallback latency
- degraded-session activation rate
- duplicate-trigger suppression rate

## Phased Delivery

### Phase 1

- make Conscious Mode robust for live `What to answer`
- keep typed/manual prompting compatible
- add strong fallback and failure-streak handling
- improve thread suspend/resume/reset behavior

### Phase 2

- refine ambiguity handling with richer confidence tuning
- improve transcript fixture coverage from real-world sessions
- consider whether other assist actions should consume Conscious Mode state

## Open Decisions Locked For This Design

- Conscious Mode applies to live `What to answer` first, not every assist action.
- Typed/manual input remains optional and supported.
- In ambiguous cases, prefer safe fresh answers over risky stale continuation.
- In repeated failure scenarios, reliability wins: degrade gracefully to normal live answers.

## Success Criteria

This design is successful when:

- turning on Conscious Mode reliably changes live technical assistance behavior
- the user does not need to type to benefit from Conscious Mode
- the app continues to generate helpful answers during failures and tangents
- follow-up questions produce strong reasoning-oriented continuations
- unrelated chatter does not poison the active technical context
- the system behaves conservatively under ambiguity instead of hallucinating continuity
- fallback happens within a bounded realtime budget
- failed Conscious cycles do not corrupt stored technical-thread memory
