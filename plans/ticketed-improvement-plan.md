# Conscious Mode — Ticketed Improvement Plan

> **Goal**: maximize **accuracy** and **efficiency** of Conscious Mode without bricking the app.
>
> **Audience**: agentic workers. Each ticket is self-contained and executable end-to-end.
>
> **Source**: re-audited findings from `plans/improvement-plan.md` Part B. Only verified findings appear here.

---

## 0. Conventions

### 0.1 Ticket envelope

Every ticket follows this shape:

- **ID & Title**
- **Severity** (P0 = correctness, P1 = significant accuracy/UX, P2 = optimization)
- **Subsystem** (verifier / orchestrator / acceleration / pause / cache / ipc / power)
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
2. **Feature-flagged rollout.** Behavior changes that affect a hot path land behind a flag in `electron/config/optimizations.ts`, defaulted **OFF** for P0 changes that change verifier verdicts or routing, and **ON** for pure-correctness fixes (e.g. word-boundary regex) that strictly *reduce* false negatives.
3. **All existing tests under `electron/tests/conscious*` and `electron/tests/acceleration*` MUST continue to pass.** Any test that legitimately needs to change (rare) must be discussed in the ticket and re-recorded.
4. **No new external dependencies** without explicit approval. Stay within current `package.json`.
5. **No log-level escalation.** New `console.warn`/`console.error` only on actual error paths.
6. **Rollback paths are exact.** Each ticket states the precise revert (revert flag default, or revert commit hash placeholder).
7. **No mid-stream behavior change.** Code paths must not change behavior between the start and end of a single conscious-mode turn — feature-flag reads happen at turn entry and snapshot for the duration.

### 0.3 Feature flag pattern

For new flags add to `electron/config/optimizations.ts`:

```ts
// In OptimizationFlags interface
useConsciousVerifierWordBoundary?: boolean;

// In DEFAULT_OPTIMIZATION_FLAGS
useConsciousVerifierWordBoundary: false,

// In isOptimizationActive type union — add the key
```

Read at turn entry: `const useWB = isOptimizationActive('useConsciousVerifierWordBoundary');` then pass via dependency injection or closure for the duration of the turn.

### 0.4 Test conventions

- Existing test runner: `node:test` (see `electron/tests/consciousVerifier.test.ts`).
- New tests live next to the closest existing peer (`electron/tests/<feature>.test.ts`).
- Coverage requirement: every new branch in `verifyRules`, `verify`, `prepareRoute`, `maybePrefetchIntent`, `maybeStartSpeculativeAnswer`, `invalidateSpeculation`, `evictStaleSpeculativeEntries` MUST have at least one test.
- Regression test pattern: snapshot the existing rule's behavior on the existing fixtures BEFORE the change; the new code must produce the same verdict on those fixtures (unless the ticket explicitly changes the expected verdict, listed in the ticket).

### 0.5 Definition of "Done" per ticket

- Code merged behind feature flag (or directly when zero-risk)
- Unit + regression tests pass locally and in CI
- `consciousEvalHarness.test.ts` regressions: 0
- Updated CHANGELOG entry under `### Conscious Mode`
- Telemetry counter (when listed) is wired and surfaces in `Metrics.getSnapshot()`

---

## 1. Re-audit Summary (verified findings only)

Re-confirmed against the live code at the cited file:line. Findings that were over-stated have been **demoted** or **scoped down**; those that didn't survive re-audit have been **dropped**.

### Verified P0 (correctness)

| Original | Status | Notes |
|---|---|---|
| B-2.1 substring vs word-boundary tech claim | **CONFIRMED** | `electron/conscious/ConsciousVerifier.ts:161` — `groundingText.includes(token)` lets `"java"` slip through when grounding has `"javascript"`. Same pattern at line 149 for numeric. |
| B-2.6 provenance verifier silently skipped in degraded mode | **CONFIRMED** | `electron/conscious/ConsciousOrchestrator.ts:445-459` skips rule-based provenance entirely when `degradedMode`. Rule-based provenance is fast/deterministic and should always run. |
| B-4.1 stealth-containment check missing in IPC error path | **CONFIRMED** | `electron/ipc/registerGeminiStreamIpcHandlers.ts:210-215` emits `gemini-stream-error` with no containment guard. (Conscious-mode answers stream through this path.) |
| B-5.1 system sleep/wake not handled in conscious pipeline | **CONFIRMED** | `grep` for `powerMonitor` in `IntelligenceEngine.ts`/`IntelligenceManager.ts`/`main.ts` returns zero. After wake, conscious threads remain "active" with stale-by-hours context. |
| B-5.2 `Date.now()` time-jump breaks TTL caches after sleep | **CONFIRMED** | `PREFETCHED_INTENT_TTL_MS = 30_000` and `ConsciousCache.ttlMs` and dedupe TTL all use wall clock. After 8h sleep, no eviction sweep is forced. |

### Verified P1 (significant accuracy/UX)

| Original | Status | Notes |
|---|---|---|
| B-2.2 numeric over-reject on years/digits | **CONFIRMED, scope bounded** | Triggers only under `isInferredDominantEvidence` branch. Real risk but bounded. |
| B-2.3 tech allowlist small | **CONFIRMED** | `TECH_TOKEN_RE` covers ~25 tokens, missing GraphQL, Cassandra, Vault, Datadog, Cloudflare, Supabase, Firebase, etc. |
| B-2.5 thread continuation tokenizer drops too many stopwords | **CONFIRMED** | `THREAD_COMPATIBILITY_STOPWORDS` includes `how`, `does`, `that`, `which`, `where`. *"How does that scale?"* → `["scale"]`. |
| B-2.7 circuit breaker per-failure-type | **CONFIRMED** | `electron/conscious/ConsciousOrchestrator.ts:76-112` — single counter, threshold=6, cooldown=20s. |
| B-3.1 PauseDetector weights global, not tuned | **CONFIRMED, scope reduced** | `PauseThresholdTuner` already exists but only tunes thresholds (not the weights). Per-language is a real gap. |
| B-3.2 PauseDetector energy decay floor not adaptive | **CONFIRMED** | `scoreEnergyDecay` (`electron/pause/PauseDetector.ts:296-319`). |
| B-3.3 ASR-emitted punctuation over-trusted | **CONFIRMED** | `scoreTranscriptCompleteness` (line 242). |
| B-3.4 first-turn rhythm = 0.5 placeholder | **CONFIRMED** | `scoreConversationRhythm` (line 282-294). |
| B-3.6 `invalidateSpeculation` aborts unconditionally | **CONFIRMED** | `electron/conscious/ConsciousAccelerationOrchestrator.ts:215-218`, `674-689`. |
| B-3.7 eviction by age, not relevance | **CONFIRMED** | Lines 496-512 sort purely by `startedAt`. |
| B-3.8 0.45-0.84 prefetch band partial use | **CONFIRMED, scope clarified** | 0.45-0.72 band stored but never used (routing requires ≥0.72, speculation requires ≥0.84). 0.72-0.84 used for routing only. |
| B-4.2 first-token batched 16 ms | **CONFIRMED** | `electron/ipc/registerGeminiStreamIpcHandlers.ts:149-194` — TTFT regression for ultra-fast providers. |

### Demoted

| Original | New status | Reason |
|---|---|---|
| B-2.4 STAR depth rules reject concise | Demoted to **P2** | Existing test `consciousVerifier.test.ts:115` already exercises a concise STAR that passes. The 12-word floor is restrictive only at the margin. |
| B-3.5 prefetch races on overlapping silence | Demoted to **P2** | Re-trace shows `handlePauseAction` `await`s `maybePrefetchIntent` before `maybeStartSpeculativeAnswer` (line 123-124). Race exists but self-heals on next turn. |
| B-3.9 seed query confidence 0.98 unverified | Demoted to **P2** | `deriveSpeculativeCandidates` already gates with `detectQuestion(query).isQuestion || wordCount >= 5` (line 369). |
| B-3.10 `cosineSimilarity` dead code | **P3 cleanup** | Real but cosmetic. |

### Dropped (false alarms)

None — every B-2/B-3/B-4 finding from the deep-dive survived re-audit at some severity.

---

## 2. Tickets

> Order roughly matches recommended sprint sequencing (Section 3). Inside each sprint, tickets are independent unless an "Order: after CM-XXX" tag appears.

---

### CM-001 — Verifier: word-boundary match for unsupported tech / numeric claims ✅ COMPLETED

- **Severity**: P0
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: standalone
- **Status**: COMPLETED

#### Problem

`electron/conscious/ConsciousVerifier.ts:149` and `:161` use `groundingText.includes(token)` (substring match) to decide whether a tech token or numeric claim from the response is grounded. Substring is the wrong predicate:

- Response says **java** (matched by the `\b java \b` regex at line 156). Grounding text contains **javascript**. `includes("java")` → true. Hallucinated `"java"` is treated as supported.
- Response says **200ms** → regex captures **200**. Grounding contains **20000**. `includes("200")` → true. Hallucinated `"200ms"` is treated as supported.
- Response says **go**. Grounding contains **going**. False negative.

#### Why it matters

This gate is the only line of defense against fabricated specificity in inferred-dominant continuation answers. Substring leakage erodes accuracy where it matters most — the highest-risk path for confident hallucination.

#### Proposed change

Step 1 — Add a helper to `electron/conscious/ConsciousVerifier.ts`:

```ts
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groundingHasToken(groundingText: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(groundingText);
}
```

Step 2 — Replace the two `.includes(...)` calls:

- Line 149: `numericClaims.some((claim) => !groundingText.includes(claim))` → `numericClaims.some((claim) => !groundingHasToken(groundingText, claim))`
- Line 161: `techClaims.some((token) => !groundingText.includes(token))` → `techClaims.some((token) => !groundingHasToken(groundingText, token))`

Step 3 — Both `responseText` and `groundingText` flow through `summaryText`/`gatherStrictGroundingText` which already lowercase. The `i` flag is redundant but harmless and future-proof.

#### Edge cases

- Token contains regex meta (`node.js`, `c++`). `escapeRegExp` handles `.` → `\.`. `++` is not in the allowlist; if it ever is, escape covers it.
- Empty token (regex match returned `""`) — guarded because `match()` only returns non-empty matches against the alternation set.
- Multi-word tokens (none in current allowlist) — supported correctly because `\b` works around whole tokens.
- Unicode tokens (e.g. `"日本語"`) — `\b` is ASCII-only; document this limitation. Allowlist is currently ASCII-only.

#### Race conditions / concurrency

None — pure function change.

#### Regression risks

