# Low-Latency Answer Pipeline Design

Date: 2026-03-23
Status: Draft
Owner: OpenCode

## Goal

Make Natively feel as fast as possible, with primary emphasis on time-to-first-token for answer generation, while preserving existing behavior and keeping the solution provider-agnostic across API-key, local, and cURL/custom providers.

## Non-Negotiable Constraints

- Do not regress working features.
- Prefer small, verifiable changes over broad rewrites.
- Keep the optimization independent of provider-specific assumptions.
- Preserve current correctness for Conscious Mode, Profile/Knowledge Mode, manual answers, follow-up refinement, and custom/cURL providers.
- Add instrumentation and tests before or alongside behavior changes.

## Problem Statement

The current architecture mixes two kinds of work in the same critical path:

1. work required to start answering immediately
2. work that improves answer quality but is not required before the first token

This coupling causes visible lag even when "acceleration mode" is enabled, because many acceleration features do not affect the true answer hot path.

## Current Evidence

### Observed Hot-Path Issues

- `runWhatShouldISay()` performs blocking preprocessing before the stream starts.
- `classifyIntent()` has been on the critical path for standard answer generation.
- temporal context shaping can run before streaming.
- knowledge/profile enrichment can add overhead before answer generation.
- several acceleration modules exist, but many are not wired into the first-token path.

### Architectural Mismatch

Current "acceleration mode" mostly improves infrastructure such as embeddings, context helpers, or other optional systems. It does not consistently optimize the step users perceive most strongly: how quickly the first visible answer token appears.

## Design Principles

### 1. First Token Is a Separate Product Requirement

The system should explicitly optimize for first-token latency, not assume that general optimization features will indirectly improve it.

### 2. Keep the Hot Path Minimal

Only work that is strictly required to begin a safe, relevant answer should happen before the first token.

### 3. Defer Intelligence, Do Not Delete It

Intent classification, temporal shaping, profile enrichment, and similar features should move off the critical path when possible rather than being removed outright.

### 4. Provider-Agnostic Orchestration

The main performance wins should come from local orchestration improvements, not provider-specific shortcuts.

### 5. Every Optimization Must Be Measured

Latency changes must be paired with instrumentation and regression coverage.

## Proposed Architecture

## Layer 1: Route Selection

Introduce explicit internal answer routes:

- `fast_standard_answer`
- `enriched_standard_answer`
- `conscious_answer`
- `manual_answer`
- `follow_up_refinement`

The router selects the cheapest safe path for the request.

### Deterministic Route Contract

Route selection must be deterministic and based only on cheap, local signals available before any expensive preprocessing.

#### Inputs

- active mode flags
- conscious mode enabled/disabled
- profile mode enabled/disabled
- whether an active profile/resume exists
- presence of explicit user/manual invocation
- whether the request is a follow-up refinement
- latest interviewer turn text
- transcript revision number
- provider capability class

#### Route Decision Table

| Condition | Route |
|---|---|
| Manual answer explicitly invoked | `manual_answer` |
| Follow-up refinement explicitly invoked | `follow_up_refinement` |
| Conscious Mode enabled and `classifyConsciousModeQuestion(latestQuestion, activeThread)` returns `qualifies: true` | `conscious_answer` |
| Profile mode enabled and request matches a strict profile-required heuristic | `enriched_standard_answer` |
| Knowledge mode data available and request matches a strict knowledge-required heuristic | `enriched_standard_answer` |
| Otherwise standard answer request | `fast_standard_answer` |

#### Decision Order

The router must evaluate routes in this exact order:

1. manual answer
2. follow-up refinement
3. conscious answer
4. profile-required enriched answer
5. knowledge-required enriched answer
6. fast standard answer

The first matching rule wins.

#### Strict Profile-Required Heuristics

The enriched route is required only when the latest question clearly asks for user-specific/profile-specific content. Initial implementation should keep this heuristic conservative.

For v1, this heuristic must be implemented as a deterministic normalized phrase matcher.

#### Normalization Rules

- lowercase the latest interviewer turn
- trim leading/trailing whitespace
- collapse repeated internal whitespace to a single space
- strip punctuation other than apostrophes inside words

#### Match Contract

Route to `enriched_standard_answer` only if the normalized question contains at least one of the following phrases:

