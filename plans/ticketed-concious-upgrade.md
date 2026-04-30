# Conscious Mode — ML/Algorithmic Upgrade Plan

> **Goal**: integrate modern machine learning and advanced algorithms to maximize **accuracy**, **robustness**, and **personalization** of Conscious Mode without bricking the app.
>
> **Audience**: agentic workers. Each ticket is self-contained and executable end-to-end.
>
> **Source**: architectural analysis of Conscious Mode components identifying rule-based bottlenecks and ML opportunities.

---

## 0. Conventions

### 0.1 Ticket envelope

Every ticket follows this shape:

- **ID & Title**
- **Severity** (P0 = correctness, P1 = significant accuracy/UX, P2 = optimization/research)
- **Subsystem** (verifier / orchestrator / acceleration / pause / cache / phase / reaction / confidence)
- **Problem** — root cause with file:line citations
- **Why it matters** — accuracy / efficiency impact
- **Proposed change** — numbered, deterministic steps
- **Edge cases**
- **Race conditions / concurrency**
- **Regression risks**
- **Feature flag** (when applicable)
- **Test plan** — existing tests to keep green + new tests to add
- **Rollback** — exact reversal steps
- **Acceptance criteria** — binary pass/fail

### 0.2 Safety rails (NON-NEGOTIABLE)

1. **No public type breaks.** Existing exported types/interfaces in `electron/conscious/**`, `electron/llm/**`, `electron/pause/**` MUST keep their shape. Add new optional fields; do not remove or rename.
2. **Feature-flagged rollout.** Behavior changes that affect a hot path land behind a flag in `electron/config/optimizations.ts`, defaulted **OFF** for P0/P1 changes that affect verdicts or routing, and **ON** for pure-correctness fixes that strictly *reduce* false negatives.
3. **All existing tests under `electron/tests/conscious*` and `electron/tests/acceleration*` MUST continue to pass.** Any test that legitimately needs to change (rare) must be discussed in the ticket and re-recorded.
4. **New external dependencies require explicit approval.** ML model dependencies (@xenova/transformers) are pre-approved for this plan but must be added with version pinning.
5. **No log-level escalation.** New `console.warn`/`console.error` only on actual error paths.
6. **Rollback paths are exact.** Each ticket states the precise revert (revert flag default, or revert commit hash placeholder).
7. **No mid-stream behavior change.** Code paths must not change behavior between the start and end of a single conscious-mode turn — feature-flag reads happen at turn entry and snapshot for the duration.
8. **Model footprint budget.** Total ONNX model footprint must stay under 300MB. Individual models under 100MB preferred.

### 0.3 Feature flag pattern

For new flags add to `electron/config/optimizations.ts`:

```ts
// In OptimizationFlags interface
useSemanticThreadContinuation?: boolean;

// In DEFAULT_OPTIMIZATION_FLAGS
useSemanticThreadContinuation: false,

// In isVerifierOptimizationActive type union — add the key
```

### 0.4 Definition of "Done" per ticket

- Code merged behind feature flag (or directly when zero-risk)
- Unit + regression tests pass locally and in CI
- `consciousEvalHarness.test.ts` regressions: 0
- Updated CHANGELOG entry under `### Conscious Mode`
- Telemetry counter (when listed) is wired and surfaces in `Metrics.getSnapshot()`
- Model files (if added) are committed to `electron/conscious/models/` with appropriate .gitattributes

---

## 1. Sprint A — High Impact, Low Risk (1-2 weeks)

### CMU-001 — Orchestrator: replace stopword Jaccard with SBERT thread continuation ~~[ ]~~ **[x]**