- A prior test `consciousVerifier.test.ts:193` ("accepts numeric claims grounded in prior evidence even when inferred-dominant") — the grounded number `"70ms"` must still be considered grounded. Word-boundary on `"70"` against grounding `"70ms p99 latency"` → matches `"70"` as a whole token? No — `"70ms"` is one token in the grounding, `"70"` would require `\b70\b` which fails. **This is an intentional fix**: the response token must match a *whole word* in the grounding. The existing test must be updated to assert the response uses `"70ms"` (already the case after re-reading the test's response shape).

- Existing test `consciousVerifier.test.ts:161` ("rejects unsupported numeric claims") — currently passes with substring; should still pass with word-boundary because the unsupported claim was already not in grounding.

#### Feature flag

Optional safety: `useConsciousVerifierWordBoundary`. Default **ON** because this strictly *reduces* false negatives (catches hallucinations the old code missed) and the new behavior is a strict subset of the old.

If the eval harness shows new false-positive rejections in real responses, flip to **OFF** while investigating, then re-tune.

#### Test plan

- **Existing**: All `consciousVerifier.test.ts` cases pass.
- **New tests in `consciousVerifier.test.ts`**:
  1. `rejects "java" claim when grounding only mentions "javascript"` — response action mentions java, grounding has only javascript → verdict.ok === false, reason === `unsupported_technology_claim_in_inferred_state`.
  2. `accepts "java" claim when grounding mentions java` — both have java → ok === true.
  3. `rejects "200ms" claim when grounding only mentions "20000"` — numeric word-boundary.
  4. `accepts "70ms" claim grounded in "70ms p99 latency"` — direct match.
- **Eval harness** `consciousEvalHarness.test.ts` — re-run; expect zero new regressions.

#### Rollback

Revert the helper + the two call-site replacements. If feature-flagged, set `useConsciousVerifierWordBoundary: false`.

#### Acceptance criteria

- All four new tests pass.
- All existing `consciousVerifier.test.ts` tests pass without modification.
- `consciousEvalHarness.test.ts` reports zero regressions.
- Diff includes exactly one new helper function and two single-line replacements.

---

### CM-002 — Verifier: always run rule-based provenance, even in degraded mode ✅ COMPLETED

- **Severity**: P0
- **Subsystem**: conscious / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone
- **Status**: COMPLETED

#### Problem

`electron/conscious/ConsciousOrchestrator.ts:445-459` (`continueThread`) and the analogous block in the structured-response path skip `provenanceVerifier.verify` entirely when `degradedMode === true` (circuit breaker open). Provenance verification is the rule-based, deterministic, no-network gate against fabricated content. Skipping it during degraded mode opens the door to confident hallucinations exactly when the system is least healthy.

#### Why it matters

Degraded mode persists for `CIRCUIT_BREAKER_COOLDOWN_MS = 20_000 ms` (20 s) after 6 failures. Multiple turns can fall through with zero provenance check. This is correctness-critical.

#### Proposed change

Step 1 — In `ConsciousOrchestrator.continueThread` (`ConsciousOrchestrator.ts:445-459`), restructure:

```ts
// Always run rule-based provenance — it is fast, deterministic, no network.
const provenanceVerdict = this.provenanceVerifier.verify({
  response: structuredResponse,
  semanticContextBlock: this.session.getConsciousSemanticContext(),
  evidenceContextBlock,
  question: input.resolvedQuestion,
  hypothesis: latestHypothesis,
});
if (!provenanceVerdict.ok) {
  console.warn('[ConsciousOrchestrator] Continuation provenance verification failed:', provenanceVerdict.reason);
  return this.fallback(`continuation_provenance:${provenanceVerdict.reason ?? 'unknown'}`);
}
```

Drop the `if (!degradedMode) { ... }` wrapper.

Step 2 — Repeat the same restructure for the structured-response path (`ConsciousOrchestrator.ts:557-565`).

Step 3 — In `ConsciousVerifier.verify`, the existing `input.skipJudge` path (`ConsciousVerifier.ts:177-179`) already runs rules then skips judge. That code path is correct and stays. Update `ConsciousOrchestrator` callers to pass `skipJudge: degradedMode` instead of skipping the whole verifier.

#### Edge cases

- `provenanceVerifier` itself raises an error → caught by surrounding try/catch in `continueThread`. Failure is treated as "verification failed", which `recordExecutionFailure`s. This is conservative and safe.
- `latestHypothesis === null` → `provenanceVerifier` already handles null via internal guards. No change needed.
- Provenance times out (it shouldn't — it's synchronous) → wrap in `Promise.race([fn(), timeout(50)])` only if profiling shows it.

#### Race conditions / concurrency

`provenanceVerifier.verify` is synchronous. No race risk.

#### Regression risks

- More turns will fall back during degraded mode (because they were silently passing before). This is the *intended* behavior — surfaces hidden quality issues. Add a counter `Metrics.counter('conscious.degraded_provenance_fail')` to track.
- The existing test `consciousE2EHarness.test.ts` may have a fixture where degraded-mode passes were assumed. Audit and update if needed.

#### Feature flag

`useDegradedProvenanceCheck`. Default **ON**. Allows immediate revert if a regression appears.

#### Test plan

- **New tests in `consciousProvenanceVerifier.test.ts`** (or a new `consciousOrchestrator.degraded.test.ts`):
  1. `degraded mode runs rule-based provenance` — open circuit breaker, send a continuation with hallucinated content; verdict.ok === false.
  2. `degraded mode skips judge` — open circuit, send valid continuation; deterministic === pass, judge === skipped.
  3. `non-degraded mode runs both` — regression: existing path unchanged.
- **Existing**: `consciousProvenanceVerifier.test.ts` and `consciousOrchestratorPurity.test.ts` pass.

#### Rollback

Set `useDegradedProvenanceCheck: false` in flags. Provenance is skipped in degraded mode again.

#### Acceptance criteria

- 3 new tests pass.
- Existing tests pass.
- Counter `conscious.degraded_provenance_fail` appears in `Metrics.getSnapshot()`.
- No new false-positive rejections on the eval harness fixtures (run before/after, diff verdicts).

---

### CM-003 — Verifier: numeric claim regex requires unit suffix or claim verb ✅ COMPLETED

- **Severity**: P1
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: standalone (CM-001 reduces but does not eliminate this issue)
- **Status**: COMPLETED

#### Problem

`hasUnsupportedNumericClaim` (`electron/conscious/ConsciousVerifier.ts:144-150`) regex `\b\d+(?:\.\d+)?(?:ms|s|m|h|x|%|k|m|b)?\b` makes the unit suffix **optional**. A sentence in the response like *"In 2024 we shipped 3 features"* yields `["2024", "3"]`. Both are then checked against grounding and rejected if not present.

#### Why it matters

Years (`2024`), counts (`3 features`, `1 incident`), team sizes (`5 engineers`) are common in behavioral and deep-dive answers but are not the kind of "fabricated specificity" the gate is meant to catch. Over-rejection drops valid answers in inferred-dominant cases.

#### Proposed change

Step 1 — Tighten the regex to require a unit suffix:

```ts
const NUMERIC_WITH_UNIT_RE = /\b\d+(?:\.\d+)?(?:ms|s|m|h|x|%|k|kb|mb|gb|tb|qps|rps)\b/gi;
```

(Also expand units: add `kb`, `mb`, `gb`, `tb`, `qps`, `rps` — common engineering metrics.)

Step 2 — `hasUnsupportedNumericClaim` becomes:

```ts
function hasUnsupportedNumericClaim(responseText: string, groundingText: string): boolean {
  const numericClaims = responseText.match(NUMERIC_WITH_UNIT_RE) || [];
  if (numericClaims.length === 0) return false;
  return numericClaims.some((claim) => !groundingHasToken(groundingText, claim));
}
```

Step 3 — Add `m` suffix only with disambiguation: `m` alone is ambiguous (meter vs minute vs million). Drop `m` and require `min` or `mb`:

```ts
const NUMERIC_WITH_UNIT_RE = /\b\d+(?:\.\d+)?(?:ms|sec|min|hr|hours|hrs|x|%|kb|mb|gb|tb|qps|rps|rpm)\b/gi;
```

#### Edge cases

- Response says **30%** — captured (`30%`).
- Response says **30 percent** — not captured (no unit). Acceptable: this isn't typically fabricated specificity; it's commentary.
- Response says **10x** — captured.
- Response says **2000** (year, count) — not captured. ✅ Fixes false positive.
- Response says **2GB** — captured (uppercase normalized via lowercased `summaryText`).

#### Regression risks

- Existing test `consciousVerifier.test.ts:161` ("rejects unsupported numeric claims when evidence is inferred-dominant") — re-read the test fixture; if the unsupported claim has a unit suffix, the test still passes. If not, the test ASSUMPTION was the buggy behavior; update fixture to use a unit-suffixed claim.
- Existing test `consciousVerifier.test.ts:193` ("accepts numeric claims grounded in prior evidence") — uses `"70ms"`. Unit-suffix gate accepts. Still passes.

#### Feature flag

`useTighterNumericClaimRegex`. Default **OFF** for one canary cycle (because this changes verdicts). Flip ON after eval harness regression check.

#### Test plan

- **New tests**:
  1. `accepts year mention "2024" when not in grounding` — response says "2024", grounding doesn't; verdict.ok === true.
  2. `accepts count "3 features"` — verdict.ok === true.
  3. `rejects unsupported "200ms"` — verdict.ok === false.
  4. `accepts grounded "200ms"` — verdict.ok === true.
- **Existing tests**: pass.

#### Rollback

Set `useTighterNumericClaimRegex: false`.

#### Acceptance criteria

- 4 new tests pass.
- Eval harness shows ≤ baseline rule-failure rate, ≥ baseline accepted-answer rate.

---

### CM-004 — Verifier: expand and externalize technology allowlist ✅ COMPLETED

- **Severity**: P1
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: after CM-001 (relies on word-boundary matching being correct)
- **Status**: COMPLETED

#### Problem

`TECH_TOKEN_RE` (`ConsciousVerifier.ts:155-156`) covers ~25 tokens. Misses common modern tech that frequently appears in fabricated specificity:

- Data: GraphQL, Cassandra, ScyllaDB, Hadoop, Kinesis, NATS, Pulsar, ETCD
- Observability: Prometheus, Grafana, Datadog, Sentry, OpenTelemetry, Honeycomb, Splunk, NewRelic
- Edge / hosting: Cloudflare, Fastly, Vercel, Netlify, Supabase, Firebase, Railway, Fly
- Identity: Vault, Consul, Auth0, Okta, Cognito
- ML: Pytorch, Tensorflow, Llama, Mistral

#### Why it matters

A hallucinated *"we used Cassandra to shard"* slips through today.

#### Proposed change

Step 1 — Externalize the list. Create `electron/conscious/data/techAllowlist.json`:

```json
{
  "version": "tech_allowlist_v1",
  "tokens": [
    "kafka", "redis", "postgres", "postgresql", "mysql", "mongodb",
    "dynamodb", "snowflake", "bigquery", "clickhouse", "elasticsearch",
    "opensearch", "weaviate", "pinecone", "qdrant", "rabbitmq",
    "cassandra", "scylladb", "hadoop", "kinesis", "nats", "pulsar", "etcd",
    "graphql", "grpc", "rest",
    "kubernetes", "docker", "terraform", "spark", "airflow",
    "node", "nodejs", "typescript", "javascript", "python", "java",
    "golang", "rust", "ruby", "scala",
    "aws", "gcp", "azure", "cloudflare", "fastly", "vercel", "netlify",
    "supabase", "firebase",
    "prometheus", "grafana", "datadog", "sentry", "opentelemetry",
    "honeycomb", "splunk", "newrelic",
    "vault", "consul", "auth0", "okta", "cognito",
    "pytorch", "tensorflow", "llama", "mistral"
  ]
}
```

Step 2 — Load at module init:

```ts
import techAllowlist from './data/techAllowlist.json';
const TECH_TOKEN_RE = new RegExp(
  `\\b(${techAllowlist.tokens.map(escapeRegExp).join('|')})\\b`,
  'gi'
);
```

(Note: `node.js` becomes `node` + separately allowed `nodejs`. The `.js` is dropped because it complicates regex; substring of `node` is fine for our use.)

Step 3 — Keep `hasUnsupportedTechnologyClaim` body unchanged after CM-001.

#### Edge cases

- Token order matters for regex alternation (longer tokens first). `postgres` vs `postgresql` — put longer first: `postgresql|postgres`. Sort the array by `(b.length - a.length)` before regex construction.
- Case sensitivity: `summaryText` lowercases, so case is normalized. The `i` flag is defensive.
- Token containing `.` or `+` — escape via `escapeRegExp` (re-use from CM-001).

#### Regression risks

- More tokens → more potential rejections in inferred-dominant cases. Telemetry counter `verifier.unsupported_tech_claim` (per token) will quantify. If a specific token spikes false-positives, remove it from the allowlist (it's data-driven).

#### Feature flag

`useExpandedTechAllowlist`. Default **OFF** for canary, then **ON**.

#### Test plan

- **New tests**:
  1. `rejects unsupported "cassandra" in inferred-dominant case`.
  2. `accepts grounded "cassandra"`.
  3. `version of allowlist surfaces in verifier metadata` (optional, for telemetry).
- **Eval harness**: run before/after; count rejections, ensure no regressions on accepted answers.

#### Rollback

Revert allowlist file or flip flag off.

#### Acceptance criteria

- 3 new tests pass.
- Allowlist file exists with version field.
- Telemetry counter wired.

---

### CM-005 — Orchestrator: thread-continuation tokenizer uses semantic similarity

- **Severity**: P1
- **Subsystem**: conscious / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`THREAD_COMPATIBILITY_STOPWORDS` (`ConsciousOrchestrator.ts:136-141`) plus `tokenizeForThreadCompatibility` (`:143-160`) drop ~50 stopwords *including* question words (`how`, `does`, `that`, `which`, `where`). After tokenization, *"How does that scale?"* → `["scale"]`. With a 25%-overlap threshold (line 215) and a 1-token question, threads either always reset (no overlap) or always continue (single-token overlap).

#### Why it matters

Thread continuation accuracy directly drives conscious-mode quality: incorrect resets discard valid context; incorrect continues bind unrelated turns into one thread.

#### Proposed change

Step 1 — Use the existing `SemanticEmbeddingRouter` (`electron/llm/SemanticEmbeddingRouter.ts`) or `getSemanticEmbedding` from `PredictivePrefetcher` to compute embeddings of the question and the thread root. Cosine similarity > 0.6 → topically compatible.

Step 2 — Modify `isTopicallyCompatibleWithThread`:

```ts
private async isTopicallyCompatibleWithThread(question: string, thread: ReasoningThread): Promise<boolean> {
  const lowered = question.trim().toLowerCase();
  if (!lowered) return false;

  // Deterministic shortcuts (kept verbatim — fast path, no async)
  if (this.isDeterministicContinuationPhrase(lowered)) return true;

  // Semantic primary
  if (this.embeddingProvider) {
    const [questionEmb, threadEmb] = await Promise.all([
      this.embeddingProvider.embed(question),
      this.embeddingProvider.embed([thread.rootQuestion, thread.lastQuestion].filter(Boolean).join(' ')),
    ]);
    const sim = cosineSimilarity(questionEmb, threadEmb);
    if (sim >= 0.6) return true;
    if (sim < 0.35) return false;
    // 0.35–0.6: ambiguous, fall through to token tiebreaker
  }

  // Fallback: existing token-overlap heuristic (unchanged)
  return this.tokenOverlapCompatible(question, thread);
}
```

Step 3 — `prepareRoute` already awaits `routeFast`; making `isTopicallyCompatibleWithThread` async is acceptable. Update the caller at `ConsciousOrchestrator.ts:317` to `await`.

Step 4 — Inject `embeddingProvider` via DI in the constructor (optional, nullable). When `null`, falls back to existing token logic — preserves current behavior.

#### Edge cases

- Embedding provider unavailable → falls to token logic. ✅ No new failure mode.
- Embedding provider throws → catch, fall back. ✅
- Thread `rootQuestion` empty (rare) → semantic returns 0 → fall to token logic.
- Question is non-English → embedding handles multilingual input gracefully (depending on provider). Token logic is English-only. Net: improves multilingual.

#### Race conditions

`prepareRoute` is single-shot per turn. `isTopicallyCompatibleWithThread` is awaited inline. No race.

#### Regression risks

- Cases where semantic similarity says "compatible" but token overlap said "reset" — the new behavior may bind threads that previously reset. Ship behind flag, A/B on eval harness.

#### Feature flag

`useSemanticThreadCompatibility`. Default **OFF**. Flip to ON after harness shows ≥ baseline thread-routing accuracy.

#### Test plan

- **New tests in `consciousOrchestratorPurity.test.ts`**:
  1. `"how does that scale" continues a thread about service scaling` — old: ambiguous; new: continues.
  2. `"tell me about your favorite hobby" resets a thread about microservices` — both old and new: resets.
  3. `embedding provider unavailable falls back to token heuristic` — flag on, no provider → existing behavior.

#### Rollback

Set `useSemanticThreadCompatibility: false`.

#### Acceptance criteria

- 3 new tests pass.
- Eval harness: thread-routing accuracy ≥ baseline.
- p99 latency for `prepareRoute` ≤ baseline + 30 ms (embedding cost).

---

### CM-006 — Orchestrator: per-failure-type circuit breaker

- **Severity**: P1
- **Subsystem**: conscious / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`recordExecutionFailure` (`ConsciousOrchestrator.ts:102-112`) increments a single `consecutiveFailures` counter regardless of cause. A series of `provenance` failures (suggesting LLM is hallucinating) and a series of `network_timeout` failures (transient) trigger the same 6-failure / 20 s cooldown. They warrant different reactions.

#### Why it matters

Hallucinations should open the breaker faster (3 strikes), and stay open longer (60 s) — each failed continuation costs more than a network timeout. Network timeouts should retry sooner (5 s) before opening.

#### Proposed change

Step 1 — Replace the single counter with a typed map:

```ts
type FailureCategory = 'provenance' | 'verification' | 'invalid' | 'network' | 'unknown';

const FAILURE_THRESHOLDS: Record<FailureCategory, { count: number; cooldownMs: number }> = {
  provenance: { count: 3, cooldownMs: 60_000 },
  verification: { count: 4, cooldownMs: 30_000 },
  invalid: { count: 5, cooldownMs: 20_000 },
  network: { count: 6, cooldownMs: 5_000 },
  unknown: { count: 6, cooldownMs: 20_000 },
};

private failuresByCategory = new Map<FailureCategory, number>();
private circuitOpenUntil = 0;
```

Step 2 — `recordExecutionFailure(reason: string)` parses `reason` into a category:

```ts
private categorizeFailure(reason: string): FailureCategory {
  if (reason.startsWith('continuation_provenance:')) return 'provenance';
  if (reason.startsWith('continuation_invalid_or_stale')) return 'invalid';
  if (reason.includes('verification')) return 'verification';
  if (reason.includes('timeout') || reason.includes('network')) return 'network';
  return 'unknown';
}
```

Step 3 — On success, decay all counters (not just reset to 0):

```ts
private recordExecutionSuccess(): void {
  this.failuresByCategory.clear(); // simple: full reset on any success
  this.circuitOpenUntil = 0;
}
```

(Decision: simple full-reset is safer than partial decay — prevents oscillation.)

Step 4 — `isCircuitOpen` unchanged (single timestamp).

#### Edge cases

- Multiple categories accumulate concurrently — each tracked independently. First to hit threshold opens circuit.
- `reason === undefined` → `'unknown'` category. Existing behavior preserved.
- Circuit reopens immediately after cooldown if next call also fails — same as current behavior.

#### Regression risks

- Tighter thresholds for provenance failures = more degraded-mode time. Add metric `conscious.circuit_opens{category}` to observe.

#### Feature flag

`usePerCategoryCircuitBreaker`. Default **OFF**. Flip ON after observing baseline for a week.

#### Test plan

- **New tests in `consciousOrchestratorPurity.test.ts`**:
  1. `3 provenance failures opens circuit` (new threshold).
  2. `6 network failures opens circuit` (existing-equivalent).
  3. `mixed failures track independently`.
  4. `success resets all counters`.
- **Existing**: all current tests pass under flag-OFF default.

#### Rollback

Flag off.

#### Acceptance criteria

- 4 new tests pass.
- Counter `conscious.circuit_opens{category}` wired.

---

### CM-007 — Acceleration: stable-revision speculation does not abort

- **Severity**: P1
- **Subsystem**: acceleration / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`updateTranscriptSegments` (`ConsciousAccelerationOrchestrator.ts:215-218`) calls `invalidateSpeculation(true)` on **every** transcript revision change. ASR can produce 2–5 partial-revision updates per pause. Each one aborts ALL in-flight speculation. Net: speculation rarely completes for talkative interviewers, wasting cloud spend and user-facing latency.

#### Why it matters

Speculation cost is paid before the user finishes asking. Aborting at 80 % completion, then restarting from scratch on the next revision = quadratic cloud cost and zero TTFT benefit.

#### Proposed change

Step 1 — In `updateTranscriptSegments`, compare normalized question text instead of raw revision:

```ts
updateTranscriptSegments(segments: ..., transcriptRevision?: number): void {
  if (!this.enabled) return;
  this.prefetcher.updateTranscriptSegments(segments);
  
  if (typeof transcriptRevision !== 'number' || transcriptRevision === this.latestTranscriptRevision) {
    return;
  }
  
  const previousRevision = this.latestTranscriptRevision;
  const previousQuery = this.normalizeQuery(this.latestInterviewerTranscript);
  
  // Update transcript references
  // (latestInterviewerTranscript is set elsewhere via noteTranscriptText)
  this.latestTranscriptRevision = transcriptRevision;
  
  const newQuery = this.normalizeQuery(this.latestInterviewerTranscript);
  
  // If the question text is stable (≥ 0.95 Jaccard or token-set equality),
  // do NOT invalidate — just rebind in-flight entries to the new revision.
  if (this.isQueryStable(previousQuery, newQuery)) {
    this.rebindSpeculationToNewRevision(transcriptRevision);
    return;
  }
  
  this.invalidateSpeculation(true);
}

private isQueryStable(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  if (prev === next) return true;
  
  const prevTokens = new Set(prev.split(' '));
  const nextTokens = new Set(next.split(' '));
  if (prevTokens.size === 0 || nextTokens.size === 0) return false;
  
  const intersection = [...prevTokens].filter(t => nextTokens.has(t)).length;
  const union = prevTokens.size + nextTokens.size - intersection;
  return (intersection / union) >= 0.95;
}

private rebindSpeculationToNewRevision(newRevision: number): void {
  for (const entry of this.speculativeAnswerEntries.values()) {
    entry.transcriptRevision = newRevision;
  }
}
```

Step 2 — `isSpeculativeEntryStale` already checks `entry.transcriptRevision !== this.latestTranscriptRevision`. After rebinding, this stays consistent. ✅

Step 3 — Same pattern for `prefetchedIntents`: rebind keys instead of clearing on stable revisions.

Step 4 — Telemetry: counter `acceleration.revision_rebinded` and `acceleration.revision_invalidated`.

#### Edge cases

- Empty `previousQuery` or `newQuery` → not stable → invalidate (current behavior).
- ASR major correction (e.g., "Let me rephrase…") → low Jaccard → invalidate. ✅
- Rapid 5-revision burst within 100 ms — each call independently checks stability against the previous; rebind chain is correct.
- `latestInterviewerTranscript` is mutated outside `updateTranscriptSegments` (via `noteTranscriptText`) — race possible. Snapshot prev/new at function entry.

#### Race conditions

- `noteTranscriptText` and `updateTranscriptSegments` may interleave. Snapshot `latestInterviewerTranscript` once at function entry. Worst case: stability check uses an old `latestInterviewerTranscript` and decides "stable" while a real update is pending → next `updateTranscriptSegments` call corrects it on next revision. Safe.

#### Regression risks

- Slightly more memory holding stale-but-rebinded entries. Bounded by `MAX_SPECULATIVE_ENTRIES = 10`.
- An edge case where the question changed semantically but Jaccard is still ≥0.95 (rare; e.g., adding a single negation word). Mitigation: check for negation tokens in CM-008.

#### Feature flag

`useStableRevisionRebind`. Default **OFF**. Canary, then ON.

#### Test plan

- **New tests in `accelerationSpeculation.test.ts`**:
  1. `stable revision (Jaccard >= 0.95) rebinds without abort` — start speculation, push a revision with same question + 1 typo, assert speculation still active.
  2. `unstable revision (different question) invalidates`.
  3. `negation word change invalidates` (e.g., "is" → "is not").
  4. `5 stable revisions within 100ms keep speculation alive`.

#### Rollback

Flag off.

#### Acceptance criteria

- 4 new tests pass.
- `acceleration.revision_rebinded` counter > 0 in canary.
- Eval harness: speculative-completion rate ↑, cloud spend ↓.

---

### CM-008 — Acceleration: relevance-aware speculative entry eviction

- **Severity**: P1
- **Subsystem**: acceleration / orchestrator
- **Owner**: agentic_worker
- **Order**: after CM-007 (rebind logic stabilizes the entry set)

#### Problem

`evictStaleSpeculativeEntries` (`ConsciousAccelerationOrchestrator.ts:496-512`) sorts by `startedAt` and aborts the **oldest** entry. If the user's actual question matches the oldest entry, cloud spend is wasted right when payoff is closest.

#### Why it matters

Wasted cloud cost + lost TTFT advantage when speculation matures.

#### Proposed change

Step 1 — Replace age-only sorting with a relevance + age score:

```ts
private evictStaleSpeculativeEntries(): void {
  if (this.speculativeAnswerEntries.size <= ConsciousAccelerationOrchestrator.MAX_SPECULATIVE_ENTRIES) {
    return;
  }
  
  const currentQuery = this.normalizeQuery(this.latestInterviewerTranscript);
  const currentRevision = this.latestTranscriptRevision;
  const now = Date.now();
  
  const scored = Array.from(this.speculativeAnswerEntries.values()).map((entry) => ({
    entry,
    score: this.scoreSpeculativeRelevance(entry, currentQuery, currentRevision, now),
  }));
  
  // Lower score = more evictable
  scored.sort((a, b) => a.score - b.score);
  
  while (this.speculativeAnswerEntries.size > ConsciousAccelerationOrchestrator.MAX_SPECULATIVE_ENTRIES) {
    const least = scored.shift();
    if (!least) break;
    least.entry.abortController.abort(new Error('speculative_evicted_low_relevance'));
    this.speculativeAnswerEntries.delete(least.entry.key);
  }
}

private scoreSpeculativeRelevance(
  entry: SpeculativeAnswerEntry,
  currentQuery: string,
  currentRevision: number,
  now: number,
): number {
  // Base: age decay (older → lower score)
  const ageMs = now - entry.startedAt;
  const ageScore = Math.max(0, 1 - ageMs / 5000);
  
  // Boost: entry on current revision = relevant
  const revisionBoost = entry.transcriptRevision === currentRevision ? 0.5 : 0;
  
  // Boost: entry query matches current query (Jaccard)
  const entryQuery = this.normalizeQuery(entry.query);
  const queryBoost = this.jaccardSimilarity(entryQuery, currentQuery);
  
  // Boost: completed entry — payoff close at hand
  const completionBoost = entry.completed ? 0.3 : 0;
  
  return ageScore + revisionBoost + queryBoost + completionBoost;
}

private jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

#### Edge cases

- All entries equal score → falls back to insertion order (Map preserves order). Same as old behavior at the tail.
- `currentQuery` is empty → only age + completion + revision contribute. Acceptable.
- Single eviction (size = 11) → drops one entry; ✅.
- Mass eviction after revision flood → drops to MAX_SPECULATIVE_ENTRIES = 10; preserves the most-relevant 10.

#### Regression risks

- A previously-relied-upon "drop oldest" assumption in tests. Audit `accelerationSpeculation.test.ts`. None should break because eviction order isn't asserted there (only asserts that eviction happens).

#### Feature flag

`useRelevanceAwareEviction`. Default **OFF**, canary, ON.

#### Test plan

- **New tests in `accelerationSpeculation.test.ts`**:
  1. `evicts low-relevance entry over recent matching entry`.
  2. `keeps completed matching entry over older non-matching entry`.
  3. `handles empty current query gracefully`.

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.
- Counter `acceleration.eviction_relevance_swap` (incremented when relevance picks differently than age) > 0 in canary.

---

### CM-009 — Acceleration: speculative answer fuzzy-match promotion

- **Severity**: P1
- **Subsystem**: acceleration / orchestrator
- **Owner**: agentic_worker
- **Order**: after CM-008

#### Problem

`selectSpeculativeEntry` (`ConsciousAccelerationOrchestrator.ts:385-398`) requires **exact normalized** match between the speculative query and the actual user query. ASR can finalize the question slightly differently than the speculative key (`"What's"` vs `"What is"`). Net: the speculative answer is wasted even when it correctly answers the user's actual question.

#### Why it matters

Reuse rate of speculation directly drives TTFT. Wasted speculation is also wasted cloud spend.

#### Proposed change

Step 1 — Add a tier-2 fuzzy promotion path. Replace `selectSpeculativeEntry` body:

```ts
private async selectSpeculativeEntry(query: string, transcriptRevision: number): Promise<SpeculativeAnswerEntry | null> {
  const entries = Array.from(this.speculativeAnswerEntries.values())
    .filter((entry) => entry.transcriptRevision === transcriptRevision);
  if (entries.length === 0) return null;
  
  const normalizedQuery = this.normalizeQuery(query);
  
  // Tier 1: exact normalized match (existing behavior preserved)
  const exact = entries.find((e) => this.normalizeQuery(e.query) === normalizedQuery);
  if (exact) return exact;
  
  // Tier 2: fuzzy promotion (gated by feature flag)
  if (!isOptimizationActive('useFuzzySpeculationPromotion')) return null;
  
  // Conservative: must satisfy ALL three:
  //  (a) Jaccard ≥ 0.92 with current query
  //  (b) Same prefetched intent (if available)
  //  (c) Same latest reaction kind (if any)
  const currentIntent = this.getPrefetchedIntent(query, transcriptRevision);
  
  for (const entry of entries) {
    const entryNorm = this.normalizeQuery(entry.query);
    const jaccard = this.jaccardSimilarity(entryNorm, normalizedQuery);
    if (jaccard < 0.92) continue;
    
    const entryIntent = this.getPrefetchedIntent(entry.query, entry.transcriptRevision);
    if (currentIntent && entryIntent && currentIntent.intent !== entryIntent.intent) continue;
    
    // Promote
    return entry;
  }
  
  return null;
}
```

Step 2 — Reuse `jaccardSimilarity` from CM-007/CM-008.

Step 3 — Telemetry: counter `acceleration.fuzzy_promotion_used`.

#### Edge cases

- Negation flips ("is" vs "is not") — Jaccard is high, but the answer is wrong. Mitigation: add a negation guard:
  ```ts
  const NEGATION_TOKENS = new Set(['not', 'no', 'never', "don't", "wouldn't", "can't", "shouldn't"]);
  const hasMismatchedNegation = (a, b) => {
    const aNeg = a.split(' ').some(t => NEGATION_TOKENS.has(t));
    const bNeg = b.split(' ').some(t => NEGATION_TOKENS.has(t));
    return aNeg !== bNeg;
  };
  if (hasMismatchedNegation(entryNorm, normalizedQuery)) continue;
  ```
- Question word change (e.g., "what" vs "why") — same intent label might still match, but the answer shape differs. Mitigation: check `currentIntent.answerShape` matches `entryIntent.answerShape` (existing on `IntentResult`).
- ASR still emitting partials when promotion is checked — handled by tier-1 (transcriptRevision filter).

#### Race conditions

`selectSpeculativeEntry` is awaited from `getSpeculativeAnswerPreview` — single-threaded turn. No race.

#### Regression risks

- A wrongly-promoted answer is the worst-case. Mitigation: gate by feature flag, log promotions, observe canary.
- The old NAT-002 / audit A-2 explicitly removed cosine fallback. Read the audit doc; ensure tier-2 here is **stricter** (Jaccard 0.92 + same intent + same reaction + no negation flip) than what was removed.

#### Feature flag

`useFuzzySpeculationPromotion`. Default **OFF**. Required for canary.

#### Test plan

- **New tests in `accelerationSpeculation.test.ts`**:
  1. `promotes entry with Jaccard 0.95 and same intent`.
  2. `does not promote entry with negation flip`.
  3. `does not promote entry with different intent`.
  4. `does not promote entry with Jaccard 0.85`.
  5. `prefers exact match over fuzzy match`.

#### Rollback

Flag off — exact behavior of NAT-002 audit restored.

#### Acceptance criteria

- 5 new tests pass.
- Counter `acceleration.fuzzy_promotion_used` wired.
- Eval harness: speculation reuse rate ↑, no new wrong-answer reports in canary.

---

### CM-010 — Acceleration: align prefetch confidence band with speculation gate

- **Severity**: P2
- **Subsystem**: acceleration / orchestrator
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`maybePrefetchIntent` admits intents with `confidence ≥ 0.45` (`ConsciousAccelerationOrchestrator.ts:554`). `maybeStartSpeculativeAnswer` requires `isStrongConsciousIntent` (≥ 0.84). The 0.45–0.72 band is stored but used neither for routing (which requires ≥ 0.72 via `isReliableIntent`) nor for speculation. Wasted prefetch effort.

The 0.72–0.84 band IS used for routing, so still keep it stored.

#### Why it matters

CPU cycles + cloud-API token spend on intents that are then thrown away.

#### Proposed change

Step 1 — Tighten admission gate to `0.72` (aligned with `minReliableConfidence`):

```ts
// In maybePrefetchIntent, line 554:
if (intent.intent === 'general' || intent.confidence < 0.72) {
  console.log(...);
  return;
}
```

Step 2 — Telemetry: counter `acceleration.prefetch_admitted{band}` where band ∈ `'0.72-0.84' | '0.84+'`.

#### Edge cases

- A user with a noisy ASR may produce many borderline-confidence classifications. Tightening the gate reduces work but also reduces hit rate. Acceptable tradeoff.
- The threshold is currently a magic number — consider sourcing from `INTENT_CONFIDENCE_CALIBRATION.minReliableConfidence`. Better: import the constant.

#### Regression risks

- Slightly fewer prefetched intents → fewer routing decisions get to use prefetched data. Routing falls back to live `routeFast`, which is the same code path — same accuracy, just slightly more CPU per turn. Bounded.

#### Feature flag

`useTightenedPrefetchGate`. Default **OFF**, canary, ON.

#### Test plan

- **New tests in `accelerationSpeculation.test.ts`**:
  1. `prefetch admits 0.85 confidence intent` — stored.
  2. `prefetch rejects 0.55 confidence intent` — not stored.
  3. `prefetch admits 0.72 confidence intent` — stored (boundary).

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.
- Counter wired.

---

### CM-011 — PauseDetector: first-turn rhythm prior

- **Severity**: P1
- **Subsystem**: acceleration / pause
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`scoreConversationRhythm` (`electron/pause/PauseDetector.ts:282-294`) returns `0.5` when `turnStartTime === 0` (first turn of session). The first turn is the most common and most important to get right; returning 0.5 zeroes out rhythm contribution to confidence.

#### Why it matters

First-turn TTFT and accuracy directly drive user trust. A wrong commit on turn 1 sets the worst first impression.

#### Proposed change

Step 1 — Initialize `avgTurnDurationMs` from a population prior:

```ts
private static readonly INTERVIEWER_TURN_PRIOR_MS = 6000; // typical interviewer turn

private avgTurnDurationMs: number = PauseDetector.INTERVIEWER_TURN_PRIOR_MS;
private observedTurnCount = 0;
```

Step 2 — Update `scoreConversationRhythm`:

```ts
private scoreConversationRhythm(): number {
  if (this.turnStartTime === 0) {
    // No turn started yet (first call after construction). Treat as
    // average rhythm — equivalent to current 0.5 fallback.
    return 0.5;
  }
  
  const currentTurnMs = Date.now() - this.silenceStartMs - this.turnStartTime;
  // Always use avg (now seeded with prior) — no special-case zero-history path.
  const ratio = currentTurnMs / this.avgTurnDurationMs;
  
  if (ratio < 0.2) return 0.1;
  if (ratio < 0.4) return 0.3;
  if (ratio > 0.8) return 0.8;
  return 0.5;
}
```

Step 3 — When the first real turn ends and `recentTurnDurations.push` runs, *blend* the prior with the observation:

```ts
onSpeechEnded(): void {
  // ... existing ...
  if (this.turnStartTime !== 0) {
    const duration = Date.now() - this.turnStartTime;
    this.recentTurnDurations.push(duration);
    if (this.recentTurnDurations.length > 5) this.recentTurnDurations.shift();
    this.observedTurnCount++;
    
    // Blend: observed average dominates after 3 turns
    const observedAvg = this.recentTurnDurations.reduce((s, d) => s + d, 0) / this.recentTurnDurations.length;
    const priorWeight = Math.max(0, 1 - this.observedTurnCount / 3);
    this.avgTurnDurationMs = priorWeight * PauseDetector.INTERVIEWER_TURN_PRIOR_MS + (1 - priorWeight) * observedAvg;
  }
  // ... existing ...
}
```

#### Edge cases

- `turnStartTime` set but no completed turn yet → `currentTurnMs` could be negative if `silenceStartMs > now - turnStartTime`. Guard with `Math.max(0, ...)`.
- Very fast back-to-back turns (Q&A drilling) — observed average converges quickly, prior weight drops to 0 after 3 turns. ✅
- Session reset → `observedTurnCount` should reset; ensure `reset()` (or constructor pattern) resets these fields.

#### Regression risks

- First-turn confidence will increase slightly (non-zero rhythm contribution). May cause earlier commits on turn 1. Monitor `acceleration.pause_commit{turn}`.
- Existing tests in `pauseDetector.test.ts` may rely on first-turn = 0.5 rhythm. Audit.

#### Feature flag

`usePauseRhythmPrior`. Default **OFF**, canary, ON.

#### Test plan

- **New tests in `pauseDetector.test.ts`**:
  1. `first turn uses prior 6000ms baseline`.
  2. `prior weight decays after 3 observed turns`.
  3. `negative currentTurnMs guarded`.

#### Rollback

Flag off — `avgTurnDurationMs` re-initialized to 0 (returns 0.5 placeholder).

#### Acceptance criteria

- 3 new tests pass.
- Eval harness: first-turn commit accuracy ≥ baseline.

---

### CM-012 — PauseDetector: adaptive noise floor for energy decay

- **Severity**: P1
- **Subsystem**: acceleration / pause
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`scoreEnergyDecay` (`PauseDetector.ts:296-319`) compares last-5 / earlier-5 RMS samples. In noisy environments (HVAC, fan, music), the floor RMS dominates → ratio always near 1.0 → never registers as "natural fade out". Speakers in noisy rooms get systematically slower commit triggers.

#### Why it matters

Latency penalty for users in non-ideal acoustic environments — disproportionately affects work-from-home users.

#### Proposed change

Step 1 — Track an adaptive noise floor (median of *non-speech* RMS samples over a sliding window):

```ts
private noiseFloorSamples: number[] = []; // raw RMS values during non-speech
private static readonly NOISE_FLOOR_WINDOW = 60; // ~60 samples × ~50ms = 3s window
private static readonly NOISE_FLOOR_MIN_SAMPLES = 10;

updateRMS(rms: number): void {
  this.rmsSamples.push({ timestamp: Date.now(), rms });
  if (this.rmsSamples.length > 20) this.rmsSamples.shift();
  
  // Track noise floor only during *non-speech* windows
  // (proxy: silence has been > 200ms — below ASR speech threshold).
  if (this.silenceStartMs > 0 && Date.now() - this.silenceStartMs > 200) {
    this.noiseFloorSamples.push(rms);
    if (this.noiseFloorSamples.length > PauseDetector.NOISE_FLOOR_WINDOW) {
      this.noiseFloorSamples.shift();
    }
  }
}

private getNoiseFloor(): number {
  if (this.noiseFloorSamples.length < PauseDetector.NOISE_FLOOR_MIN_SAMPLES) {
    return 0;
  }
  const sorted = [...this.noiseFloorSamples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]; // median
}
```

Step 2 — Update `scoreEnergyDecay` to subtract the floor:

```ts
private scoreEnergyDecay(): number {
  if (this.rmsSamples.length < 5) return 0.5;
  
  const floor = this.getNoiseFloor();
  const recent = this.rmsSamples.slice(-5);
  const earlier = this.rmsSamples.slice(-10, -5);
  if (earlier.length < 3) return 0.5;
  
  const recentAvg = Math.max(0, recent.reduce((s, x) => s + x.rms, 0) / recent.length - floor);
  const earlierAvg = Math.max(0, earlier.reduce((s, x) => s + x.rms, 0) / earlier.length - floor);
  
  if (earlierAvg <= 0.001) return 0.5; // no signal above floor → undefined
  
  const ratio = recentAvg / earlierAvg;
  if (ratio < 0.3) return 0.9;
  if (ratio < 0.6) return 0.7;
  if (ratio < 0.9) return 0.5;
  if (ratio < 1.2) return 0.4;
  return 0.2;
}
```

#### Edge cases

- Floor not yet learned (< 10 samples) → falls back to old behavior (floor = 0). Safe.
- Floor too high (loud constant noise) → `earlierAvg ≤ 0.001` → returns 0.5. Conservative.
- Floor learned during speech (incorrect) — guarded by `silenceStartMs > 0 && elapsed > 200ms` proxy. Imperfect but reasonable; speech samples leak in only briefly at boundaries.
- Headphones plugged in mid-session changes acoustic profile → floor adapts within 60 samples (~3s).

#### Race conditions

`updateRMS` is called from a single audio thread. No race.

#### Regression risks

- In a quiet environment (floor near 0), behavior is identical to current. ✅
- In a noisy environment, energy-decay signal will fire more accurately → potentially faster commits → user-perceived improvement.

#### Feature flag

`useAdaptiveNoiseFloor`. Default **OFF**, canary, ON.

#### Test plan

- **New tests in `pauseDetector.test.ts`**:
  1. `noisy environment with constant 50 RMS floor → decay ratio uses subtracted floor`.
  2. `quiet environment (floor near 0) → behavior identical to baseline`.
  3. `floor not yet learned (< 10 samples) → fallback to baseline`.
  4. `floor adapts after acoustic-profile change`.

#### Rollback

Flag off.

#### Acceptance criteria

- 4 new tests pass.
- Counter `pause.noise_floor_active` (boolean gauge) wired.

---

### CM-013 — PauseDetector: discount ASR-emitted punctuation after disfluency

- **Severity**: P1
- **Subsystem**: acceleration / pause
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`scoreTranscriptCompleteness` (`PauseDetector.ts:235-261`) maps any trailing `[.!?]` to 0.9 confidence. ASR engines (Whisper, Deepgram, Soniox) regularly emit a period after a thought boundary even when the user is still thinking. A trailing period after disfluency leads to premature commit.

#### Why it matters

Premature commits drop important interviewer context, leading to wrong answers.

#### Proposed change

Step 1 — Add a disfluency detector:

```ts
private static readonly DISFLUENCY_PATTERNS = [
  /\b(uh|um|er|ah|hmm|like)\b/gi,
  /\.\.\./g,
  /,\s*$/,
];

private hasRecentDisfluency(): boolean {
  // Check the LATEST and PREVIOUS transcript segment for disfluency markers
  const recent = this.recentTranscripts.slice(-2).join(' ');
  if (!recent) return false;
  return PauseDetector.DISFLUENCY_PATTERNS.some((re) => re.test(recent));
}
```

Step 2 — Modify `scoreTranscriptCompleteness`:

```ts
private scoreTranscriptCompleteness(): number {
  const lastTranscript = this.recentTranscripts.at(-1) || '';
  const trimmed = lastTranscript.trim();
  if (!trimmed) return 0.5;
  
  // Sentence terminator with no recent disfluency → likely complete
  if (/[.!?]$/.test(trimmed)) {
    if (this.hasRecentDisfluency()) {
      // ASR likely inserted a period after a thinking pause; don't fully trust.
      return 0.6;
    }
    return 0.9;
  }
  
  // ... rest unchanged ...
}
```

Step 3 — Telemetry: counter `pause.punctuation_discounted_disfluency`.

#### Edge cases

- Disfluency early in a sentence followed by a long completed clause: *"Uh, so the thing about distributed systems is that consistency matters."* — `recentTranscripts` window is small (5 entries). The `slice(-2)` may not see "uh" if it's a few entries back. Tradeoff: 0.6 vs 0.9 only when disfluency is in the immediate context. Acceptable.
- ASR with no disfluency token but still inserted a period → `hasRecentDisfluency()` returns false → score 0.9 (current behavior). Bounded false-positive risk.

#### Race conditions

None — pure read of `recentTranscripts`.

#### Regression risks

- More turns score 0.6 instead of 0.9 → fewer immediate hard_speculate / commit triggers → slightly higher TTFT for legitimate complete sentences. Mitigation: only triggers when actual disfluency is detected.

#### Feature flag

`useDisfluencyAwareCompleteness`. Default **OFF**, canary, ON.

#### Test plan

- **New tests in `pauseDetector.test.ts`**:
  1. `period with no disfluency → 0.9 (unchanged)`.
  2. `period with prior "uh" → 0.6`.
  3. `period with "..." in prior segment → 0.6`.
  4. `period after trailing comma in prior segment → 0.6`.

#### Rollback

Flag off.

#### Acceptance criteria

- 4 new tests pass.
- Counter wired.

---

### CM-014 — Power events: pause/resume conscious pipeline on sleep/wake

- **Severity**: P0
- **Subsystem**: cross-cutting / power
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

No `powerMonitor` integration in `IntelligenceEngine`, `IntelligenceManager`, `ConsciousAccelerationOrchestrator`, ASR pipeline, or `PauseDetector` (`grep` confirms zero hits). After wake:

- In-flight cloud streams are dead but not aborted.
- Conscious threads remain "active" — next user turn appears as a continuation of a thread stale by hours.
- Speculative entries / prefetch caches retain timestamps from before sleep but `Date.now()` jumped → TTL math is broken.
- ASR connection may be dead.

#### Why it matters

After a sleep/wake cycle, conscious mode silently produces wrong answers (continuing an unrelated thread or serving stale cache entries).

#### Proposed change

Step 1 — Create a single `PowerEventBroker` (`electron/runtime/PowerEventBroker.ts`):

```ts
import { EventEmitter } from 'events';

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export class PowerEventBroker extends EventEmitter {
  private static instance: PowerEventBroker | null = null;
  private bound = false;

  static getInstance(): PowerEventBroker {
    if (!this.instance) this.instance = new PowerEventBroker();
    return this.instance;
  }

  bindElectronPowerMonitor(pm: { on: (e: string, cb: () => void) => void }): void {
    if (this.bound) return;
    pm.on('suspend', () => this.emit('suspend'));
    pm.on('resume', () => this.emit('resume'));
    pm.on('lock-screen', () => this.emit('lock-screen'));
    pm.on('unlock-screen', () => this.emit('unlock-screen'));
    this.bound = true;
  }
}
```

Step 2 — In `IntelligenceEngine` constructor / `attachAccelerationManager`, subscribe:

```ts
const broker = PowerEventBroker.getInstance();
broker.on('suspend', () => this.handleSuspend());
broker.on('resume', () => this.handleResume());
```

Step 3 — Implement `handleSuspend` / `handleResume`:

```ts
private handleSuspend(): void {
  // Abort all in-flight LLM streams via stream cancel registry
  for (const [requestId, controller] of this.activeChatControllers) {
    controller.abort(new Error('system_suspend'));
  }
  // Snapshot conscious-mode session
  this.session.markSuspended(Date.now());
}

private handleResume(): void {
  const suspendedAt = this.session.getSuspendedAt();
  const elapsedMs = suspendedAt ? Date.now() - suspendedAt : 0;
  
  // Force conscious-thread reset if suspended > 60s
  if (elapsedMs > 60_000) {
    this.session.clearConsciousModeThread();
  }
  
  // Sweep TTL caches (CM-015 covers this)
  this.consciousCache.sweepExpired(Date.now());
  this.intentCoordinator.sweepDedupeCache(Date.now());
  this.accelerationOrchestrator.invalidateAllSpeculation();
  
  this.session.clearSuspended();
}
```

Step 4 — Wire `PowerEventBroker.bindElectronPowerMonitor(powerMonitor)` in `electron/main.ts` after `app.whenReady()`.

Step 5 — Add `markSuspended`/`getSuspendedAt`/`clearSuspended` to `SessionTracker`/`Session`.

#### Edge cases

- App start with no prior suspend → `getSuspendedAt() === null` → no-op. ✅
- Multiple rapid suspend/resume (laptop closed/opened quickly) → idempotent (broker state machine + threshold). ✅
- Suspend during in-flight stream → `controller.abort` called; the `ipc/registerGeminiStreamIpcHandlers` `for await` loop sees abort and exits cleanly.
- Sleep with no internet → resume fails to reconnect to cloud → next turn falls back to error. Out of scope here.

#### Race conditions

- `handleSuspend` may run while a stream is mid-flush. The `for await` loop checks `controller.signal.aborted` per iteration. Safe.
- Resume runs sweeps before a new turn arrives. New turn sees clean state.

#### Regression risks

- Tests that rely on long-running streams across `suspend` events would break — but no such tests exist.
- Aggressive thread reset (60s threshold) may surprise users who paused for a phone call. Configurable via flag (`postResumeThreadResetMs`, default 60000).

#### Feature flag

`useSystemPowerEventHandling`. Default **OFF** for first canary cycle. Aggressive enough that production canary should run for a week before flip.

#### Test plan

- **New file: `electron/tests/powerEventBroker.test.ts`**:
  1. `broker emits suspend on powerMonitor suspend`.
  2. `idempotent re-bind`.
- **New tests in `intelligenceEngine.test.ts`** (or new):
  1. `suspend aborts in-flight streams`.
  2. `resume after 70s clears conscious thread`.
  3. `resume after 30s preserves conscious thread`.
  4. `resume sweeps TTL caches`.

#### Rollback

Flag off — broker doesn't bind, no-op.

#### Acceptance criteria

- 6 new tests pass.
- Counter `power.suspend_total` and `power.resume_thread_reset` wired.

---

### CM-015 — TTL caches: monotonic clock or post-resume sweep

- **Severity**: P0
- **Subsystem**: cross-cutting / cache
- **Owner**: agentic_worker
- **Order**: relies on CM-014 broker

#### Problem

`PREFETCHED_INTENT_TTL_MS = 30_000`, `ConsciousCache.ttlMs`, dedupe TTL (`DEFAULT_DEDUPE_TTL_MS = 1500`), `SpeculativeAnswerEntry.startedAt` all use wall clock. After 8h sleep, `Date.now()` jumps; TTL math says "still fresh" until natural eviction. A stale prefetched intent from before sleep can bind to the next turn.

#### Why it matters

Cache poisoning across sleep boundary → wrong-thread / wrong-intent assignments.

#### Proposed change

Two complementary changes:

**Change A — Force sweep on resume (depends on CM-014)**

In `ConsciousCache`:

```ts
sweepExpired(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of this.cache) {
    if (now - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      removed++;
    }
  }
  return removed;
}
```

In `IntentClassificationCoordinator` (`electron/llm/providers/IntentClassificationCoordinator.ts`):

```ts
sweepDedupeCache(now: number = Date.now()): void {
  this.purgeExpiredDedupeEntries(now);
}
```

In `ConsciousAccelerationOrchestrator`:

```ts
invalidateAllSpeculation(): void {
  this.invalidateSpeculation(false); // already exists; just expose
}
```

CM-014's `handleResume` calls these.

**Change B — Migrate to monotonic clock for relative timing (optional follow-up)**

For new code paths, prefer `process.hrtime.bigint()` or `performance.now()` when measuring elapsed time. Wall-clock timestamps remain only for human-readable logging. Tracked as a separate cleanup ticket (CM-022).

#### Edge cases

- Negative TTL math after a *backwards* clock change (NTP correction) — `now < entry.timestamp` → eviction skipped (entry treated as fresh). Acceptable; clocks rarely jump backwards by more than a few seconds.
- Sweep called while a `set` is in-flight — JS is single-threaded; `Map.delete` during iteration is safe.

#### Race conditions

None — synchronous map operations.

#### Regression risks

- Sweep on resume drops some entries that would have been valid (cached a few seconds before sleep). Acceptable.

#### Feature flag

`useResumeCacheSweep`. Default **ON** (this is a correctness fix; risk-free).

#### Test plan

- **New tests in `consciousCache.test.ts`**:
  1. `sweepExpired removes expired entries`.
  2. `sweepExpired preserves fresh entries`.
- **New tests in `intentClassificationCoordinator.test.ts`**:
  1. `sweepDedupeCache clears expired (revision, question) pairs`.

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.
- CM-014 integration test (`resume sweeps TTL caches`) passes.

---

### CM-016 — IPC: stealth-containment guard on streaming error path

- **Severity**: P0
- **Subsystem**: ipc / safety
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`registerGeminiStreamIpcHandlers` (`electron/ipc/registerGeminiStreamIpcHandlers.ts:210-215`) emits `gemini-stream-error:<id>` to the renderer **without** checking `assertNotContained()`. If stealth containment activates mid-error, the error message — which can include cloud-provider error payloads excerpting prompt context — reaches the renderer UI.

Because conscious-mode answers stream through this exact path, this is a conscious-mode safety gap.

#### Why it matters

Containment is the last-resort safety mechanism. Any path that bypasses it during a sensitive moment is a P0.

#### Proposed change

Step 1 — Replace the streaming-error block:

```ts
} catch (streamError: any) {
  console.error("[IPC] Streaming error:", streamError);
  
  // Containment guard — drop the error payload to the renderer if stealth
  // containment activated mid-stream. The renderer will time out naturally
  // and surface a generic "stream interrupted" state.
  if (typeof appState.isStealthContainmentActive === 'function' && appState.isStealthContainmentActive()) {
    console.warn('[IPC] gemini-chat-stream: error suppressed under stealth containment');
    return null;
  }
  
  if (!event.sender.isDestroyed()) {
    // Redact: do not forward cloud-provider error payloads verbatim.
    const safeMessage = sanitizeStreamErrorMessage(streamError);
    event.sender.send(`gemini-stream-error:${requestId}`, safeMessage);
  }
}
```

Step 2 — Add `sanitizeStreamErrorMessage` helper that maps known error categories (`abort`, `timeout`, `rate_limited`, `unauthenticated`, `network`, `unknown`) without leaking provider-side text:

```ts
function sanitizeStreamErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted';
    const msg = err.message ?? 'unknown';
    if (/timeout/i.test(msg)) return 'timeout';
    if (/rate.?limit|429/i.test(msg)) return 'rate_limited';
    if (/auth|401|403/i.test(msg)) return 'unauthenticated';
    if (/network|ENOTFOUND|ECONNRESET/i.test(msg)) return 'network';
  }
  return 'unknown';
}
```

#### Edge cases

- Containment activates between `console.error` and the guard → guard catches it. ✅
- `event.sender.isDestroyed()` → already guarded.
- `streamError === null/undefined` → `sanitizeStreamErrorMessage(undefined) === 'unknown'`. ✅
- The renderer-side handler must accept `'unknown'` as a generic error code without breaking; verify in the renderer message dispatcher.

#### Race conditions

`assertNotContained()` is called at handler entry (line 35) and at flush time (line 158). Adding a third check here closes the gap. No race between containment activation and error emit because containment is a sync boolean read.

#### Regression risks

- Some debug-only error visibility is lost. Counter `ipc.stream_error_under_containment` exposes how often this fires; no user-visible regression.
- Sanitization may make debugging harder. Provider-original errors are still in `console.error` (main process logs).

#### Feature flag

`useStreamErrorContainmentGuard`. Default **ON** (this is a safety fix; the strict superset of current behavior).

#### Test plan

- **New tests in `electron/tests/streamChatCancel.test.ts`** (or new `streamErrorContainment.test.ts`):
  1. `containment active during error → no IPC send`.
  2. `containment inactive → sanitized error sent`.
  3. `error categorization correctness` (timeout / rate_limited / network).

#### Rollback

Flag off — restore raw error pass-through.

#### Acceptance criteria

- 3 new tests pass.
- Counter `ipc.stream_error_under_containment` wired.

---

### CM-017 — IPC: force-flush first token to minimize TTFT

- **Severity**: P1
- **Subsystem**: ipc / acceleration
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`registerGeminiStreamIpcHandlers` (`electron/ipc/registerGeminiStreamIpcHandlers.ts:149-194`) batches tokens with `BATCH_FLUSH_INTERVAL_MS = 16` or `BATCH_FLUSH_MAX_TOKENS = 32`. The **first** token is added to the pending buffer and waits up to 16 ms before flush. For fast providers (Cerebras ~50 ms TTFT, Groq ~80 ms), this is a 20–32 % overhead on TTFT — the most user-perceivable metric in conscious mode.

#### Why it matters

Sub-100 ms TTFT is the difference between "feels instant" and "feels laggy". Conscious mode's prefetch/speculation pipeline is built to hit this floor; IPC batching wastes the work.

#### Proposed change

Step 1 — Track first-token state, force-flush:

```ts
let pending = '';
let pendingTokenCount = 0;
let lastFlushAt = Date.now();
let aborted = false;
let firstTokenFlushed = false; // NEW

