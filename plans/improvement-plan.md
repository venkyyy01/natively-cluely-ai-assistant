# Foundation Models Improvement Plan

> **Scope**: How Apple Foundation Models is wired today, where it under-delivers, and a tiered plan to maximize accuracy, relevance, and correctness across intent classification, conscious mode, acceleration, and answer generation.
>
> **Compatibility boundary**: macOS 26+ on Apple Silicon. Windows and non-eligible macOS hosts must keep current legacy behavior.

---

## 1. Current Architecture Snapshot

Foundation Models is **only** used for intent classification, and even there it is the *fallback*, not the primary, on the hot path.

### Three layers wrapping the Apple helper

**Layer A — `IntentClassificationCoordinator`** (`electron/IntelligenceEngine.ts:195-207`)
- Primary: `SetFitIntentProvider` (~10–30 ms, Python subprocess + Xenova fallback)
- Fallback: `FoundationModelsIntentProvider` (~1–2 s, Swift helper)
- Comment in code says SetFit-first, but `foundation-intent-conscious-plan.md:14` says Foundation-first → contradiction in intent.

**Layer B — `LayeredIntentRouter`** (`electron/llm/LayeredIntentRouter.ts:147-269`)
- Hot path used by acceleration prefetch and (via `routeFast`) the orchestrator's prepareRoute.
- Runs SetFit + SLM + Regex + Embedding **in parallel**, decides via `resolveEnsemble` (`LayeredIntentRouter.ts:513-619`).
- Apple is invoked only as **Layer 2 rescue** with a hard 500 ms timeout — too short for the multi-stage pipeline (~700–1500 ms).
- Net: Apple sees roughly only the disagreement / low-confidence tail (~10–20 % of turns).

**Layer C — Swift helper** (`applesilicon/macos-foundation-intent-helper/Sources/main.swift:1053-1126`)
- Multi-stage classification: family → profile-specific → optional pairwise disambiguation.
- Each stage uses `@Generable` + `.anyOf(...)` + `temperature: 0` + `includeSchemaInPrompt: true`.
- Locale + availability preflight (`main.swift:373-392`).
- Heuristic confidence calibration + cue-based reconciliation in Swift (`main.swift:549-610`, `699-764`).
- Persistent helper mode wired but gated by `NATIVELY_FOUNDATION_PERSISTENT` env var (off by default).

### Calibration plumbing
- `intent_confidence_v1` (`electron/llm/intentConfidenceCalibration.ts:6`)
- Pipeline floors: `slmMinAcceptScore: 0.55`, `primaryMinConfidence: 0.82`
- Per-intent: flat `minReliableConfidence: 0.72`, `strongMinConfidence: 0.84` for STRONG_CONSCIOUS_INTENTS, `1.0` for `general`.

### What Foundation Models is **not** used for today
- Answer generation (`LLMHelper.streamChat`, `streamChatWithGemini`, `generateSpeculativeFastAnswerStream`)
- Verifier judging (`ConsciousVerifierLLM` → cloud `generateContentStructured` → OpenAI/Claude/Gemini Pro)
- Screenshot / Visual Intelligence reasoning
- Question quality gating
- Context summarization in `ConsciousPreparationCoordinator`
- Streaming intent (uses `session.respond` not `session.streamResponse`)

---

## 2. Strengths to preserve

- **Apple-aligned guided generation**: narrow `@Generable` + `.anyOf` + `temperature: 0` is correct.
- **Confidence as a first-class concept**: versioned via `INTENT_CONFIDENCE_CALIBRATION_VERSION`; threaded through routing decisions.
- **Hybrid ensemble defense**: SetFit/SLM/Regex/Embedding cover blind spots and cap latency.
- **Multi-stage label narrowing**: family → profile → pairwise empirically helps token-constrained decoding.
- **Eval harness exists**: `electron/evals/intentClassificationEval.ts` with versioned prompt/schema assets.
- **Persistent helper mode wired**: requestId envelope dispatch (`FoundationModelsIntentProvider.runPersistentHelperBinary`).
- **Apple availability/locale gates as typed errors**: clean fallback semantics.

---

## 3. Gaps and Pain Points