- `tell me about yourself`
- `walk me through your background`
- `walk me through your resume`
- `tell me about your background`
- `why are you a fit for this role`
- `why are you a good fit for this role`
- `why do you think you are a fit for this role`
- `tell me about a project you worked on`
- `tell me about a project you've worked on`
- `tell me about your experience with`

Additionally, route to `enriched_standard_answer` for the phrase `what experience do you have with` only when the normalized question also contains one of these user-history qualifiers:

- `in your background`
- `from your resume`
- `in your past work`
- `in your previous role`
- `in your past experience`

Do not treat bare `have you worked with` or bare `have you used` as enriched-route triggers in v1.

#### Precedence Rule

- manual answer and follow-up refinement routes always take precedence
- conscious mode route takes precedence over profile-required routing
- profile-required routing only applies to standard answer requests after those higher-priority routes are excluded

#### Explicit Non-Matches

The following should remain on `fast_standard_answer` unless another higher-priority route applies:

- `how would you design`
- `how would you implement`
- `what are the tradeoffs`
- `what happens if`
- `how does this scale`
- `what is the complexity`
- `how would you test this`
- `have you used`
- `have you worked with`
- `what experience do you have with redis`
- `what experience do you have with rate limiting`

Examples that require enriched routing:

- "Tell me about yourself"
- "Walk me through your background"
- "Why are you a fit for this role?"
- "Tell me about a project you worked on"
- "What experience do you have with X in your previous role?"

Examples that should remain on fast standard routing even when profile mode is globally enabled:

- system design questions
- coding questions
- tradeoff questions
- architecture questions without profile-specific asks

#### Strict Knowledge-Required Heuristics

For v1, knowledge-required routing must also use a deterministic normalized phrase matcher.

Route to `enriched_standard_answer` when an active knowledge/profile dataset exists and the normalized latest question contains at least one of the following phrases:

- `why this company`
- `why do you want to work here`
- `why do you want to join`
- `what do you know about our company`
- `what do you know about us`
- `why this role`
- `why this team`
- `why are you interested in this role`

Additionally, route to `enriched_standard_answer` when the normalized latest question contains one of these company/team qualifiers:

- `our company`
- `our team`
- `this company`
- `this team`
- `this role`

and also contains one of these knowledge-seeking stems:

- `why`
- `what do you know`
- `how would you fit`
- `how do you align`

#### Knowledge Routing Precedence

- conscious mode route still takes precedence
- profile-required and knowledge-required routing both resolve to `enriched_standard_answer`
- if both profile-required and knowledge-required match, the route remains `enriched_standard_answer`
- if neither deterministic matcher triggers, the request stays on `fast_standard_answer`

#### Conscious Mode Compatibility

Conscious Mode route selection must not depend on the slow synchronous intent classifier. It should continue to rely on the existing lightweight qualification logic already used for Conscious Mode routing. Any richer intent signal becomes optional enrichment, not a gating dependency.

For v1, the routing contract must call `classifyConsciousModeQuestion(resolvedQuestion, activeReasoningThread)` directly, without requiring `intentResult` as an input to route selection.

### Routing Rules

- Use `fast_standard_answer` for normal "what should I say" requests when Conscious Mode is off and no hard dependency on profile/knowledge context exists.
- Use `conscious_answer` for Conscious Mode.
- Use `enriched_standard_answer` when knowledge/profile context is required for correctness.
- Keep `manual_answer` and `follow_up_refinement` behaviorally unchanged at first.

This makes the latency tradeoff explicit instead of hidden inside one overloaded path.

## Layer 2: Minimal First-Token Pipeline

The `fast_standard_answer` route should do only the following before streaming starts:

1. read the latest interviewer turn
2. construct a minimal transcript snapshot
3. select a compact provider-neutral prompt shell
4. apply provider-specific wrapping only as needed
5. start the provider stream immediately

### Explicitly Excluded From This Hot Path

- blocking intent classification
- temporal context construction
- profile/knowledge retrieval and assembly
- worker-thread context assembly
- adaptive context window selection
- prefetching logic
- additional response validation passes before stream start

## Layer 3: Deferred Enrichment Pipeline

Work that improves quality but is not required for the first token moves here.

### Deferred Tasks