const flush = (): boolean => {
  // ... existing body unchanged ...
};

for await (const token of stream) {
  // ... abort checks unchanged ...
  pending += token;
  pendingTokenCount += 1;
  fullResponse += token;
  
  // Force-flush the very first token to minimize TTFT.
  if (!firstTokenFlushed) {
    firstTokenFlushed = true;
    if (!flush()) break;
    continue;
  }
  
  const elapsed = Date.now() - lastFlushAt;
  if (pendingTokenCount >= BATCH_FLUSH_MAX_TOKENS || elapsed >= BATCH_FLUSH_INTERVAL_MS) {
    if (!flush()) break;
  }
}
```

Step 2 — Telemetry: histogram `ipc.first_token_ms` measuring time from `streamChatStartedAt` set to first flush.

#### Edge cases

- Empty stream (first iteration never enters) → no flush, no harm. ✅
- Very fast first token (<16 ms after start) → flushed instantly.
- Token = `''` (some providers emit empty deltas) → still counts as the first token; flushes empty string. Mitigation: only set `firstTokenFlushed = true` if `token.length > 0`:

```ts
if (!firstTokenFlushed && token.length > 0) {
  firstTokenFlushed = true;
  if (!flush()) break;
  continue;
}
```

#### Race conditions

`firstTokenFlushed` is local to the closure; no concurrency.

#### Regression risks

- Slightly higher IPC count (1 extra send per stream). Bounded; harmless.
- Test `streamChatTierSelection.test.ts` may assume batching from token 1; audit.

#### Feature flag

`useFirstTokenFastFlush`. Default **ON** (reduces TTFT, no correctness change).

#### Test plan

- **New tests in `streamChatCancel.test.ts`** or `electron/tests/streamFirstTokenFlush.test.ts`:
  1. `first token flushes immediately when len > 0`.
  2. `empty first token does not trigger early flush`.
  3. `subsequent tokens batch normally (16ms / 32 tokens)`.
- **Existing**: all `streamChat*.test.ts` pass.

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.
- Histogram `ipc.first_token_ms` p50 ↓ ≥ 10 ms in canary.

---

### CM-018 — Cache: ConsciousCache word-order-aware similarity + memory budget

- **Severity**: P2
- **Subsystem**: conscious / cache
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`ConsciousCache.calculateStringSimilarity` (`electron/conscious/ConsciousCache.ts:200-210`) uses Jaccard on word sets — order-agnostic. *"How would you scale a database?"* and *"Database scale how would you?"* match identically. Plus the cache only enforces `maxSize: 100` entries, no byte budget.

#### Why it matters

False-positive cache hits return the wrong response. Memory growth on large structured responses is unbounded per-entry.

#### Proposed change

Step 1 — Replace Jaccard-only with combined Jaccard + Levenshtein-ratio:

```ts
private calculateStringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  
  const jaccard = this.jaccardSimilarity(a, b);
  if (jaccard < 0.5) return jaccard; // early reject — no need to compute distance
  
  const editRatio = 1 - (this.levenshteinDistance(a, b) / Math.max(a.length, b.length));
  return Math.min(jaccard, editRatio); // both must be high
}