### G1 — Foundation Models is invisible on the answer path *(highest leverage)*
`generateContentStructured` (`electron/LLMHelper.ts:1750-1786`) routes OpenAI → Claude → Gemini Pro, never Apple. Conscious-mode verifier, knowledge mode, and screenshot routing all go through this path. The streaming answer path (`streamChat` and `streamChatWithGemini`) and the speculative answer executor (`IntelligenceEngine.ts:237-244`) ignore Apple. Every answer round-trips to a cloud provider on a host that has a free, private, sub-200 ms TTFT model idle.

### G2 — Apple is the wrong primary in `IntentClassificationCoordinator`
Coordinator uses SetFit primary, Apple fallback (`IntelligenceEngine.ts:200-207`). LayeredIntentRouter further demotes Apple by giving SetFit/SLM "model authority" (`LayeredIntentRouter.ts:519-545`). Apple — the most accurate classifier on the box — runs on roughly 10–20 % of turns.

### G3 — `includeSchemaInPrompt: true` × multi-stage = high latency
Three sequential stages × full schema text in prompt → 3 round-trips per classification. After the first hit, schema text is redundant (decoding is constrained anyway). Sessions are recreated per stage; Apple recommends session reuse for related turns.

### G4 — No `Adapter` (LoRA) fine-tuning
The intent labels are domain-specific (interview coaching). The eval harness already has labeled fixtures. A LoRA adapter would crush the disambiguation-pair errors that the pairwise tracks paper over (`main.swift:907-1050`), and collapse the family→profile→pairwise pipeline to one shot.

### G5 — No `@Tool` use for grounded verification
`ConsciousVerifierLLM.judge` (`electron/conscious/ConsciousVerifierLLM.ts:55-68`) stuffs hypothesis / evidence / response JSON into one giant prompt. Tool calling lets Apple request only the evidence it needs (`lookupHypothesis`, `lookupEvidenceFor`, `lookupSemanticFact`) → higher accuracy, fewer refusals, smaller prompt.

### G6 — Streaming + speculative decoding ignored
Helper uses `session.respond(...)`, not `session.streamResponse(...)`. For the answer path, Apple-streamed short answers could race against cloud (Apple wins on short/fact/behavioral; cloud wins on system-design depth).

### G7 — Calibration is uniform, not per-intent / per-bin
`INTENT_CONFIDENCE_CALIBRATION` (`electron/llm/intentConfidenceCalibration.ts:26-35`) is flat 0.72/0.84 across non-`general` intents. Eval corpus exists but no isotonic / Platt calibration is wired. Routing decisions (`isLowConfidence`, `isContradiction` in `IntentClassificationCoordinator.ts`) are using uncalibrated raw confidence — they're statistically blind.

### G8 — Cue regex duplicated between Swift and TS
`reconcileIntentWithCues` (`main.swift:549-610`) runs the same kind of cue detection as `IntentClassificationCoordinator.inferLikelyIntentFromQuestion` (`IntentClassificationCoordinator.ts:280-330`). Drift is inevitable; the lists have already partially diverged.

### G9 — `model_not_ready` retry policy abandons Apple too aggressively
`isRetryableError` includes `model_not_ready` (`IntentClassificationCoordinator.ts:222-228`). On a fresh boot Apple Intelligence may need 30+ s to download/warm; 2 retries with ~100/200 ms backoff gives up almost immediately, falling back to SetFit forever for the rest of the session. No warmup ping; no adaptive cold-start retry.

### G10 — Persistent helper opt-in, not auto-detected
`NATIVELY_FOUNDATION_PERSISTENT` is opt-in (`FoundationModelsIntentProvider.ts:201`). Spawn cost is consistently 200–400 ms (Swift launch + session bring-up). Plan ticket `INT-104` flagged this as evidence-gated — the evidence supports auto-on for darwin/arm64.

---

## 4. Recommended Tiered Plan

> Each tier is independent. Tier 1 is shippable in <1 day. Tier 2 in 1–3 days. Tier 3 is strategic (≥1 week, requires training/adapter infra).

### Tier 1 — Quick wins (≤1 day, very high ROI, zero accuracy risk)

