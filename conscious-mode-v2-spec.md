# Conscious Mode V2 Spec

## Goal
Make `conscious mode` behave like a one-sided interview reasoning system that is more human-like, better grounded, and more accurate than the current transcript-to-answer pipeline, while leaving `standard mode` unchanged.

## Scope
- Conscious mode only
- Interviewer-side transcript only
- No live keyboard feedback requirement
- Reuse profile-mode knowledge assets as the source for semantic memory

## Non-Goals
- No changes to standard mode
- No user-audio capture
- No mandatory live user interaction during interviews
- No heavy new database migration before proving value

## Current State
- Conscious mode already has:
  - route planning
  - thread tracking
  - interviewer reaction classification
  - inferred answer hypothesis memory
  - structured retrieval/state packs
  - rule + LLM verification
  - eval harness
  - session restore continuity
- Biggest remaining gaps:
  - no explicit answer planner before generation
  - no dedicated semantic fact memory seeded from resume/JD/company data
  - no provenance-aware verifier that checks factual grounding source-by-source

## Product Thesis
Real conscious mode should act like this:
1. Understand what the interviewer is really reacting to.
2. Track what the user likely just answered.
3. Pull only the most relevant confirmed facts from resume/JD/company context.
4. Decide the correct answer shape before generation.
5. Reject or downgrade answers that are unsupported, weak, or misaligned.

## Architecture Additions

### 1. ConsciousAnswerPlanner
Purpose: Choose the answer shape before generation.

Planned output:
- `direct_answer`
- `tradeoff_defense`
- `metric_backed_answer`
- `example_answer`
- `clarification_answer`
- `depth_extension`
- `pushback_defense`

Inputs:
- latest interviewer question
- latest interviewer reaction
- active reasoning thread
- latest answer hypothesis
- semantic fact summary

Outputs:
- answer shape
- focal facets
- response length target
- confidence
- planning rationale

### 2. SemanticFactStore
Purpose: Build a runtime memory layer from profile-mode assets.

Sources:
- resume identity
- experience bullets
- projects
- technologies
- JD requirements/keywords/technologies
- company dossier context

Initial storage model:
- in-memory normalized fact entries
- seeded lazily from `KnowledgeOrchestrator.getProfileData()`
- persisted later only if needed

Fact categories:
- `project`
- `experience`
- `metric`
- `technology`
- `requirement`
- `company_context`

### 3. ProvenanceVerifier
Purpose: Verify whether a conscious answer is grounded in confirmed memory.

Checks:
- does answer reuse confirmed facts from semantic memory?
- is answer overcommitting based only on inferred hypothesis?
- does answer mention unsupported technologies/metrics?
- does answer align with the requested answer shape?

Verifier stack:
1. rule verifier
2. provenance verifier
3. optional LLM judge

## Data Flow

```text
Interviewer turn
-> QuestionReactionClassifier
-> AnswerHypothesisStore
-> SemanticFactStore query
-> ConsciousAnswerPlanner
-> ConsciousRetrievalOrchestrator
-> Generator
-> ProvenanceVerifier
-> ConsciousVerifierLLM
-> Suggestion
```

## Phase Plan

### Phase 1: Planner
- Add `ConsciousAnswerPlanner`
- Thread planner output into conscious prompts only
- Add focused tests for answer-shape selection

### Phase 2: Semantic Memory
- Add `ConsciousSemanticFactStore`
- Seed from `KnowledgeOrchestrator.getProfileData()`
- Build compact fact blocks for conscious prompts
- Add tests for normalization and retrieval

### Phase 3: Provenance Verification
- Add `ProvenanceVerifier`
- Check generated conscious answers against semantic facts and inferred state
- Chain before the LLM judge

### Phase 4: Eval Expansion
- Extend `ConsciousEvalHarness`
- Add planner and provenance scenarios
- Add live-vs-rule comparison mode

## Risks
- Overfitting prompts to synthetic planner labels
- Pulling too much profile data into conscious prompts
- Treating inferred answer state as confirmed truth
- Latency regression if semantic memory hydration is too heavy

## Safety Rules
- Semantic memory facts must be tagged as confirmed profile/company data
- Answer hypothesis remains inferred and lower trust than semantic facts
- Planner and semantic memory must only activate in conscious mode
- Standard mode must remain behaviorally unchanged

## Success Metrics
- better follow-up relevance
- lower duplicate follow-up answers
- lower unsupported-claim rate
- higher eval pass rate in `npm run eval:conscious`
- no regression in `npm run test:electron`

## Implementation Todo
- [ ] Add `ConsciousAnswerPlanner`
- [ ] Add planner tests and wire planner output into conscious prompts
- [ ] Add `ConsciousSemanticFactStore`
- [ ] Read profile-mode data from `KnowledgeOrchestrator.getProfileData()`
- [ ] Normalize projects/experience/metrics/technologies/company context into semantic facts
- [ ] Add semantic fact retrieval block to conscious preparation only
- [ ] Add `ProvenanceVerifier`
- [ ] Chain provenance verifier before `ConsciousVerifierLLM`
- [ ] Extend eval harness with planner/provenance scenarios
- [ ] Run `npm run typecheck`
- [ ] Run `npm run test:electron`
- [ ] Run `npm run eval:conscious`

## Done When
- Conscious mode chooses answer shape deliberately before generation.
- Conscious mode retrieves compact, relevant semantic facts from profile-mode assets.
- Conscious mode rejects unsupported specifics before they are shown.
- All checks pass and standard mode behavior remains untouched.