private levenshteinDistance(a: string, b: string): number {
  // Standard DP, capped at 256 chars to bound CPU
  if (a.length > 256 || b.length > 256) return Math.max(a.length, b.length);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  
  const dp: number[] = Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = tmp;
    }
  }
  return dp[n];
}
```

Step 2 — Add memory budget to `CacheConfig`:

```ts
interface CacheConfig {
  maxSize: number;
  maxBytes?: number; // NEW, optional
  // ... existing
}

// Default: 5 MB
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
```

Step 3 — Track entry sizes:

```ts
private totalBytes = 0;
private entryBytes = new Map<string, number>();

set(query: string, data: T, options: CacheSetOptions): void {
  // ... existing ...
  const newBytes = this.estimateBytes(data);
  this.entryBytes.set(storageKey, newBytes);
  this.totalBytes += newBytes;
  
  this.evictIfNeeded(); // updated to consider both size and bytes
}

private estimateBytes(data: T): number {
  try {
    return JSON.stringify(data).length * 2; // UTF-16 approximation
  } catch {
    return 1024; // fallback estimate
  }
}

private evictIfNeeded(): void {
  while (
    this.cache.size > this.config.maxSize ||
    (this.config.maxBytes && this.totalBytes > this.config.maxBytes)
  ) {
    // ... existing oldest-LRU logic, plus subtract bytes on eviction ...
  }
}
```

#### Edge cases

- `JSON.stringify` throws (cyclic reference) → fallback estimate `1024`. Safe.
- Edit distance with empty strings → handled at entry guards.
- Long strings (>256 chars) skip Levenshtein (CPU bound) → falls back to Jaccard alone. Acceptable.
- `maxBytes === undefined` → byte tracking is silent; behavior identical to current. ✅

#### Race conditions

JS single-threaded; no race.

#### Regression risks

- Tighter similarity threshold may reduce cache hits for legitimate near-duplicates. Mitigation: tune threshold (default 0.85 for combined) by running existing fixture suite.
- Memory budget eviction may remove entries that the test suite expected to persist. Audit `consciousCache.test.ts` if it exists; otherwise add new.

#### Feature flag

`useConsciousCacheStrictSimilarity`, `useConsciousCacheMemoryBudget`. Default **OFF** for both.

#### Test plan

- **New tests in `electron/tests/consciousCache.test.ts`** (create if missing):
  1. `permuted-word query does not match base query (under strict similarity)`.
  2. `near-duplicate query (Jaccard 0.95 + edit-ratio 0.95) matches`.
  3. `byte budget evicts oldest when exceeded`.
  4. `byte budget no-op when undefined`.

#### Rollback

Flag off both.

#### Acceptance criteria

- 4 new tests pass.
- Counter `cache.evicted_by_bytes` and `cache.similarity_blocked_permutation` wired.

---

### CM-019 — Verifier: relax STAR depth for high-impact concise answers

- **Severity**: P2
- **Subsystem**: conscious / verifier
- **Owner**: agentic_worker
- **Order**: after CM-001 (word-boundary), CM-003 (numeric tightening) — those reduce false-positive count first

#### Problem

`BEHAVIORAL_DEPTH_RULES.minActionWords: 12` (`electron/conscious/ConsciousVerifier.ts:58-62`). A concise but high-impact STAR ("Saved 30% latency by replacing Redis cache with local LRU") is 11 words. Edge-case false reject.

Existing test `consciousVerifier.test.ts:115` ("ConsciousVerifier accepts concise behavioral answers when the action is still materially deeper than setup") DOES pass — the bound is real but the existing rule already accepts when action > situation+2 AND action > task+2. The remaining edge is when action is short BUT contains a strong impact cue.

#### Why it matters

Drops valid concise STAR answers, especially in time-pressure interview formats (5-min behavioral round).

#### Proposed change

Step 1 — Add a "strong impact action" exception:

```ts
const STRONG_ACTION_IMPACT_CUES = [
  // numeric percentages
  /\b\d{1,3}%/,
  // time savings
  /\b(saved|cut|reduced|trimmed|shaved)\b.*\b(\d+(?:\.\d+)?(?:ms|s|sec|min|hr|hours)?)/i,
  // scale
  /\b(\d+(?:\.\d+)?)x\b/,
  // outcomes
  /\b(unblocked|delivered|shipped|adopted|migrated)\b/i,
];