#### T1.1 — Auto-enable persistent helper on darwin/arm64
- **File**: `electron/llm/providers/FoundationModelsIntentProvider.ts:201`
- **Change**: Default `usePersistentHelper = process.platform === 'darwin' && process.arch === 'arm64'` when the env var is unset.
- **Gain**: ~250 ms p50 reduction per Apple call.
- **Verify**: Existing `FoundationModelsIntentProvider` test suite still green; persistent test path covers the hot path.

#### T1.2 — Warmup helper at app boot
- **Files**: `electron/IntelligenceEngine.ts:213-235` (attach point), `LayeredIntentRouter.warmup()` (`electron/llm/LayeredIntentRouter.ts:133-140`).
- **Change**: After `app.whenReady()`, send a no-op classify (`question: "warmup"`) through the persistent helper. Pre-warms model session and resolves `modelNotReady` before the first real turn.
- **Gain**: First-turn TTFT for Apple drops from cold-start (~3–5 s, often falls back) to warm (~200 ms).

#### T1.3 — Drop `includeSchemaInPrompt` after first call per session
- **Files**: `applesilicon/macos-foundation-intent-helper/Sources/main.swift:792-805`, `855-883`, `970-997`.
- **Change**: Track first-call-per-session; subsequent calls use `includeSchemaInPrompt: false`. Decoding stays constrained because the `@Generable` schema is still attached.
- **Gain**: ~50 ms per call after warmup; reduces prompt token count by ~200.

#### T1.4 — Cold-start aware `model_not_ready` policy
- **File**: `electron/llm/providers/IntentClassificationCoordinator.ts:222-228`
- **Change**: Remove `model_not_ready` from `isRetryableError`. Instead, on `model_not_ready`, immediately fall back to SetFit AND schedule a background `setTimeout(warmRetry, 5000)` that re-pings Apple. Once warm, future turns flow through Apple.
- **Gain**: First turn is never delayed by Apple cold-start; subsequent turns recover Apple primacy.

#### T1.5 — Single source of truth for cue regex
- **Files**: `applesilicon/macos-foundation-intent-helper/Sources/main.swift:429-515`, `electron/llm/providers/IntentClassificationCoordinator.ts:52-210`.
- **Change**: Remove `reconcileIntentWithCues` from Swift. Move all cue reconciliation to the TS coordinator post-processing step. Helper returns raw model output only.
- **Gain**: Eliminates Swift/TS drift; helper stays tiny; easier to evolve cue lists.

**Tier 1 verification**:
- `npm run typecheck`
- `npm test -- electron/tests/foundationModelsIntentProvider.test.ts electron/tests/foundationIntentProvider.test.ts`
- Run intent eval, confirm accuracy unchanged or improved on the labeled set.

---

### Tier 2 — Medium effort (1–3 days, high accuracy gain)

#### T2.1 — Foundation Models conscious-mode verifier judge
- **New file**: `electron/llm/providers/FoundationModelsVerifierProvider.ts`
- **Helper change**: Add `--mode=verify` to the Swift helper, with a new `@Generable VerdictEnvelope { ok, reason, confidence }` schema.
- **TS change**: `electron/conscious/ConsciousVerifierLLM.ts:43-90` — new path: try Foundation verifier first; fall back to cloud `generateContentStructured` if Apple fails or is unavailable.
- **Gain**: Verifier latency 600–900 ms → 200–400 ms; fully private; zero token spend.
- **Verify**: `electron/conscious/ConsciousEvalHarness.ts` runs cleanly; verifier rejection rate matches or improves.

#### T2.2 — Ship calibrated `intent_confidence_v2`
- **New script**: `scripts/calibrateIntentConfidence.ts`
- **New asset**: `electron/llm/intentConfidenceMap.v2.json` (per-intent isotonic regression map: `raw_apple_confidence → P(correct)`).
- **TS change**: `electron/llm/intentConfidenceCalibration.ts` — replace flat 0.72/0.84 with calibrated values; bump version to `intent_confidence_v2`.
- **Gain**: Routing decisions become statistically meaningful; `isLowConfidence`/`isContradiction` start firing on the right turns.
- **Verify**: ECE (expected calibration error) reported by eval harness drops; per-intent accuracy unchanged.