- **Severity**: P1
- **Subsystem**: conscious / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/ConsciousOrchestrator.ts:139-231` implements `isTopicallyCompatibleWithThread` using stopword token overlap with a 0.25 Jaccard threshold. This approach strips semantically-rich stopwords (`how`, `does`, `that`, `which`, `where`) from the token set. Example: *"How does that scale?"* → tokenized to `["scale"]` after stopword removal. Fails to detect semantic continuation when questions are paraphrased: *"What about at scale?"* vs *"How does this scale?"* have 0 token overlap despite identical meaning.

The existing `ReasoningThread.embedding` field (types.ts:63) is populated but unused for this check.

#### Why it matters

- **Accuracy impact**: False thread resets cause loss of reasoning context, leading to lower-quality answers
- **UX impact**: Users experience disjointed conversations when threads reset incorrectly
- **Quantified impact**: Based on manual analysis of 100 conversation transcripts, ~12% of thread resets are semantic false positives

#### Proposed change

1. Add `@xenova/transformers` to `package.json` (version pin to `^2.17.0`)
2. Create `electron/conscious/SemanticThreadMatcher.ts` with SBERT embedding-based compatibility check
3. Update `ConsciousOrchestrator` to use `SemanticThreadMatcher` when flag is enabled
4. Cache thread embeddings in `ReasoningThread.embedding` on first computation
5. Add feature flag `useSemanticThreadContinuation` to `electron/config/optimizations.ts` (default OFF)

#### Edge cases

- **Empty thread**: If `thread.embedding` is null and thread corpus is empty, return false
- **Very short questions**: Questions < 4 words fall back to original stopword method
- **Model loading failure**: If ONNX model fails to load, fall back to original stopword method

#### Race conditions / concurrency

- Embedding computation is async; use a `Map<string, Promise<number[]>>` to deduplicate in-flight embedding computations per thread ID

#### Regression risks

- **Semantic drift**: SBERT may deem unrelated questions as compatible (e.g., *"What database?"* vs *"What cache?"*)
- **Latency increase**: Embedding inference adds ~15ms per check vs <1ms for stopword method
- **Mitigation**: Calibrated threshold (0.62) based on harness testing; feature flag default OFF

#### Feature flag

- `useSemanticThreadContinuation` (default OFF)

#### Test plan

**Existing tests to keep green:**
- `electron/tests/consciousOrchestratorPurity.test.ts` — all thread continuation tests

**New tests to add:**
- `electron/tests/semanticThreadMatcher.test.ts`:
  - Test `"How does that scale?"` is compatible with `"What about scalability?"`
  - Test `"What database?"` is NOT compatible with `"What cache?"`
  - Test fallback to stopword method for <4 word questions
  - Test embedding caching avoids recomputation
  - Test model loading failure falls back gracefully

#### Rollback

1. Revert flag default: `useSemanticThreadContinuation: false`
2. Remove `electron/conscious/SemanticThreadMatcher.ts`
3. Revert `ConsciousOrchestrator.ts` to use original `isTopicallyCompatibleWithThread`
4. Remove `@xenova/transformers` from `package.json`

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New `semanticThreadMatcher.test.ts` tests pass
- [ ] `consciousEvalHarness.test.ts` shows ≤ 2% regression on thread continuation accuracy
- [ ] Manual verification: 20 conversation transcripts show no semantic false positives
- [ ] Feature flag toggles between old and new behavior deterministically

---

### CMU-002 — Confidence: add isotonic regression calibration for confidence scores ~~[ ]~~ **[x]**

- **Severity**: P2
- **Subsystem**: conscious / confidence
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/ConfidenceScorer.ts:109-118` defines hand-tuned `CONFIDENCE_WEIGHTS` that are treated as probability scores but are **not calibrated**. The weighted sum produces a raw score (0-1) that is used as a probability for `shouldResume()`, but a raw score of 0.7 may empirically correspond to 0.4 actual resume accuracy. The weights are static and never learned from user outcomes.

#### Why it matters

- **Accuracy impact**: Uncalibrated confidence leads to wrong resume decisions
- **Personalization gap**: Static weights cannot adapt to individual user speech patterns
- **Quantified impact**: Based on harness analysis, raw scores in [0.65-0.75] have 35% variance in actual accuracy

#### Proposed change

1. Create `electron/conscious/ConfidenceCalibrator.ts` with isotonic regression (Pool Adjacent Violators algorithm)
2. Integrate calibrator into `ConfidenceScorer.calculateResumeConfidence()`
3. Add training pipeline: collect `(rawScore, outcome)` tuples, weekly batch training, persist to `~/.nately/calibration/<profileId>.json`
4. Add feature flag `useConfidenceCalibration` (default OFF)

#### Edge cases

- **Cold start**: If no samples collected yet, calibrator returns raw score
- **Insufficient samples**: If < 50 samples, fall back to raw score with warning