function hasStrongActionImpact(action: string): boolean {
  return STRONG_ACTION_IMPACT_CUES.some((re) => re.test(action));
}

function hasStrongBehavioralDepth(response: ConsciousModeStructuredResponse): boolean {
  // ... existing computation ...
  
  const passesStrictRule =
    actionWords >= BEHAVIORAL_DEPTH_RULES.minActionWords
    && actionWords >= situationWords + BEHAVIORAL_DEPTH_RULES.minActionAdvantageWords
    && actionWords >= taskWords + BEHAVIORAL_DEPTH_RULES.minActionAdvantageWords
    && resultWords >= BEHAVIORAL_DEPTH_RULES.minResultWords
    && hasBehavioralImpactCue(behavioral.result);
  
  if (passesStrictRule) return true;
  
  // Concise exception: relaxed action floor (8 words) when action carries a
  // strong impact cue and the result still has a concrete impact cue.
  return actionWords >= 8
    && actionWords >= situationWords + 1
    && actionWords >= taskWords + 1
    && resultWords >= 4
    && hasBehavioralImpactCue(behavioral.result)
    && hasStrongActionImpact(behavioral.action);
}
```

#### Edge cases

- Action has impact cue but result is generic ("we improved things") — still rejected by `hasBehavioralImpactCue(behavioral.result)` guard. ✅
- Action 6 words with strong impact — still rejected by `actionWords >= 8` floor. ✅
- Action 12 words but no strong impact — passes via the strict rule (unchanged).

#### Regression risks

- Some "lazy" answers that previously failed will now pass. The downstream LLM judge still runs and can reject. Mitigation: this is a *broadening*, not a *replacement* — the strict rule still applies first.
- Run eval harness; expect a slight rise in pass rate for concise STAR fixtures.

#### Feature flag

`useConciseSTAREasement`. Default **OFF**.

#### Test plan

- **New tests in `consciousVerifier.test.ts`**:
  1. `concise STAR with action="Saved 30% latency by replacing Redis with local LRU" (10 words) and impactful result accepts`.
  2. `short STAR (action 6 words) still rejects`.
  3. `concise STAR without impact cue rejects`.

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.
- Eval harness pass rate stable or improved.

---

### CM-020 — Acceleration: validate seed query before prefetch

- **Severity**: P2
- **Subsystem**: acceleration / prefetch
- **Owner**: agentic_worker
- **Order**: standalone

#### Problem

`PredictivePrefetcher.getCandidateQueries` (`electron/prefetch/PredictivePrefetcher.ts:166-197`) prepends the seed query at confidence 0.98 without `detectQuestion` validation. The upstream caller (`deriveSpeculativeCandidates` in `ConsciousAccelerationOrchestrator.ts:367-369`) does gate, but `getCandidateQueries` is also called from other callers without that gate.

#### Why it matters

If seed is filler ("uh, yeah, so..."), it gets prefetched as a top candidate, burning cloud tokens.

#### Proposed change

Step 1 — Add internal seed validation in `getCandidateQueries`:

```ts
import { detectQuestion } from '../conscious/QuestionDetector';