#### T2.3 — Foundation Models as parallel-race answer provider for short intents
- **New file**: `electron/llm/providers/FoundationModelsAnswerProvider.ts`
- **Helper change**: Add `--mode=answer` to the Swift helper. New `@Generable AnswerEnvelope` schema for the 4 short intents (`clarification`, `summary_probe`, `follow_up`, `example_request`).
- **TS change**: `electron/llm/providers/geminiProvider.ts:560-605` — for the 4 short intents only, add Apple as the *first* provider in the race. Cloud providers continue to run; whichever produces the first 2 sentences wins.
- **Gain**: TTFT for those intents drops from ~600 ms (cloud) to ~120 ms (Apple). Cloud retains primacy for `coding`, `deep_dive`, `behavioral`.
- **Verify**: Latency snapshot p50 for those intents drops; accuracy on conscious eval unchanged or improved.

#### T2.4 — Foundation primary in coordinator (warmth-gated)
- **File**: `electron/IntelligenceEngine.ts:200-207`
- **Change**: When `helper.isWarm()`, flip primary/fallback to `(FoundationModels, SetFit)`. When cold, retain `(SetFit, FoundationModels)`. Add `isWarm()` method to `FoundationModelsIntentProvider` (true after first successful classify).
- **Gain**: Apple — the more accurate classifier — sees the majority of turns once warm. Coordinator's contradiction logic gets real teeth.
- **Verify**: Eval harness combined accuracy ≥ current; per-turn latency p95 ≤ current (because warm Apple is now <300 ms).

**Tier 2 verification**:
- All Tier 1 verification + `npm run intent-eval` + `electron/conscious/ConsciousEvalHarness.ts`
- Compare Foundation-only / legacy-only / coordinated results before rollout (REL-401 from existing plan).

---

### Tier 3 — Strategic upgrades (≥1 week, accuracy ceiling)

#### T3.1 — LoRA `Adapter` fine-tuned on the eval corpus
- **New scripts**: `scripts/trainIntentAdapter.swift`, `scripts/exportAdapter.sh`.
- **New asset**: `assets/adapters/intent-v1.adapter` (shipped with the helper bundle).
- **Helper change**: Load adapter via `LanguageModelSession(model: model, adapter: adapter, instructions: ...)`.
- **Schema collapse**: One single `@Generable IntentEnvelope` shot replaces family → profile → pairwise. Pairwise tracks delete; cue reconciliation deletes.
- **Gain**: Highest accuracy ceiling. Helper latency from ~1 s (multi-stage) to ~200 ms. Eliminates pairwise hand-coding.
- **Risk**: Requires training pipeline + versioned adapter shipping infra. Adapter must travel with helper binary in code-signed releases.

#### T3.2 — On-device context summarization for conscious mode
- **File**: `electron/conscious/ConsciousPreparationCoordinator.ts:208-372`
- **Change**: Replace cloud-bound long-context evidence block compression with on-device `@Generable ContextSummary` call. Run before cloud answer call; pass compressed evidence to cloud. Saves tokens, latency, privacy footprint.
- **Gain**: ~200–400 ms removed from conscious-mode hot path; large prompt token savings on cloud answer call.

#### T3.3 — `@Tool`-based verifier
- **Files**: Helper (new tool definitions), `electron/conscious/ConsciousVerifierLLM.ts`.
- **Change**: Replace single-shot judge prompt with tool-using session. Tools: `lookupHypothesis`, `lookupEvidenceFor(claim)`, `lookupSemanticFact(facet)`. Apple fetches only what it needs.
- **Gain**: Verifier accuracy + lower refusal rate (Apple guardrails trigger less on focused prompts).

#### T3.4 — Streaming intent for progressive disclosure
- **File**: `applesilicon/macos-foundation-intent-helper/Sources/main.swift:792-805`.
- **Change**: Switch `session.respond` → `session.streamResponse(generating: IntentEnvelope.self)`. Coordinator can act on the intent label the moment it streams (typically <80 ms) without waiting for the confidence value.
- **Gain**: p50 intent latency to ~80 ms; p95 unchanged.