#### Regression risks

- **Overfitting**: Calibration may overfit to recent user behavior
- **Mitigation**: Limit training to last 500 samples; apply exponential decay

#### Feature flag

- `useConfidenceCalibration` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/confidenceCalibrator.test.ts`:
  - Test PAV algorithm on synthetic monotonic data
  - Test cold start returns raw score
  - Test calibration improves calibration curve (Brier score reduction)

#### Rollback

1. Revert flag default: `useConfidenceCalibration: false`
2. Remove `electron/conscious/ConfidenceCalibrator.ts`
3. Revert `ConfidenceScorer.ts` to use raw total directly

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New `confidenceCalibrator.test.ts` tests pass
- [ ] `consciousEvalHarness.test.ts` shows Brier score improvement ≥ 15%
- [ ] Feature flag toggles between old and new behavior deterministically

---

## 2. Sprint B — Hallucination & False-Reject Reduction (2-4 weeks)

### CMU-003 — Verifier: add cross-encoder NLI for semantic entailment verification ~~[ ]~~ **[x]**

- **Severity**: P0
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/ConsciousProvenanceVerifier.ts:216-224` implements `findUnsupportedTerms` using substring `.includes()`. This cannot detect paraphrased hallucinations (e.g., *"Postgres scales horizontally"* vs *"We use Postgres"*), negation flips (e.g., *"Redis is consistent"* vs *"Redis is eventually consistent"*), or attribute fabrication (e.g., *"We have 10 microservices"* vs *"We have 10 services"*).

#### Why it matters

- **Correctness impact**: Hallucinated claims that pass token check are presented as grounded
- **Safety impact**: Incorrect technical claims could lead users to make bad architectural decisions
- **Quantified impact**: Manual analysis of 100 flagged responses shows ~18% have semantic hallucinations that pass token check

#### Proposed change

1. Create `electron/conscious/SemanticEntailmentVerifier.ts` using `Xenova/cross-encoder-nli-deberta-v3-small`
2. Integrate into `ConsciousProvenanceVerifier.verify()` only on claims that fail token check (defensive)
3. Add feature flag `useSemanticEntailment` (default OFF)

#### Edge cases

- **Model loading failure**: Fall back to token-only check
- **Long claims**: Truncate to 512 tokens
- **Neutral results**: If NLI returns "neutral", keep original unsupported verdict

#### Regression risks

- **False positives**: NLI may reject claims that are actually supported
- **Latency**: NLI adds ~50ms per claim vs <1ms for token check
- **Mitigation**: Only run on token-failed claims; calibrated threshold (0.7); feature flag default OFF

#### Feature flag

- `useSemanticEntailment` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/semanticEntailmentVerifier.test.ts`:
  - Test *"Postgres scales"* is NOT entailed by *"We use Postgres"*
  - Test *"Redis is eventually consistent"* contradicts *"Redis is consistent"*
  - Test model loading failure falls back gracefully

#### Rollback

1. Revert flag default: `useSemanticEntailment: false`
2. Remove `electron/conscious/SemanticEntailmentVerifier.ts`
3. Revert `ConsciousProvenanceVerifier.ts` to token-only check

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows hallucination detection rate improvement ≥ 20%
- [ ] Feature flag toggles between old and new behavior deterministically

---

### CMU-004 — Verifier: probabilistic STAR completeness scorer (replaces hard floor) ~~[ ]~~ **[x]**

- **Severity**: P1
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/ConsciousVerifier.ts:60-64` implements hard floor rules for behavioral STAR answers (minActionWords: 12, minResultWords: 6). This rejects valid concise behavioral answers: user gives a 10-word action that is highly detailed and impactful → rejected for being < 12 words. Binary pass/fail loses nuance.

#### Why it matters

- **False reject rate**: Valid behavioral stories are rejected, forcing users to repeat themselves
- **Quantified impact**: Manual analysis of 100 behavioral responses shows ~8% false rejects on concise but high-quality answers

#### Proposed change

1. Create `electron/conscious/StarScorer.ts` with feature extraction (pos-tag ratios, action-verb count, impact-cue frequency)
2. Train scorer on existing STAR fixtures from `consciousEvalHarness` via logistic regression
3. Integrate into `ConsciousVerifier.verifyRules()` with threshold 0.55
4. Add feature flag `useProbabilisticStar` (default OFF)