- intent classification
- temporal context shaping
- profile/knowledge augmentation
- adaptive context selection
- predictive prefetch population
- optional analytics and diagnostics

### Usage of Deferred Results

Deferred outputs should influence:

- subsequent answers
- future follow-ups
- optional richer secondary passes

They should not delay the current first token unless the selected route explicitly requires them.

### Concurrency and Isolation Rules

Deferred enrichment must be isolated per request so background work never contaminates the wrong answer.

#### Required Mechanisms

- assign a unique request ID to every answer generation attempt
- bind each deferred task to the request ID and transcript revision number used at launch
- discard deferred outputs if the active transcript revision has changed
- discard deferred outputs if a newer answer request has superseded the current one
- cancel or ignore background enrichment once the request becomes stale

#### Allowed Effects of Deferred Outputs

Deferred results may affect:

- future answer requests
- future follow-up routing
- future cache population

Deferred results may not:

- rewrite the already-started answer stream in-place during initial implementation
- mutate session state for a request that is no longer current
- attach profile/context data to the wrong request

## Prompt Strategy

Define a dedicated low-latency prompt family for fast answer starts.

### Requirements

- compact
- provider-neutral in semantics
- preserves anti-dump behavior
- preserves relevance and completeness
- optimized for fast answer starts, not exhaustive guidance

### Prompt Families

- `fast_standard_prompt`
- existing richer prompts for conscious/profile/follow-up flows

This avoids rebuilding large enriched prompts on every normal request.

## Provider Capability Model

The design must work across providers with different delivery behavior.

### Capability Classes

- `streaming`: true token/chunk streaming
- `buffered`: provider or wrapper delivers chunks late or in coarse batches
- `non_streaming`: full response arrives only after completion

### Fast-Path Semantics by Capability

- `streaming`: optimize true time-to-first-token
- `buffered`: optimize time-to-first-visible-chunk
- `non_streaming`: optimize time-to-first-byte of provider request plus total time to first visible response by minimizing local pre-request work

### Required Behavior

- route selection must not assume true streaming exists
- cancellation must behave safely for all capability classes
- telemetry must record provider capability class alongside latency metrics
- custom/cURL providers must be classified explicitly rather than treated as implicitly streaming

## Caching Strategy

Cache only provider-independent artifacts that are cheap to reuse and low risk.

### Safe Cache Targets

- compact transcript projections
- prompt skeletons
- language-injected prompt variants
- recent context snapshots derived from transcript state
- route-selection prerequisites

### Avoid as a Primary Latency Strategy

- direct final-answer caching

Reason: answer caching risks stale or contextually wrong output and is harder to validate safely.

### Cache Key Rules

Every cache key must include enough scope to prevent cross-request contamination.

#### Prompt Skeleton Cache Key

- route name
- provider family
- capability class
- language setting
- prompt version

#### Transcript Snapshot Cache Key

- session identifier
- transcript revision number
- route name
- snapshot type

#### Context Snapshot Cache Key

- session identifier
- transcript revision number
- route name
- profile mode state
- conscious mode state

### Invalidation Rules

Invalidate relevant cache entries when any of the following change:

- transcript revision changes
- active provider changes
- language changes
- profile mode toggles
- conscious mode toggles
- prompt version changes
- session resets or meeting changes

### Bounds

- use small bounded in-memory caches only
- no unbounded per-session growth
- each cache must define TTL and max-entry policy

## Knowledge/Profile Mode Strategy

Profile/knowledge mode should remain correct but stop unnecessarily blocking standard first-token response.

### Rule

- If profile context is required for correctness, use `enriched_standard_answer`.
- Otherwise, do not block the first token on profile/knowledge augmentation.

### Examples

- "Tell me about yourself" with active resume context may require enriched routing.
- "How would you design a rate limiter?" should usually stay on the fast standard route even if profile mode is enabled globally.

This preserves correctness while avoiding unnecessary delays.

## Acceleration Mode Redefinition

Acceleration mode should explicitly mean "optimize the real answer hot path" rather than "enable unrelated optimization features."

### Updated Meaning

When enabled, acceleration mode should prioritize:

- fast route selection
- hot-path prompt reuse
- zero-blocking-first-token behavior for eligible standard requests
- minimal synchronous preprocessing

Existing infrastructure optimizations may still remain enabled, but they should no longer define the user-facing meaning of acceleration mode.