#### T3.5 — Multi-task envelope (intent + answerShape + questionQuality)
- **Schema change**: Widen `IntentEnvelope` to `ClassifierEnvelope { intent, confidence, answerShape, questionQuality }` with `.anyOf` constraints on each.
- **TS change**: Replace `getAnswerShapeGuidance(intent)` regex map (`electron/llm/IntentClassifier.ts`) with the model-provided `answerShape`. Add a `questionQuality` gate that rejects `incomplete` questions before any cloud call.
- **Gain**: Three subsystems unified into one ~200 ms model call. Question-quality gate alone saves cloud spend on malformed turns.

---

## 5. Suggested execution order

1. **Tier 1** — flip persistent default, warm at boot, drop schema-in-prompt after first call, fix cold-start retry, deduplicate cue regex. ~30 LOC across 4 files. **No accuracy risk; ~250 ms p50 win.** Ship as four small commits.
2. **Tier 2.2** — calibration JSON pipeline. **Single largest accuracy unlock available without ML infra.** Pure data work + tiny code change.
3. **Tier 2.3** — parallel-race answer provider for short intents. ~150 LOC for new provider + ~30 LOC plumbing. p50 TTFT for those intents drops 600 ms → 120 ms.
4. **Tier 2.1** — on-device verifier. Privacy + cost + latency wins, ~200 LOC.
5. **Tier 2.4** — promote Apple to coordinator primary (warmth-gated).
6. **Tier 3.1** — LoRA adapter. Biggest ceiling raise but heaviest infra cost.
7. **Tier 3.2 → 3.5** — opportunistic, after metrics show where remaining gaps live.

---

## 6. Cross-cutting concerns

### Privacy
Every move from cloud → on-device removes a transcript-bearing network round-trip. Tier 2.1 (verifier) and Tier 3.2 (context summarization) are the highest-value privacy wins.

### Cost
Tier 2.3 + Tier 2.1 reduce cloud token spend by an estimated 30–50 % on conscious-mode turns (no verifier round-trip; no answer round-trip for short intents).

### Accuracy ceiling
- Without Tier 3.1 (adapter): ceiling is base Apple Foundation Model accuracy on interview-domain text (~85–88 % on the labeled corpus, per existing plan baselines).
- With Tier 3.1: ceiling lifts to LoRA-tuned domain accuracy (typically 92–95 %+) and ambiguous-pair errors largely disappear.

### Compatibility
Every tier preserves Windows + non-eligible macOS legacy behavior via the `isAvailable()` gate. No tier changes legacy fallback semantics.

### Risk
- **Tier 1**: zero accuracy risk; only latency / startup behavior changes.
- **Tier 2.2**: zero accuracy risk if the calibration map is fitted on the eval corpus and validated on a held-out split.
- **Tier 2.1 / 2.3 / 2.4**: introduce on-device paths; gate them behind feature flags (`useFoundationModelsVerifier`, `useFoundationModelsAnswers`, `foundationPrimaryWarmthGated`) so we can disable per host without redeploying.
- **Tier 3.1**: training/distribution risk; adapter bundle must be code-signed and versioned; rollback path required.

---

## 7. Done When

- [ ] **T1.1–T1.5 shipped** — persistent helper auto-on, warmup at boot, `includeSchemaInPrompt` short-circuit, cold-start aware retry, single cue source.
- [ ] **T2.2 shipped** — `intent_confidence_v2.json` derived from eval, ECE measured and reported.
- [ ] **T2.3 shipped** — `FoundationModelsAnswerProvider` racing for short intents; latency snapshots show TTFT drop.
- [ ] **T2.1 shipped** — on-device verifier; conscious eval harness shows verifier accuracy ≥ baseline.
- [ ] **T2.4 shipped** — Apple primary when warm; combined coordinator accuracy ≥ baseline.
- [ ] **REL-401 re-run** — Foundation-only / legacy-only / coordinated comparison confirms parity or improvement on labeled set.
- [ ] **Tier 3 backlog tracked** — adapter training, on-device summarization, tool-based verifier, streaming intent, multi-task envelope.
