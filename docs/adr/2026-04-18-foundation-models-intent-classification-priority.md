# ADR-2026-04-18: Prioritize Apple Foundation Models for Intent Classification in Acceleration Mode

## Status

Accepted

## Context

The app currently classifies interviewer intent (behavioral, coding, deep_dive, general, etc.) using a three-tier path in `electron/llm/IntentClassifier.ts`:

1. Regex fast path (`detectIntentByPattern`)
2. Local zero-shot model (MobileBERT MNLI)
3. Context heuristic fallback

In real STT traffic, regex-first routing is brittle and can misclassify questions that are semantically clear to a model but lexically noisy or phrased unexpectedly. This affects conscious-mode prompt selection and final answer quality.

The product direction is to use Apple Silicon on-device capabilities first when acceleration mode is enabled. Apple’s Foundation Models framework is now available on supported Apple Intelligence devices and provides on-device language inference via `SystemLanguageModel` + `LanguageModelSession`.

Requirements from product direction:

- In acceleration mode on supported macOS Apple Silicon, Foundation Models must be highest-priority classifier.
- On refusal, transient failure, or rate limiting, retry with exponential backoff.
- After retry budget is exhausted, fallback to current defaults.
- Windows behavior must remain unchanged.

## Decision Drivers

- Improve intent classification accuracy on real STT transcripts.
- Use on-device Apple capabilities first on supported machines.
- Keep latency acceptable through preclassification and caching.
- Preserve current cross-platform behavior and reliability via fallback chain.
- Avoid regressions in conscious-mode routing and verifier flow.

## Considered Options

### Option 1: Keep current regex+MobileBERT pipeline only

- Pros: no new platform bridge, low implementation effort.
- Cons: known misclassification risk persists; does not satisfy Apple-first requirement.

### Option 2: Replace with cloud LLM classification

- Pros: potentially high semantic quality.
- Cons: violates on-device-first direction, adds network dependency, latency variability, key management, privacy concerns.

### Option 3: Add Apple Foundation Models provider as highest-priority classifier in acceleration mode, with fallback to existing pipeline

- Pros: satisfies product direction, improves semantic inference on supported devices, preserves fallback reliability and Windows parity.
- Cons: requires Swift helper integration + capability checks + refusal/retry handling.

## Decision

Adopt Option 3.

Implement a provider-based intent classification pipeline where Foundation Models is the first classifier only when all of the following are true:

- `accelerationEnabled` is true
- `process.platform === 'darwin' && process.arch === 'arm64'`
- Foundation model availability is confirmed at runtime

Classification path in that case:

1. Foundation Models classifier (primary)
2. Exponential backoff retries for transient failure/refusal/rate-limit
3. Existing classifier stack as fallback (regex -> MobileBERT -> context heuristic)

On Windows and non-eligible macOS environments, retain existing behavior.

## Consequences

### Positive

- Better intent inference for noisy STT phrasing in acceleration mode on supported Apple hardware.
- Aligns with Apple Silicon-first acceleration strategy.
- Maintains reliability through fallback chain.
- Enables intent preclassification reuse in conscious flow.

### Negative

- Introduces cross-language integration (TypeScript <-> Swift helper).
- Requires robust error taxonomy and retry policy tuning.
- Must handle Foundation guardrails/refusals deterministically.

### Risks and Mitigations

- **Risk:** Foundation model unavailable despite eligible hardware.
  - **Mitigation:** runtime availability checks + immediate fallback.
- **Risk:** retries inflate latency.
  - **Mitigation:** bounded retries, short jittered backoff, preclassification during silence.
- **Risk:** helper process instability.
  - **Mitigation:** health checks, timeout guards, circuit breaker, fallback.
- **Risk:** output schema drift from helper.
  - **Mitigation:** strict JSON envelope validation and contract tests.

## Scope Boundaries

In scope:

- Intent classification for conscious pipeline and acceleration preclassification.
- Provider abstraction + Apple primary provider + fallback chain.

Out of scope:

- Replacing answer-generation model providers.
- Changing Windows classifier behavior.
- Redesigning conscious route heuristics unrelated to intent provider selection.

## Runtime Policy

- Foundation Models is preferred only when acceleration mode is active.
- On refusal/transient/rate-limit errors, apply bounded exponential backoff.
- If retry budget is exhausted, mark provider degraded and use fallback classifier.
- Recover provider periodically (cooldown probe) without blocking request path.

## Acceptance Criteria

1. On eligible macOS acceleration mode, primary classifier path uses Foundation provider first.
2. On Windows, classifier behavior remains current default path.
3. On Foundation refusal/transient errors, retries follow configured exponential backoff and then fallback cleanly.
4. Conscious flow continues using same routing/planner/verifier architecture with improved intent input.
5. Unit/integration tests cover selection, retry, fallback, and platform gating.

## Related Code Areas

- `electron/llm/IntentClassifier.ts`
- `electron/conscious/ConsciousAccelerationOrchestrator.ts`
- `electron/IntelligenceEngine.ts`
- `electron/services/AccelerationManager.ts`
- `electron/config/optimizations.ts`

## References

- Apple Foundation Models root: `https://developer.apple.com/documentation/FoundationModels`
- Apple docs JSON endpoint used for analysis: `https://developer.apple.com/tutorials/data/documentation/foundationmodels.json`
- `SystemLanguageModel` overview + availability checks
- `LanguageModelSession.respond(...)` and `streamResponse(...)`
- `SystemLanguageModel.contextSize`

## Operational Notes

- Intent evaluation runner: `npm run eval:intent`
- Intent multi-run evaluation runner: `npm run eval:intent:multi -- --provider=coordinated --runs=20`
- Generate 100+ noisy/paraphrase cases: `npm run eval:intent:generate-variants`
- Run multi-eval on generated dataset:
  - `npm run eval:intent:multi -- --provider=coordinated --runs=20 --dataset=electron/evals/intentEvalVariants.generated.json`
  - `npm run eval:intent:multi -- --provider=foundation --runs=20 --dataset=electron/evals/intentEvalVariants.generated.json`
  - `npm run eval:intent:multi -- --provider=legacy --runs=20 --dataset=electron/evals/intentEvalVariants.generated.json`
- Provider mode overrides for evaluation:
  - `node scripts/run-intent-eval.js --provider=coordinated` (default)
  - `node scripts/run-intent-eval.js --provider=foundation`
  - `node scripts/run-intent-eval.js --provider=legacy`
  - `INTENT_EVAL_DISABLE_FOUNDATION=1 node scripts/run-intent-eval.js --provider=coordinated`