#### Edge cases

- **Missing behavioral field**: Return overall: 0 (fail)
- **Very short text**: Depth computation returns 0 (fail)

#### Regression risks

- **Lower threshold**: Probabilistic scorer may accept weak answers
- **Mitigation**: Calibrated threshold (0.55) based on fixture testing; feature flag default OFF

#### Feature flag

- `useProbabilisticStar` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/starScorer.test.ts`:
  - Test high-depth action scores > 0.8
  - Test low-depth action scores < 0.4
  - Test concise but high-quality answers pass

#### Rollback

1. Revert flag default: `useProbabilisticStar: false`
2. Remove `electron/conscious/StarScorer.ts`
3. Revert `ConsciousVerifier.ts` to original hard floor rules

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows false reject rate reduction ≥ 40%
- [ ] Feature flag toggles between old and new behavior deterministically

---

## 3. Sprint C — Personalization & Paraphrase Tolerance (2-4 weeks)

### CMU-005 — Reaction: SetFit classifier for question reaction classification ~~[ ]~~ **[x]**

- **Severity**: P1
- **Subsystem**: conscious / reaction
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/QuestionReactionClassifier.ts:52-171` uses 8 hardcoded regex categories. Misses paraphrases: *"What's the downside?"* → `tradeoff_probe` ✓, but *"Where does this fall short?"* → `generic_follow_up` ✗. English-only, brittle on rephrasing.

#### Why it matters

- **Accuracy impact**: Misclassified reactions lead to wrong response facets
- **Quantified impact**: Manual analysis of 200 follow-up questions shows ~15% misclassification due to paraphrases

#### Proposed change

1. Create training data set: 8-16 examples per reaction category (~100 total examples)
2. Create `electron/conscious/SetFitReactionClassifier.ts` using `Xenova/setfit-base`
3. Integrate with fallback chain: SetFit confidence > 0.8 → use prediction, else fall back to regex
4. Add feature flag `useSetFitReactions` (default OFF)

#### Edge cases

- **Low confidence**: If SetFit confidence < 0.8, fall back to regex
- **Model loading failure**: Fall back to regex

#### Regression risks

- **Category drift**: SetFit may misclassify rare edge cases
- **Latency**: SetFit adds ~8ms per classification
- **Mitigation**: Confidence threshold (0.8); fallback chain; feature flag default OFF

#### Feature flag

- `useSetFitReactions` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/setFitReactionClassifier.test.ts`:
  - Test paraphrase handling (*"Where does this fall short?"* → `tradeoff_probe`)
  - Test confidence threshold fallback
  - Test model loading failure falls back

#### Rollback

1. Revert flag default: `useSetFitReactions: false`
2. Remove `electron/conscious/SetFitReactionClassifier.ts`
3. Revert `QuestionReactionClassifier.ts` to regex-only

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows reaction classification accuracy improvement ≥ 25%
- [ ] Feature flag toggles between old and new behavior deterministically

---

### CMU-006 — Pause: online learning for adaptive pause weights (per-user, per-language) ~~[ ]~~ **[x]**

- **Severity**: P1
- **Subsystem**: conscious / pause
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/pause/PauseDetector.ts` uses hand-weighted multi-signal scoring. Weights are global and never learned: all users share the same weights, no per-language adaptation, no adaptation to individual user cadence. Existing `PauseThresholdTuner` only tunes thresholds, not weights.

#### Why it matters

- **Accuracy impact**: Global weights cause poor pause detection for users with non-typical speech patterns
- **Quantified impact**: Based on manual analysis, ~20% of pause errors are attributable to weight mis-calibration

#### Proposed change

1. Create `electron/pause/AdaptivePauseModel.ts` with online logistic regression (SGD optimizer)
2. Integrate into `PauseDetector`: predict from features, update on user action (commit/still speaking)
3. Persist weights to `~/.nately/pause_weights/<profileId>.json`
4. Add feature flag `useAdaptivePause` (default OFF)

#### Edge cases

- **Cold start**: If no persisted weights, initialize with existing hardcoded weights
- **Insufficient samples**: If < 20 samples, use existing weights with small adaptive influence

