# Foundation Intent And Conscious Mode Plan

## Goal
Raise the quality ceiling of the Foundation Models intent path already wired into this repo by making confidence measurable, actionable, and useful across intent classification, acceleration, and conscious-mode routing.

## Assumptions
- The existing Foundation helper, coordinator, packaging, and macOS gating remain in place.
- Windows and non-eligible macOS hosts must keep the current legacy behavior.
- The next phase should optimize quality and routing, not replace the current architecture.
- We only take on a persistent helper/session model if new measurements prove spawn cost is the real latency bottleneck.
- Compatibility boundary: latest release tag `v2.0.6`; the Foundation intent path and conscious-mode internals are branch-local implementation surfaces, so we should rewrite them directly instead of adding shims.

## Approach Options
- Recommended: docs-first measured hardening. Keep the current helper/coordinator architecture, add evals, tighten guided generation, calibrate confidence, and only then push confidence into acceleration and conscious routing.
- Alternative: latency-first helper/session rewrite. Build a persistent helper before measuring quality. This is higher risk because it can hide classification problems under infrastructure churn.
- Alternative: heuristic-heavy fallback. Add more regex/rule overrides in TypeScript first. This is fast, but it drifts away from Apple’s guided-generation strengths and becomes harder to maintain.

## Apple-Guided Rules
- Keep the hot-path schema tiny: intent label plus confidence, with `@Guide(..., .anyOf([...]))` and no extra free-form fields unless the eval proves they help.
- Keep `includeSchemaInPrompt` enabled for one-shot structured classification.
- Use deterministic or near-deterministic decoding for classification, not creative sampling.
- Use app-side branching instead of large conditional prompts, especially in conscious mode.
- Keep classification sessions isolated and short-lived unless latency data proves session reuse is worth the complexity.
- Treat `availability`, `supportsLocale`, and default guardrails as part of correctness, not optional polish.
- Version prompts and schemas like product assets, and re-run evals on every prompt change.