## Instrumentation Plan

Add structured latency spans for each answer request.

### Required Measurements

- request received
- route selected
- minimal transcript prepared
- prompt prepared
- provider request started
- first token received
- stream completed

### Optional Measurements

- intent classification started/completed
- temporal enrichment started/completed
- profile enrichment started/completed

### Output Requirements

- lightweight logs only
- no raw transcript persistence for metrics
- comparable before/after timing data for each route

## Testing Strategy

## Behavioral Regression Tests

- fast path skips non-essential blocking work
- Conscious Mode unchanged
- follow-up refinement unchanged
- manual answer unchanged
- custom/cURL provider path unchanged
- profile/knowledge-required requests still use enriched routing
- route selection remains deterministic for the same input snapshot

## Latency-Oriented Contract Tests

These should verify call ordering and route behavior rather than brittle wall-clock deadlines.

Examples:

- intent classifier is not awaited for fast standard path
- temporal context builder is not required before stream start on fast standard path
- provider stream starts with minimal snapshot on fast path

## Provider Matrix Tests

- cloud/API-key provider path
- local provider path
- custom/cURL provider path
- non-streaming custom provider path

## Session and Concurrency Tests

- stale deferred tasks are discarded after transcript revision changes
- stale deferred tasks are discarded after a newer request starts
- cancellation does not corrupt session state
- telemetry entries remain attached to the correct request ID

## Route Golden Tests

- conscious routing golden cases
- profile-required routing golden cases
- fast standard routing golden cases
- follow-up/manual routing golden cases

## Runtime Validation

Compare route timing metrics before and after each small change.

### Measurable Acceptance Rules

- standard fast-route requests must show lower median pre-stream local latency than the baseline captured before optimization
- improvement claims must be based on route-level timing data, not anecdotal feel alone
- if a change does not reduce measured local pre-stream latency or causes behavioral regressions, it must not proceed

## Incremental Implementation Phases

### Phase 1: Observability

- add answer-path timing instrumentation
- establish baseline metrics
- add route-aware logging

### Phase 2: Fast Standard Route

- formalize `fast_standard_answer`
- keep it minimal and provider-agnostic
- protect with narrow tests

### Phase 3: Prompt and Snapshot Reuse

- cache compact prompt artifacts
- cache transcript projections
- reduce repeated prompt assembly cost

### Phase 4: Deferred Enrichment

- move knowledge/profile/intelligence helpers off the critical path where safe
- preserve enriched routing where correctness depends on it

### Phase 5: Expand Carefully to Other Modes

- review assist/manual/follow-up flows separately
- only optimize them after standard answer path is stable and measured

## Risks and Mitigations

### Risk: Quality drops on standard answers

Mitigation:

- use a dedicated fast prompt, not an underspecified prompt
- keep enriched route available for correctness-sensitive cases
- add regression coverage for answer shape and relevance

### Risk: Profile mode becomes inconsistent

Mitigation:

- route explicitly based on whether profile context is required
- do not globally bypass knowledge enrichment

### Risk: Optimization flags become confusing

Mitigation:

- make route names explicit
- bind acceleration mode to actual first-token improvements
- measure route-level behavior directly

### Risk: Provider-specific edge cases leak into shared logic

Mitigation:

- keep performance improvements in shared orchestration layer
- leave provider execution contracts intact

## Explicit Non-Goals

- rewriting all modes at once
- relying on one provider as the performance solution
- large-scale answer caching as the primary speed strategy
- changing existing rich modes before measurement proves need

## Success Criteria

- standard answer requests show reduced pre-stream local latency against the baseline for the same route/provider capability class
- acceleration mode produces a real user-visible first-token improvement
- no regression in Conscious Mode, follow-up refinement, manual answers, or custom/cURL providers
- timing logs clearly show reduced pre-stream blocking work
- changes land in small, test-backed increments

## Recommendation

Proceed with an orchestration-first redesign:

1. measure the current hot path precisely
2. create an explicit fast standard route
3. move optional intelligence off the first-token critical path
4. reuse prompt and transcript artifacts
5. verify each change with regression and latency contract tests

This approach is the strongest fit for the user goal of "as fast as possible" while still prioritizing robustness, provider independence, and zero-regression discipline.