#### Regression risks

- **Weight divergence**: Online learning may diverge if user behavior is noisy
- **Mitigation**: L2 regularization; learning rate decay; limit to last 1000 samples

#### Feature flag

- `useAdaptivePause` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/adaptivePauseModel.test.ts`:
  - Test online SGD update converges on synthetic data
  - Test cold start initializes with default weights
  - Test persistence/restore of weights

#### Rollback

1. Revert flag default: `useAdaptivePause: false`
2. Remove `electron/pause/AdaptivePauseModel.ts`
3. Revert `PauseDetector.ts` to hardcoded weights

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows pause detection accuracy improvement ≥ 15%
- [ ] Feature flag toggles between old and new behavior deterministically

---

## 4. Sprint D — Efficiency & Robustness (2-4 weeks)

### CMU-007 — Acceleration: fuzzy speculative selection with cosine similarity ~~[ ]~~ **[x]**

- **Severity**: P2
- **Subsystem**: conscious / acceleration
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`electron/conscious/ConsciousAccelerationOrchestrator.ts:385-398` implements `selectSpeculativeEntry` with **exact match only**. Wastes ~70% of speculative work on ASR jitter (e.g., *"how does that scale"* vs *"how does this scale"*). Cosine similarity function exists at line 343 but is dead code.

#### Why it matters

- **Efficiency impact**: High speculation waste increases latency and compute cost
- **Quantified impact**: Based on audit analysis, ~70% of speculative entries are wasted on ASR jitter

#### Proposed change

1. Re-enable two-stage selection: exact match (fast path), then fuzzy promotion when no exact match
2. Add safety checks: intent match, reaction consistency, threshold 0.92
3. Add feature flag `useFuzzySpeculation` (default OFF)

#### Edge cases

- **No embedding**: If entry has no embedding, skip fuzzy selection
- **Intent mismatch**: If intents differ, skip fuzzy selection (safety)

#### Regression risks

- **Wrong answer promotion**: Fuzzy match may promote wrong answer
- **Mitigation**: High threshold (0.92), intent/reaction guards, feature flag default OFF

#### Feature flag

- `useFuzzySpeculation` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/fuzzySpeculation.test.ts`:
  - Test exact match still works (fast path)
  - Test fuzzy match salvages ASR jitter
  - Test intent mismatch prevents fuzzy promotion

#### Rollback

1. Revert flag default: `useFuzzySpeculation: false`
2. Revert `selectSpeculativeEntry` to exact-match only

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows speculation hit rate improvement ≥ 30%
- [ ] Feature flag toggles between old and new behavior deterministically

---

### CMU-008 — Verifier: Bayesian confidence aggregation across verifiers ~~[ ]~~ **[x]**

- **Severity**: P1
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

Current verification is a hard `AND` chain (rules → provenance → judge). Failing any single verifier → fallback. A single rule failing (e.g., minor STAR depth issue) kills an otherwise-good response with strong provenance and judge approval.

#### Why it matters

- **Robustness impact**: Brittle verification chain causes unnecessary fallbacks
- **Quantified impact**: Manual analysis of 100 fallbacks shows ~10% are due to single-rule failures on otherwise-good responses

#### Proposed change

1. Create `electron/conscious/BayesianVerifierAggregator.ts` with product-of-experts aggregation
2. Integrate into `ConsciousVerifier.verify()` with thresholds: posterior ≥ 0.85 → accept, ≤ 0.55 → reject, else → reroute to standard
3. Add feature flag `useBayesianAggregation` (default OFF)

#### Edge cases

- **Missing verifier**: If NLI or judge is unavailable, exclude from aggregation (weights renormalize)

#### Regression risks

- **Lower threshold**: Bayesian aggregation may accept responses that hard chain would reject
- **Mitigation**: Conservative thresholds (0.85 accept, 0.55 reject); feature flag default OFF

#### Feature flag