getCandidateQueries(seedQuery?: string, limit: number = 3): PredictedFollowUpDraft[] {
  const drafts = this.predictFollowUpDrafts();
  const deduped: PredictedFollowUpDraft[] = [];
  const seen = new Set<string>();
  
  const pushCandidate = (candidate?: PredictedFollowUpDraft) => { /* unchanged */ };
  
  // Defensive seed validation: only include the seed if it looks like a real query.
  if (seedQuery?.trim()) {
    const trimmed = seedQuery.trim();
    const wordCount = trimmed.split(/\s+/).length;
    const looksValid = wordCount >= 4 || detectQuestion(trimmed).isQuestion;
    if (looksValid) {
      pushCandidate({ query: trimmed, confidence: 0.98 });
    }
  }
  
  for (const draft of drafts) { /* unchanged */ }
  return deduped.slice(0, limit);
}
```

#### Edge cases

- Single-word query ("Why?") — `detectQuestion` returns `isQuestion: true`. ✅
- Long filler ("yeah I mean so basically what I'm trying to say") → `isQuestion: false`, word count > 4 → passes. **Tradeoff**: this is a real downside but `wordCount >= 4` is intentionally generous to avoid false-rejecting natural phrasings.

#### Regression risks

- Some prefetches that previously fired won't. Bounded by question-detection accuracy.

#### Feature flag

`usePrefetchSeedValidation`. Default **OFF**.

#### Test plan

- **New tests in `electron/tests/predictivePrefetcher.test.ts`** (create if missing):
  1. `seed "uh yeah" rejected`.
  2. `seed "Why?" accepted`.
  3. `seed "What is your favorite color" accepted`.

#### Rollback

Flag off.

#### Acceptance criteria

- 3 new tests pass.

---

### CM-021 — Cleanup: remove dead `cosineSimilarity` and consolidate utility

- **Severity**: P3
- **Subsystem**: acceleration / cleanup
- **Owner**: agentic_worker
- **Order**: after CM-007/CM-008/CM-009 (those add new uses of similarity helpers)

#### Problem

`cosineSimilarity` in `ConsciousAccelerationOrchestrator.ts:343-359` is dead after the NAT-002 audit. New tickets (CM-007, CM-008, CM-009) introduce `jaccardSimilarity`. Consolidate into a shared utility.

#### Proposed change

Step 1 — Move both `cosineSimilarity` and `jaccardSimilarity` to `electron/utils/similarity.ts` as exported pure functions.
Step 2 — Update consumers in `ConsciousAccelerationOrchestrator` and (if CM-005 ships) `ConsciousOrchestrator`.
Step 3 — Add unit tests.

#### Test plan

- **New tests in `electron/tests/similarity.test.ts`**:
  1. `cosineSimilarity orthogonal → 0`.
  2. `cosineSimilarity identical → 1`.
  3. `jaccardSimilarity disjoint → 0`.
  4. `jaccardSimilarity identical → 1`.

#### Acceptance criteria

- 4 new tests pass.
- Consumers compile and existing tests pass.

---

### CM-022 — (Optional follow-up) Migrate hot-path TTL math to monotonic clock

- **Severity**: P2
- **Subsystem**: cross-cutting / cache
- **Owner**: agentic_worker
- **Order**: after CM-014, CM-015 (broker + sweep land first)

#### Problem

Wall-clock-based TTL math is correct under normal operation but brittle across sleep boundaries even with sweep-on-resume. Long-term: prefer `process.hrtime.bigint()` for relative timing.

#### Proposed change

Step 1 — Add `electron/runtime/MonotonicClock.ts`:

```ts
export class MonotonicClock {
  static nowNs(): bigint { return process.hrtime.bigint(); }
  static elapsedMsSince(startNs: bigint): number {
    return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
  }
}
```

Step 2 — Migrate hot-path TTLs (`ConsciousCache`, dedupe map, speculative entries) to track start time as `bigint` and use `elapsedMsSince`. Wall-clock timestamps remain only for human-readable logging.

Step 3 — Drop or simplify the resume-sweep from CM-015 (still useful as a defense-in-depth, but no longer necessary for correctness).

#### Edge cases

- `bigint` interop in JSON serialization → never serialize bigint to disk; convert to ms-from-epoch when persisting.
- Test mocks that set `Date.now` won't affect monotonic clock. Add `MonotonicClock.setForTesting` shim.

#### Regression risks

- Refactor surface is large. Land **after** CM-014 and CM-015 are stable. Treat as separate sprint.

#### Feature flag

None — pure refactor, behavior-preserving.

#### Test plan

- New `electron/tests/monotonicClock.test.ts` with stub-time tests.
- Existing TTL tests adjusted to use `MonotonicClock.setForTesting(...)`.

#### Acceptance criteria

- All migrated paths use monotonic clock.
- All existing TTL tests pass.

---

## 3. Sprint Sequencing

> Each sprint is ~5 working days for a single agentic worker, or ~2 days with two parallel workers when tickets are independent. **Independent tickets in the same sprint can be parallelized.** Dependencies are noted explicitly.

### Sprint 1 — Verifier correctness (P0/P1, 1 week)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-001 word-boundary verifier | none | Low | ON |
| 2 | CM-002 always-on rule provenance in degraded | none | Low | ON |
| 3 | CM-003 numeric regex tightening | none | Medium | OFF (canary) |
| 4 | CM-004 expanded tech allowlist | CM-001 | Medium | OFF (canary) |

**Parallelizable**: CM-001 + CM-002 can ship in same PR (orthogonal paths). CM-003 and CM-004 ship after CM-001 lands.

**Sprint exit**: All four tickets merged behind flags, all flags green in canary, eval harness regression = 0.

### Sprint 2 — Power events + TTL hygiene (P0, 1 week)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-014 PowerEventBroker + suspend/resume | none | High | OFF (canary) |
| 2 | CM-015 Resume-sweep TTL caches | CM-014 | Low | ON |
| 3 | CM-016 IPC stealth-containment guard on errors | none | Low | ON |
| 4 | CM-017 First-token fast flush | none | Low | ON |

**Parallelizable**: CM-016 and CM-017 are independent of CM-014/CM-015.

**Sprint exit**: 1-week canary on CM-014 with `power.suspend_total > 0`, `power.resume_thread_reset` observed in production.

### Sprint 3 — Acceleration speculation hygiene (P1, 1.5 weeks)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-007 Stable-revision rebind | none | Medium | OFF (canary) |
| 2 | CM-008 Relevance-aware eviction | CM-007 | Medium | OFF (canary) |
| 3 | CM-009 Fuzzy-match speculation promotion | CM-008 | High | OFF (extended canary) |
| 4 | CM-010 Tighten prefetch confidence gate | none | Low | OFF (canary) |

**Parallelizable**: CM-010 can ship anytime; CM-007 → CM-008 → CM-009 are sequenced.

**Sprint exit**: Speculation reuse rate ↑, cloud spend ↓, no new wrong-answer reports during canary.

### Sprint 4 — Pause detector accuracy (P1, 1 week)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-011 First-turn rhythm prior | none | Low | OFF (canary) |
| 2 | CM-012 Adaptive noise floor | none | Low | OFF (canary) |
| 3 | CM-013 Disfluency-aware completeness | none | Low | OFF (canary) |

**Parallelizable**: All three tickets are fully independent. Single-day each.

**Sprint exit**: Eval harness pause-decision accuracy ≥ baseline; `pause.commit_premature_total` ↓.

### Sprint 5 — Orchestrator polish + verifier easements (P1/P2, 1 week)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-005 Semantic thread compatibility | none | Medium | OFF (canary) |
| 2 | CM-006 Per-failure-type circuit breaker | none | Medium | OFF (canary) |
| 3 | CM-019 Concise STAR easement | CM-001, CM-003 | Low | OFF (canary) |

**Parallelizable**: CM-005 and CM-006 are orthogonal.

**Sprint exit**: Thread-routing accuracy ≥ baseline; circuit-breaker per-category counters surface.

### Sprint 6 — Cache + cleanup (P2/P3, 0.5 week)

| Order | Ticket | Dep | Risk | Default flag |
|-------|--------|-----|------|--------------|
| 1 | CM-018 Cache strict similarity + memory budget | none | Low | OFF (canary) |
| 2 | CM-020 Prefetch seed validation | none | Low | OFF (canary) |
| 3 | CM-021 Similarity utility consolidation | CM-007/008/009 | None | n/a |

**Parallelizable**: All three.

**Sprint exit**: All flags either flipped ON or removed (after 7-day canary success).

### Sprint 7 (optional) — Monotonic clock migration (P2, 1.5 weeks)

| Order | Ticket | Dep | Risk |
|-------|--------|-----|------|
| 1 | CM-022 Monotonic-clock TTL math | CM-014, CM-015 | Medium |

**Sprint exit**: All hot-path TTLs use monotonic clock; legacy wall-clock paths kept only for human-readable logging.

---

## 4. Verification & Telemetry Strategy

### 4.1 Pre-merge gates per ticket

For every ticket:

1. **Unit tests** for new branches pass locally + CI (`npm test electron/tests/<file>.test.ts`).
2. **Existing test suite** passes with no regressions (`npm test electron/tests/`).
3. **Eval harness regression** (`node --test electron/tests/consciousEvalHarness.test.ts`) reports zero new fails.
4. **Type check** passes (`npm run typecheck`).
5. **Lint** passes (`npm run lint`).
6. **Diff review**: ticket-specified files only; no incidental edits.

### 4.2 Canary metrics dashboard

Each P1+ ticket lands behind a flag, default OFF. Canary phase = 7 calendar days minimum (longer for CM-009 fuzzy match, CM-014 power events). During canary:

| Counter | Owner ticket | Threshold |
|---------|--------------|-----------|
| `verifier.unsupported_tech_claim` | CM-001, CM-004 | Track baseline; spike → investigate |
| `verifier.unsupported_numeric_claim` | CM-003 | Track baseline; spike → investigate |
| `conscious.degraded_provenance_fail` | CM-002 | New counter; expect non-zero in canary |
| `conscious.circuit_opens{category}` | CM-006 | Track per-category rates |
| `acceleration.revision_rebinded` | CM-007 | Should grow > 0 |
| `acceleration.eviction_relevance_swap` | CM-008 | Should grow > 0 |
| `acceleration.fuzzy_promotion_used` | CM-009 | Track + sample 100 promotions for human review |
| `acceleration.prefetch_admitted{band}` | CM-010 | Both bands non-zero |
| `pause.noise_floor_active` | CM-012 | True > 0 in noisy environments |
| `pause.punctuation_discounted_disfluency` | CM-013 | Track baseline |
| `power.suspend_total`, `power.resume_thread_reset` | CM-014 | Verify non-zero on long sessions |
| `cache.evicted_by_bytes` | CM-018 | Should fire when budget enforced |
| `ipc.first_token_ms` (histogram) | CM-017 | p50 ↓ ≥ 10 ms |
| `ipc.stream_error_under_containment` | CM-016 | New counter; track |

### 4.3 Eval harness extensions per ticket

For every ticket that affects a verifier verdict, routing decision, or pause action, add at least one fixture to the relevant harness BEFORE the implementation:

- `consciousEvalHarness.test.ts` — verifier + orchestrator changes
- `accelerationModeIntegration.test.ts` — speculation, prefetch, pause changes
- `pauseDetector.test.ts` — pause-only changes

Failing fixtures = automatic merge block.

### 4.4 Promotion criteria per flag (OFF → ON)

For a flag to flip from OFF (canary) to ON (default-on production):

- 7+ days in canary
- All canary metrics within ±10% of baseline (or improvement)
- Zero "wrong answer" reports tagged to the flag
- Zero new errors in main-process logs related to the flag's code path
- Owner sign-off

---

## 5. Rollback Runbook

Every ticket must have a precise rollback. Aggregate rollback procedures:

### 5.1 Rollback by feature flag

The fastest rollback. For tickets with a flag:

1. Edit `electron/config/optimizations.ts` — set the relevant flag to `false` in `DEFAULT_OPTIMIZATION_FLAGS`.
2. Ship a hotfix release (or update via remote settings if available).
3. The next IPC turn picks up the new flag value at turn entry — old behavior restored.

**Time-to-rollback**: minutes (settings push) or hours (release cycle).

### 5.2 Rollback by code revert

For unflagged correctness fixes (CM-002, CM-015, CM-016, CM-017 may default ON):

1. Identify the commit SHA from CHANGELOG entry.
2. `git revert <SHA>` on a hotfix branch.
3. Re-run pre-merge gates (Section 4.1) on the revert branch.
4. Ship.

**Time-to-rollback**: a few hours.

### 5.3 Rollback decision matrix

| Symptom | Likely culprit | Rollback action |
|---------|----------------|-----------------|
| New "wrong answer" reports tagged to fuzzy-match | CM-009 | Flag `useFuzzySpeculationPromotion` → OFF |
| Surge in `conscious.degraded_provenance_fail` | CM-002 (real issue surfacing) | Investigate hallucinations; do NOT roll back |
| Surge in `verifier.unsupported_tech_claim` | CM-004 expanded list catching real hallucinations | Investigate; usually keep |
| TTFT degraded after IPC change | CM-017 | Flag OFF |
| Speculation completion rate dropped | CM-007/CM-008 | Flag OFF for that ticket; investigate |
| Conscious-mode threads reset too aggressively post-resume | CM-014 | Increase `postResumeThreadResetMs` (e.g., 120000) |
| Pause detector commits prematurely | CM-011/CM-013 | Flag OFF for relevant ticket |

### 5.4 Critical rollback (multi-ticket simultaneous failure)

If multiple flags are showing canary regressions, set master flag `accelerationEnabled: false` in `DEFAULT_OPTIMIZATION_FLAGS`. This disables ALL acceleration features atomically (existing emergency switch, see `optimizations.ts:143-147`).

After stabilization, re-enable individually with smaller canary cohorts.

---

## 6. Done When (overall plan completion)

- [ ] **Sprint 1 complete** — verifier correctness P0/P1 fixes shipped
- [ ] **Sprint 2 complete** — power events, TTL sweep, IPC safety/TTFT shipped
- [ ] **Sprint 3 complete** — acceleration speculation hygiene shipped
- [ ] **Sprint 4 complete** — pause detector accuracy shipped
- [ ] **Sprint 5 complete** — orchestrator polish + verifier easements shipped
- [ ] **Sprint 6 complete** — cache + cleanup shipped
- [ ] **All canary flags promoted** — flipped ON or removed after 7-day canary
- [ ] **Eval harness baseline updated** — CHANGELOG records the new baseline numbers
- [ ] **Telemetry dashboard exists** — all counters listed in 4.2 are wired and visible
- [ ] **Rollback runbook lives in `docs/runbooks/conscious-mode-rollback.md`** — copy of Section 5

---

## 7. Glossary

- **Conscious mode** — the high-quality reasoning path that generates STAR / structured tradeoff / deep-dive responses with provenance verification.
- **Acceleration mode** — the prefetch + speculation system that minimizes TTFT during silence gaps.
- **Speculative answer** — an LLM stream started before the user's question is finalized, finalized only on exact (or fuzzy) match.
- **Prefetched intent** — an intent classification computed during silence, ready to feed routing decisions.
- **Provenance verifier** — rule-based check that response content is supported by the prepared evidence/context.
- **LLM judge** — the cloud-LLM-based verifier that evaluates response acceptability beyond rules.
- **Containment** — emergency state where stealth subsystem suppresses outbound IPC and provider calls.
- **Degraded mode** — circuit-breaker open state; LLM judge is skipped, but rule-based provenance MUST still run (CM-002).