## Tickets
- [ ] `INT-101` Build intent eval corpus and runner in `electron/evals/intentClassificationEval.ts` plus fixtures for all 8 intents, ambiguous turns, transcript-dependent follow-ups, and adversarial paraphrases. Depends on: none. → Verify: one command prints provider split, per-intent accuracy, confusion matrix, fallback rate, and confidence buckets.
- [ ] `INT-102` Tighten guided generation and the confidence contract across `applesilicon/macos-foundation-intent-helper/Sources/main.swift`, `electron/llm/providers/FoundationModelsIntentProvider.ts`, and `electron/llm/providers/IntentClassificationCoordinator.ts` so the helper uses tiny constrained schemas, deterministic decoding, and low-confidence, contradictory, or transcript-incompatible Foundation results fall back to legacy before downstream routing. Depends on: `INT-101`. → Verify: tests cover low-confidence fallback, contradiction fallback, retry exhaustion, decoding stability, and unchanged legacy behavior on non-eligible hosts.
- [ ] `INT-103` Add intent-quality telemetry in `electron/IntelligenceEngine.ts` and `electron/latency/AnswerLatencyTracker.ts` for `intentConfidence`, `intentProviderUsed`, `intentRetryCount`, `intentFallbackReason`, `prefetchedIntentUsed`, and route outcome metadata. Depends on: `INT-102`. → Verify: latency snapshots carry the new fields and logs never include raw transcript payloads.
- [x] `INT-105` Add Apple availability/locale/guardrail preflight in `applesilicon/macos-foundation-intent-helper/Sources/main.swift` and `electron/llm/providers/FoundationModelsIntentProvider.ts` so helper failures distinguish `modelNotReady`, unsupported locale, and other non-eligible states using Apple’s recommended checks. Depends on: `INT-102`. → Verify: typed helper/provider errors cover unavailable model, unsupported locale, and transient readiness states without weakening default guardrails.
- [x] `INT-106` Extract Foundation prompt and schema versions into explicit prompt assets/constants for the helper and eval runner so prompt revisions are named, reviewable, and testable against saved fixtures. Depends on: `INT-101`, `INT-102`. → Verify: the eval output includes prompt/schema version identifiers and prompt edits do not require hunting through unrelated code paths.
- [ ] `ACC-201` Gate acceleration spend in `electron/conscious/ConsciousAccelerationOrchestrator.ts` and `electron/services/AccelerationManager.ts` so prefetched intent is revision-fresh and only starts speculative answer work when confidence and intent type justify the cost. Depends on: `INT-102`, `INT-103`. → Verify: tests show stale prefetched intents are dropped and weak/general predictions do not unlock speculative answer generation.
- [ ] `CNS-301` Thread intent confidence through `electron/conscious/ConsciousIntentService.ts`, `electron/conscious/ConsciousPreparationCoordinator.ts`, `electron/conscious/ConsciousOrchestrator.ts`, and `electron/conscious/ConsciousAnswerPlanner.ts` so conscious mode is favored for strong behavioral/system-design/live-coding turns, uses programmatic mode-specific branching instead of wider prompt branching, and downgrades on weak or uncertain signals. Depends on: `INT-102`, `INT-106`. → Verify: route tests show deterministic downgrade from `conscious_answer` on uncertain turns and stable continuation on strong thread-compatible turns.
- [ ] `CNS-302` Expand conscious replay and verifier coverage in `electron/conscious/ConsciousEvalHarness.ts`, `electron/conscious/ConsciousVerifier.ts`, `electron/conscious/ConsciousProvenanceVerifier.ts`, `electron/conscious/QuestionReactionClassifier.ts`, and `electron/conscious/AnswerHypothesisStore.ts` for behavioral STAR depth, topic shifts, unsupported metric claims, unsupported technology claims, and coding/system-design continuation cases. Depends on: `CNS-301`. → Verify: harness summaries break down pass/fail by scenario family and catch known bad continuations.
- [ ] `INT-104` Run a latency spike on the Foundation helper path and prototype a persistent session model only if the data shows helper startup dominates p95 or first-token time. Target: `applesilicon/macos-foundation-intent-helper/Sources/main.swift` and the TS helper client path. Depends on: `INT-103`. → Verify: benchmark comparison clearly shows whether session reuse materially improves p95 before we accept the complexity.
- [ ] `REL-401` Re-run the verification stack with `npm run typecheck`, targeted intent/coordinator tests, conscious harnesses, and the new intent eval runner; compare Foundation-only, legacy-only, and coordinated results before rollout. Depends on: `INT-102`, `INT-105`, `INT-106`, `ACC-201`, `CNS-302`, and `INT-104` if that spike is pursued. → Verify: the coordinated path matches or beats the current legacy baseline on the labeled set, locale/availability handling is exercised, and conscious regressions are visible before shipping.

## Recommended Order
- [ ] Start with `INT-101` and `INT-102` because every later routing decision depends on measured quality, not intuition.
- [ ] Land `INT-105` and `INT-106` before deeper routing work so Apple-guided availability checks and prompt/schema discipline are locked in early.
- [ ] Do `INT-103` before acceleration/conscious changes so we can see whether the new policy is helping or hiding failures.
- [ ] Land `ACC-201` before `CNS-301` because acceleration should stop spending on low-value predictions first.
- [ ] Treat `INT-104` as an evidence-gated spike, not committed roadmap work.
- [ ] Leave `REL-401` as the final gate only after the eval, routing, and verifier changes are in place.

## Done When
- [ ] Intent quality is measured in-repo with repeatable fixtures, not anecdotal spot checks.
- [ ] Foundation-first classification is confidence-aware and keeps combined quality at or above the current legacy baseline.
- [ ] Speculative acceleration only spends compute on fresh, high-value predictions.
- [ ] Conscious mode gets stronger route gating, stronger replay/verifier coverage, and cleaner fallback behavior on uncertain turns.