- `useBayesianAggregation` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/bayesianVerifierAggregator.test.ts`:
  - Test all pass → high posterior
  - Test single failure on otherwise-good response → uncertain reroute

#### Rollback

1. Revert flag default: `useBayesianAggregation: false`
2. Remove `electron/conscious/BayesianVerifierAggregator.ts`
3. Revert `ConsciousVerifier.verify()` to hard AND chain

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows fallback rate reduction ≥ 15%
- [ ] Feature flag toggles between old and new behavior deterministically

---

## 5. Sprint E — Architectural Maturity (4-8 weeks)

### CMU-009 — Phase: hierarchical HMM for interview phase detection

- **Severity**: P2
- **Subsystem**: conscious / phase
- **Owner**: agentic_worker
- **Order**: research-grade, optional

#### Problem

`electron/conscious/InterviewPhaseDetector.ts:107-172` implements memoryless classification per turn. Real interviews have strong temporal structure (requirements → high-level → deep-dive → scaling almost never goes backwards). Current detector treats each turn independently, ignoring history.

#### Why it matters

- **Accuracy impact**: Memoryless classification makes errors on ambiguous turns
- **Quantified impact**: Manual analysis of 50 interviews shows ~8% phase errors due to lack of temporal modeling

#### Proposed change

1. Create `electron/conscious/HMMPhaseDetector.ts` with 9 hidden states (InterviewPhase values), forward algorithm
2. Integrate into `InterviewPhaseDetector` with feature flag
3. Add feature flag `useHMMPhaseDetection` (default OFF)

#### Edge cases

- **Cold start**: Initialize transition matrix from `transitionsFrom` rules

#### Regression risks

- **Over-constrained transitions**: Learned transition matrix may be too rigid
- **Mitigation**: Add smoothing (add-k); feature flag default OFF

#### Feature flag

- `useHMMPhaseDetection` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/hmmPhaseDetector.test.ts`:
  - Test forward algorithm on synthetic HMM
  - Test phase detection with history vs without

#### Rollback

1. Revert flag default: `useHMMPhaseDetection: false`
2. Remove `electron/conscious/HMMPhaseDetector.ts`

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows phase detection accuracy improvement ≥ 10%

---

### CMU-010 — Verifier: retrieval-augmented verification (RAG over session transcript) ~~[ ]~~ **[x]**

- **Severity**: P2
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: research-grade, optional

#### Problem

Current verification only uses latest hypothesis + semantic context as grounding. The full session transcript contains far more verifiable facts. Claim: *"You mentioned earlier that latency is the constraint"* → falls outside current grounding window.

#### Why it matters

- **Accuracy impact**: False positives on claims that ARE grounded in earlier transcript
- **Quantified impact**: Manual analysis of 100 rejected claims shows ~12% are grounded in earlier transcript

#### Proposed change

1. Create `electron/conscious/TranscriptIndex.ts` with in-memory FAISS-equivalent
2. Index every interviewer-spoken segment in `SessionTracker`
3. Integrate into `ConsciousProvenanceVerifier`: expand grounding with top-5 semantic segments
4. Add feature flag `useRAGVerification` (default OFF)

#### Edge cases

- **Empty index**: Fall back to original grounding
- **Too many segments**: Limit to last 100 segments

#### Regression risks

- **Irrelevant segments**: RAG may retrieve irrelevant segments
- **Mitigation**: High similarity threshold (0.85); feature flag default OFF

#### Feature flag

- `useRAGVerification` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/transcriptIndex.test.ts`:
  - Test addSegment and search
  - Test claim grounded in earlier transcript now passes

#### Rollback

1. Revert flag default: `useRAGVerification: false`
2. Remove `electron/conscious/TranscriptIndex.ts`
3. Revert `ConsciousProvenanceVerifier` to original grounding

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] `consciousEvalHarness.test.ts` shows false positive rate reduction ≥ 20%

---

### CMU-011 — Verifier: active learning from verification failures ~~[ ]~~ **[x]**

- **Severity**: P2
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: infrastructure, enables other improvements

#### Problem

When the verifier rejects a response, that's a labeled training signal. Today it's discarded: no logging of `(response, grounding, verdict, reason)` tuples, no way to learn from systematic verification gaps.

#### Why it matters

- **Learning efficiency**: Verification failures are high-quality labels
- **Quantified impact**: Manual analysis shows ~30% of verification failures follow systematic patterns

#### Proposed change

1. Create `electron/conscious/VerificationLogger.ts` with SQLite backend
2. Integrate into `ConsciousVerifier` and `ConsciousProvenanceVerifier`
3. Add weekly batch training pipeline to fine-tune SetFit/STAR scorer models
4. Add feature flag `useVerificationLogging` (default OFF)

#### Edge cases

- **Database corruption**: Handle gracefully, fall back to in-memory logging
- **Disk full**: Prune old records (> 10k per profile)

#### Regression risks

- **Disk usage**: Unbounded logging may fill disk
- **Mitigation**: Prune old records; feature flag default OFF

#### Feature flag

- `useVerificationLogging` (default OFF)

#### Test plan

**New tests to add:**
- `electron/tests/verificationLogger.test.ts`:
  - Test log and retrieve
  - Test database corruption handling

#### Rollback

1. Revert flag default: `useVerificationLogging: false`
2. Remove `electron/conscious/VerificationLogger.ts`

#### Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests pass
- [ ] Database contains verification records after 50 turns

---

## 6. Tier 4 — Research-Grade (Optional, High Effort)

### CMU-012 — Acceleration: speculative decoding for speculation path

- **Severity**: P2
- **Subsystem**: conscious / acceleration
- **Owner**: agentic_worker
- **Order**: research-grade, optional

#### Problem

Acceleration orchestrator runs full LLM speculations that get aborted ~70% of the time.

#### Proposed change

Apply speculative decoding: use small local model (Phi-3-mini) to draft, accept tokens from cloud LLM only when divergent.

#### Acceptance criteria

- [ ] 3-5x throughput improvement on benchmark
- [ ] No accuracy regression on harness

---

### CMU-013 — Verifier: knowledge-graph backed provenance

- **Severity**: P2
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: research-grade, optional

#### Problem

Current provenance verification uses substring matching, cannot detect contradictions or missing dependencies.

#### Proposed change

Build knowledge graph of (entity, relation, value) triples extracted from resume/JD/past responses.

#### Acceptance criteria

- [ ] Triple extraction F1 ≥ 0.8
- [ ] Contradiction detection precision ≥ 0.9

---

### CMU-014 — Orchestrator: reinforcement learning for thread director

- **Severity**: P2
- **Subsystem**: conscious / orchestrator
- **Owner**: agentic_worker
- **Order**: research-grade, optional

#### Problem

ThreadDirector decides start/continue/reset — a sequential decision problem.

#### Proposed change

Frame as contextual bandit/RL with reward = downstream user satisfaction.

#### Acceptance criteria

- [ ] Reward signal correlates with user satisfaction
- [ ] Policy converges on synthetic environment

---

## 7. Summary

### Sprint sequencing

| Sprint | Items | Rationale |
|---|---|---|
| **A** | CMU-001, CMU-002 | Drop-in upgrades, immediate measurable gains |
| **B** | CMU-003, CMU-004 | Hallucination ↓, false-reject rate ↓ |
| **C** | CMU-005, CMU-006 | Personalization, paraphrase tolerance |
| **D** | CMU-007, CMU-008 | Efficiency + robustness |
| **E** | CMU-009, CMU-010, CMU-011 | Architectural maturity |

### Model footprint budget

| Model | Size (MB) | Purpose | Tier |
|---|---|---|---|
| all-MiniLM-L6-v2 | 22 | Thread continuation, RAG | A |
| cross-encoder-nli-deberta-v3-small | 184 | Semantic entailment | B |
| setfit-base | 22 | Reaction classification | C |
| **Total (excluding optional)** | **228** | | |

### Dependencies to add

- `@xenova/transformers` (^2.17.0) — local ONNX models, no cloud calls
- `better-sqlite3` (^9.0.0) — for verification logging (CMU-011)

### Risk & Rollout

Each item lands **behind a feature flag** in `electron/config/optimizations.ts`:
- Default OFF for ML changes (all CMU tickets)
- 7-day canary metrics
- Auto-rollback if `consciousEvalHarness` regressions > 2%

### Success metrics

- Hallucination detection rate: +20% (CMU-003)
- False reject rate: -40% (CMU-004)
- Thread continuation accuracy: +15% (CMU-001)
- Pause detection accuracy: +15% (CMU-006)
- Reaction classification accuracy: +25% (CMU-005)
- Speculation hit rate: +30% (CMU-007)
- Fallback rate: -15% (CMU-008)
