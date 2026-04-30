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

---

# Part B — Deep-Dive Evaluation: Conscious Mode, Acceleration, Stealth, IPC

> System-wide audit beyond Foundation Models. Each finding has a file/line reference, a severity, and a concrete fix. Severity: **P0** = correctness/safety bug; **P1** = significant accuracy/UX risk; **P2** = optimization; **P3** = nice-to-have.

---

## B-1. Stealth Subsystem

### B-1.1 P0 — Capture-detection hide loop can leave the window permanently invisible

`StealthManager.scheduleRestoreAttempt` (`electron/stealth/StealthManager.ts:1696-1719`) retries `MAX_RESTORE_ATTEMPTS` (5) every 5 s. After exhaustion it emits `stealth:fault` once and **stops scheduling** — but `windowsToRestore` is never cleared and the windows are still hidden / opacity 0. There is no recovery loop, no UI surface to inform the user, no manual "force show" gesture. A single false-positive capture-detection can trap the user with an invisible window for the rest of the session.

**Fix**: After exhaustion, force a one-shot restore (privacy-shield ramp + opacity 1) regardless of capture state, surface a renderer-visible toast `stealth:capture_unrecoverable`, and reset state. Add a manual `stealth:force-show` IPC handler.

### B-1.2 P0 — TCC.db read is silently broken on macOS 10.15+

`TCCMonitor.checkTCCDatabase` (`electron/stealth/TCCMonitor.ts:94-130`) shells out `sqlite3 /Library/Application Support/com.apple.TCC/TCC.db` directly. **This file is SIP-protected since macOS 10.15** and returns `Operation not permitted` without Full Disk Access. The catch block silently swallows the error → the function reports zero granted apps regardless of reality, and `permission-granted` events never fire.

Net effect: the entire TCC monitoring code path is dead code on every modern macOS host that hasn't manually granted Full Disk Access to the Electron binary.

**Fix**: Replace the TCC.db sqlite read with `CGPreflightScreenCaptureAccess()` (own app) and a native helper that uses `SCShareableContent.current` to enumerate apps that *currently* hold capture. Surface the silent failure as a real warning (`tcc_unreadable`).

### B-1.3 P0 — Enterprise tool detection list is hard-coded to 16 tools and runs `pgrep` 16× per cycle

`MonitoringDetector.detectThreats` (`electron/stealth/MonitoringDetector.ts:78-99`) and `TCCMonitor.checkEnterpriseTools` (`electron/stealth/TCCMonitor.ts:132-158`) duplicate the same `KNOWN_ENTERPRISE_TOOLS` list and **both** spawn `pgrep` 16 times sequentially every cycle. Two systemic issues:

1. **Coverage gap** — Workpuls, Insightful, Monitask, ManicTime, Awareness, Splunk Stream, and dozens of newer monitors are not listed; **browser-based proctoring** (Honorlock, Examity, AIProctor) leaves no desktop process at all and is invisible to `pgrep`; **kext-based** monitors (Veriato kernel, Spectorsoft) install kernel extensions that don't show in process tables.
2. **Cost** — 16 process spawns × 2 monitors × every 2 s = ~16 syscalls/s baseline. Wasteful on battery; visibly impacts low-end Macs.

**Fix**:
- Single `ps -ax` enumeration per cycle, regex-match in-process (1 syscall vs 16).
- Externalize the detection list to a versioned JSON asset (`assets/stealth/threats.json`) with categories, regexes, and severity. Update independently of releases.
- Add **process-level** detection (`LaunchServices`), **browser-extension detection** (scan `~/Library/Application Support/Google/Chrome/Default/Extensions/` for Honorlock/Proctorio extension IDs), and **kext detection** via `kextstat | grep`.

### B-1.4 P1 — SCStream detector misses inline `ScreenCaptureKit.framework` consumers

`StealthManager.checkSCStreamActive` (`electron/stealth/StealthManager.ts:1329-1352`) only matches `pgrep ScreenCaptureAgent` and `pgrep controlcenter` (with keyword filter). But Zoom, Teams, Webex, Loom, Slack Huddle, Discord all link `ScreenCaptureKit.framework` **directly inside their own process** — they do not spawn `ScreenCaptureAgent`. The detector misses every modern app-driven capture session.

**Fix**: Expose `nativeStealthModule.observeContentSharing` using Apple's `SCContentSharingPicker`/`SCStream` notifications — when any active app starts a capture session, the OS publishes the change. Fall back to `lsof -i 0.0.0.0:* -p <pid>` heuristic for the active screen-share-via-network signal.

### B-1.5 P1 — No `lock-screen` / `suspend` handlers; watchdog runs through sleep

`StealthManager.bindPowerMonitor` (`electron/stealth/StealthManager.ts:1069-1091`) only binds `unlock-screen`, `resume`, `on-ac`, `on-battery`. Missing:

- `lock-screen` — should pause the watchdog, ASR, and capture-detection polling (battery + privacy).
- `suspend` — same; on wake, all in-flight LLM streams should be aborted (cloud-side sockets are already dead).
- No `IntelligenceManager` integration with `powerMonitor` at all (zero hits) → on wake, conscious-mode session state is preserved as if nothing happened, and the next user turn appears to continue a thread that's been stale for hours.

**Fix**: Subscribe `powerMonitor.on('lock-screen' | 'suspend' | 'shutdown')` once, broadcast a `system:power_state` event; subscribers (StealthManager, IntelligenceEngine, ASR, PauseDetector) react: pause polling, abort streams, snapshot session, mark thread as stale.

### B-1.6 P1 — `bindPowerMonitor` listeners are never removed

`bindPowerMonitor` and `bindDisplayEvents` use `.on(...)` without storing handles for `removeListener`. Calling `setEnabled(false)` then `setEnabled(true)` rebinds with `if (this.powerMonitorBound) return` — listeners stay attached forever, but a fresh re-init never re-arms them. The `isEnabled()` check inside the handler papers over correctness but leaves dead listeners tied to a destroyed StealthManager instance during hot-reload / test cleanup.

**Fix**: Track bound handlers (`Map<event, listener>`); call `removeListener` in `dispose()`.

### B-1.7 P1 — Display change reapply does not handle Stage Manager / Mission Control / Spaces

`bindDisplayEvents` listens for `display-metrics-changed`, `display-added`, `display-removed`. Missing:
- **Stage Manager strip transitions** (macOS 13+) — a window can be shoved off-screen visibly to capture.
- **Mission Control snapshot** — when Mission Control engages, macOS captures the window's state into a thumbnail; SCK ignores `setContentProtection`.
- **Space switch** — moving the window to another Space and back can lose `setContentProtection` state on some macOS versions.

**Fix**: Hook `NSWorkspace.activeSpaceDidChangeNotification` and `NSWindowDidExposeNotification` via the native module; reapply protection on each.

### B-1.8 P1 — `processEnumerator` (pgrep) timeout is 5 s, blocking the watchdog

The watchdog loop awaits `processEnumerator` calls in series. If `pgrep` hangs (rare but documented under load), the watchdog is blocked for up to 5 s × 16 calls = 80 s in worst case. During that window, capture detection is offline.

**Fix**: `Promise.allSettled(parallelChecks.map(...))` with per-call timeout; total worst case capped at 5 s instead of 80 s.

### B-1.9 P2 — Privacy shield ramp + opacity flicker not coordinated with display refresh

`opacityFlicker.ts` runs an opacity ramp on a `setInterval`/`setTimeout` cadence (~16 ms target = 60 Hz). On 120 Hz ProMotion displays this is visibly stair-stepped; on external 30 Hz monitors it can race the refresh and produce visible flashes. There's no `requestAnimationFrame`-equivalent in the main process.

**Fix**: Drive the ramp from the renderer using `requestAnimationFrame`; main emits start/stop only.

### B-1.10 P2 — Hardcoded enterprise list duplicated across modules

Both `MonitoringDetector` and `TCCMonitor` carry the same 16-tool list inline. Likely also `CaptureMatrixHarness`/`ProtectionStateMachine`. Single source of truth missing.

**Fix**: Move to `electron/stealth/threats/known.json` or generate from a single TS module; delete inline duplicates.

### B-1.11 P3 — No telemetry surface for "stealth confidence"

A user wants to know *"how confident is the app that I'm hidden?"*. No surface exists. The renderer cannot show a green/yellow/red indicator. `stealth-degraded` events fire but only on specific warnings.

**Fix**: Compute a derived `stealthConfidence: 'high' | 'reduced' | 'compromised'` from {enabled, warnings, capture-active, monitor-detected, content-protection-applied}; expose via IPC.


---

## B-2. Conscious Mode

### B-2.1 P0 — `hasUnsupportedTechnologyClaim` uses substring match, not word boundary

`ConsciousVerifier.hasUnsupportedTechnologyClaim` (`electron/conscious/ConsciousVerifier.ts:152-162`) uses `groundingText.includes(token)`. A hallucinated `"java"` claim passes if grounding text contains `"javascript"`. Any claim about `"go"` (the language) passes if the grounding mentions `"google"` or `"going"`. False negatives in the unsupported-claim gate.

**Fix**: Word-boundary match: `new RegExp(\`\\\\b${token}\\\\b\`, 'i').test(groundingText)`.

### B-2.2 P1 — `hasUnsupportedNumericClaim` over-rejects on year mentions

The regex (`electron/conscious/ConsciousVerifier.ts:144-150`) `\b\d+(?:\.\d+)?(?:ms|s|m|h|x|%|k|m|b)?\b` matches `2024` (year), `1` (rank), `3` (count). A response that says "in 2024 we shipped 3 features" gets rejected even when the question is itself about 2024.

**Fix**: Require a unit suffix or a "claim verb" preceding the number ("reduced X by 200ms"). Or only enforce the gate on claims with explicit unit suffixes.

### B-2.3 P1 — Tech allowlist is small and brittle

`TECH_TOKEN_RE` (`electron/conscious/ConsciousVerifier.ts:155-156`) covers ~25 tokens. Misses GraphQL, Vault, Consul, Cassandra, ScyllaDB, Hadoop, Kinesis, NATS, Pulsar, ETCD, Prometheus, Grafana, Datadog, Sentry, OpenTelemetry, Honeycomb, Splunk, Cloudflare, Fastly, Vercel, Netlify, Supabase, Firebase, etc. An inferred-dominant response can hallucinate any of these undetected.

**Fix**: Externalize to JSON asset; expand to ~150 tokens; add a weekly script to extract candidate tokens from the eval corpus.

### B-2.4 P1 — Behavioral STAR depth rules reject legitimate concise answers

`BEHAVIORAL_DEPTH_RULES` (`electron/conscious/ConsciousVerifier.ts:58-62`) requires `minActionWords: 12` AND `actionWords ≥ situationWords + 2` AND `actionWords ≥ taskWords + 2` AND `resultWords ≥ 6`. For a concise but high-impact STAR ("Saved 30% latency by replacing Redis cache with local LRU"), action=10 words → reject.

**Fix**: Replace hard floors with a learned classifier (or use Foundation Models — see Tier 2.1) that scores STAR completeness rather than counting words. Or relax to `minActionWords: 8` and prefer the LLM judge for the depth signal.

### B-2.5 P1 — Thread continuation tokenizer drops too many stopwords

`THREAD_COMPATIBILITY_STOPWORDS` (`electron/conscious/ConsciousOrchestrator.ts:136-141`) strips `their`, `where`, `which`, `into`, `while`, `there`, `then`, `than`, `been`, `were`, `will`, `could`, `should`, `does`, `did`, `are`, `how`, `why`, `can`, `you`, `our`, `but`, `not`, `just`, `still`, `also`, `make`, `makes`, `made`, `like`, `need`, `want`, `talk`, `lets`. After stemming + stopword removal, a question like *"How does that scale?"* becomes `["scale"]` — one token. The 25%-overlap threshold (line 215) cannot reliably distinguish thread continuation from topic reset.

**Fix**: Use semantic embedding similarity over the full question against the thread root; keep the stopword list only as a tiebreaker.

### B-2.6 P1 — Provenance verifier silently skipped in degraded mode

`continueThread` (`electron/conscious/ConsciousOrchestrator.ts:445-459`) runs `provenanceVerifier.verify` only when `!degradedMode`. **In degraded mode** (circuit breaker open after repeated failures), provenance verification is silently skipped — hallucinated content can pass straight through. The user has no signal they're in degraded mode.

**Fix**: Always run rule-based provenance verification (it is fast, deterministic, no network call). Only skip the LLM judge in degraded mode. Surface degraded mode in the UI with a `conscious:degraded` IPC event.

### B-2.7 P1 — `isCircuitOpen` cooldown is global per-orchestrator, not per-failure-type

`recordExecutionFailure` (`electron/conscious/ConsciousOrchestrator.ts:102-112`) increments a single `consecutiveFailures` counter regardless of failure cause. A series of `provenance` failures (suggesting LLM is hallucinating) triggers the same cooldown as `network_timeout` failures (transient infra). The recovery strategy should differ.

**Fix**: Per-failure-type counters with distinct thresholds: hallucination failures should *open the gate sooner* (3 instead of 5) and stay open longer; transient network failures should retry with backoff first.

### B-2.8 P2 — `ConsciousCache` uses Jaccard word-set similarity (order-agnostic)

`calculateStringSimilarity` (`electron/conscious/ConsciousCache.ts:200-210`) ignores word order. *"How would you scale a database?"* and *"Database scale how would you?"* get identical similarity. The cache can return semantically wrong responses for permuted questions — usually masked because `enableSemanticMatching` paths use embeddings, but the string fallback is the only fallback when embeddings fail.

**Fix**: Combine Jaccard with normalized edit distance (Levenshtein-ratio); require both to exceed thresholds.

### B-2.9 P2 — `ConsciousCache.findSimilarEntry` is O(n) on every cache miss

Linear scan over all entries (max 100). At p99 this is ~100 dot-products + 100 Jaccard computations = ~1–3 ms. Acceptable today; doesn't scale if `maxSize` grows.

**Fix**: Maintain a small approximate-NN structure (HNSW or single-precision flat IVF). Flag for when maxSize grows.

### B-2.10 P2 — `ConsciousCache` has no memory budget — only entry count

`maxSize: 100` is enforced; bytes are not. A single conscious-mode response can be 10–50 KB structured JSON. 100 × 50 KB = 5 MB. Generally fine, but no guard against pathological growth.

**Fix**: Add `maxBytes` enforcement using `JSON.stringify(entry).length` as a proxy.

### B-2.11 P2 — Speculative answer key vulnerable to ASR jitter

`buildSpeculativeKey` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:339-341`) dedupes on revision + lower+trim+collapse-spaces. ASR sometimes emits *"What's your strategy?"* and *"Whats your strategy"* and *"What is your strategy"* in successive partials. Each yields a different key; the speculative executor runs three times → 3× cloud spend.

**Fix**: Light normalization: collapse contractions (`whats` → `what is`), strip punctuation (already done). Tradeoff to evaluate.

### B-2.12 P2 — `selectSpeculativeEntry` requires *exact normalized* match (no fuzzy promotion)

`selectSpeculativeEntry` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:385-398`) returns `null` unless the normalized query matches exactly. NAT-002 audit comment explains why. Tradeoff: when ASR finalizes the question slightly differently than the speculative key, **the entire speculative answer is wasted** even though correct.

**Fix**: Tier-2 fuzzy-match path that only promotes if (a) Jaccard ≥ 0.92, (b) speculative answer's intent matches the prefetched intent of the actual query, (c) latest reaction signal is consistent. Lower-confidence than exact, but salvages most ASR-jitter cases.

### B-2.13 P3 — `latestTranscriptTexts` is hardcoded at 5 with no speaker dimension

`noteTranscriptText` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:173-192`) keeps the last 5 utterances regardless of speaker. The pause detector receives a mixed stream where alternation matters. The current 5 may be all-interviewer or all-user.

**Fix**: Keep 5 per speaker; expose interleaved view.


---

## B-3. Acceleration Mode

### B-3.1 P0 — `PauseDetector` thresholds are global, not per-user / per-language

`PauseDetector.calculateConfidence` weights (`electron/pause/PauseDetector.ts:196-228`) and `commitThreshold`/`hardSpeculateThreshold`/`softSpeculateThreshold` are global constants. A non-native English speaker has more disfluencies (uh, um, longer thinking pauses) — same thresholds will misfire (premature commit) or under-fire (missed turn-end). The conjunction list `(and|but|so|...)` (`PauseDetector.ts:245`) is English-only.

**Fix**:
1. Make thresholds and weights per-session, learned online via `PauseThresholdTuner` (already exists at `electron/conscious/ConsciousAccelerationOrchestrator.ts:262-265`; the hooks are wired but the *weights themselves* aren't tuned, only the thresholds).
2. Localize the conjunction set; auto-detect language from the transcript.

### B-3.2 P1 — `PauseDetector` energy decay floor not adaptive

`scoreEnergyDecay` (`electron/pause/PauseDetector.ts:296-319`) compares last-5 / earlier-5 RMS samples. In a noisy environment (HVAC, fan, music), the floor RMS dominates → ratio always near 1.0 → never registers as "natural fade out". Speakers in noisy rooms get systematically slower triggers.

**Fix**: Maintain an adaptive noise floor (median RMS over last 60 s of *non-speech* samples); compute `(recent - floor) / (earlier - floor)` so the decay signal is independent of background noise.

### B-3.3 P1 — `scoreTranscriptCompleteness` over-trusts ASR-emitted punctuation

ASR engines (Whisper, Deepgram, Soniox) often emit a period after a thought boundary even when the user is still thinking. The current rule (`PauseDetector.ts:242`) maps any trailing `[.!?]` to 0.9 confidence → premature commit.

**Fix**: Discount ASR-inserted punctuation when prior chunks had mid-thought disfluencies, or when the ASR emits multiple successive period-terminated fragments within 1 s.

### B-3.4 P1 — `scoreConversationRhythm` returns 0.5 on the first turn

`scoreConversationRhythm` (`PauseDetector.ts:282-294`) returns `0.5` when `turnStartTime === 0`. But the **first turn** is the most common one and the most important to get right. Returning 0.5 means rhythm contributes nothing to first-turn confidence.

**Fix**: Initialize `avgTurnDurationMs` from a population prior (e.g., 6 s typical interviewer turn); use that prior on turn 1 instead of returning 0.5.

### B-3.5 P1 — Prefetch races on overlapping silence events

`onSilenceStart` calls `maybePrefetchIntent` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:236`); `handlePauseAction` *also* awaits `maybePrefetchIntent` (line 123). The dedupe is correct (in-flight map at lines 530-534), but if `latestInterviewerTranscript` was empty when `onSilenceStart` fired (e.g., ASR delivered the transcript only just before the pause), no prefetch was started, and `maybeStartSpeculativeAnswer` returns immediately on `!isStrongConsciousIntent(prefetchedIntent)` (line 411).

**Fix**: In `maybeStartSpeculativeAnswer`, if `prefetchedIntent === null` and a transcript exists, kick off a synchronous intent classify with a 200 ms timeout and proceed if it resolves. Otherwise allow speculation with a *provisional* intent at confidence floor — the verifier rejects if wrong.

### B-3.6 P1 — `invalidateSpeculation` aborts in-flight cloud streams unconditionally

`invalidateSpeculation` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:674-689`) aborts every in-flight speculative entry the moment a new transcript revision lands. ASR jitter can produce 2–5 transcript revisions per pause (each adding/correcting a word). Each revision aborts ALL speculation. Net: speculation rarely completes for talkative interviewers.

**Fix**: Distinguish *content-changing* from *content-stable* revisions. If the new revision's normalized question matches the speculation's normalized query (Jaccard ≥ 0.95), don't abort — just update the bound revision number.

### B-3.7 P1 — `evictStaleSpeculativeEntries` aborts the OLDEST entry, not the LEAST USEFUL

`evictStaleSpeculativeEntries` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:496-512`) sorts by `startedAt` and aborts the oldest. If the user's actual question matches the oldest entry, the cloud spend is wasted just before paying off.

**Fix**: Sort by `min(distanceToCurrentQuestion, age)` — keep entries semantically close to the current transcript even if older.

### B-3.8 P2 — Prefetch admits low-confidence intents (≥0.45) but speculation requires `isStrongConsciousIntent` (≥0.84)

`maybePrefetchIntent` admits intents at `confidence ≥ 0.45` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:554`); `maybeStartSpeculativeAnswer` requires `isStrongConsciousIntent` (≥0.84 per `INTENT_CONFIDENCE_CALIBRATION`). The 0.45–0.84 band of prefetched intents is **stored but never used for speculation**. Wasted prefetch effort.

**Fix**: Either (a) tighten prefetch gate to ≥0.72 to align with `minReliableConfidence`, or (b) lower the speculation gate when the user has been stable on the same question for >800 ms (high-confidence-via-stability).

### B-3.9 P2 — `getCandidateQueries` uses `seedQuery` at confidence 0.98 without verifying it's a question

`PredictivePrefetcher.getCandidateQueries` (`electron/prefetch/PredictivePrefetcher.ts:166-197`) prepends the seed query at confidence 0.98 without running it through `detectQuestion`. If the seed is the user's filler ("uh, yeah, so…"), it gets prefetched as a top candidate and burns cloud tokens.

**Fix**: Filter seed through `detectQuestion`; reject if not a question OR not ≥4 words.

### B-3.10 P2 — `cosineSimilarity` is unused in `selectSpeculativeEntry` after the A-2 audit

`cosineSimilarity` is implemented (`electron/conscious/ConsciousAccelerationOrchestrator.ts:343-359`) but only `selectSpeculativeEntry` uses normalized-query matching. Dead code path. Remove or repurpose for B-2.12 fuzzy-match tier.

### B-3.11 P3 — `prefetcher.onTopicShiftDetected` clears all caches synchronously

`clearState()` (`electron/conscious/ConsciousAccelerationOrchestrator.ts:298-310`) calls `prefetcher.onTopicShiftDetected()` which `prefetchCache.clear()`. If a topic shift is detected mid-question, valid cached prefetches for the new topic are wiped. They will be re-fetched on the next pause — but that's exactly the latency-critical moment.

**Fix**: Tag cache entries with topic; only invalidate entries whose topic is no longer relevant.


---

## B-4. IPC Streaming Wiring

### B-4.1 P0 — Stealth-containment check missing from streaming-error path

`registerGeminiStreamIpcHandlers` (`electron/ipc/registerGeminiStreamIpcHandlers.ts:210-215`): when the cloud LLM throws mid-stream, the handler emits `gemini-stream-error:<id>` to the renderer **without** checking `assertNotContained()`. If stealth containment activates mid-error, the error message (potentially containing sensitive context excerpts in cloud-provider error payloads) reaches the renderer's UI.

**Fix**: Guard the error-channel `event.sender.send` with the same containment check as `flush()` on lines 158-161. Drop or redact the error message under containment.

### B-4.2 P1 — First token delayed by up to 16 ms by the batch flush window

The micro-batch implementation (`electron/ipc/registerGeminiStreamIpcHandlers.ts:149-194`) flushes every 16 ms or 32 tokens. The **first** token is added to `pending` and waits up to 16 ms before flushing. For ultra-low-latency providers (Cerebras ~50 ms TTFT, Groq ~80 ms), this is a 20–30 % overhead on TTFT.

**Fix**: Force-flush on the first token (`if (firstToken) { flush(); firstToken = false; }`), then resume normal batching.

### B-4.3 P1 — Per-request channel name `gemini-stream-token:<requestId>` leaks renderer listeners

Each request creates a new channel name. The renderer must register a fresh listener per request and unregister after final/error. If the renderer crashes after a request and reloads, **listeners registered in the previous renderer instance are still attached on the main side until the WebContents is destroyed**. Long-lived sessions accumulate stale listeners.

**Fix**: Use a single `gemini-stream-event` channel; multiplex by `{requestId, kind: 'token'|'final'|'error'}`. One listener registration for the lifetime of the renderer.

### B-4.4 P1 — No backpressure: main keeps producing while renderer is slow

If the renderer is busy (heavy markdown render), `event.sender.send` queues messages indefinitely. There's no signal back to the producer. Memory grows; jank cascades.

**Fix**: Track outstanding-flush count via `gemini-stream-ack` reply from renderer; pause producer if outstanding > N. Or use `ipcRenderer.postMessage` + transferable buffers.

### B-4.5 P1 — `fullResponse` accumulator stored in main process for IntelligenceManager update

`fullResponse += token` (`electron/ipc/registerGeminiStreamIpcHandlers.ts:189`) duplicates the entire response in main-process memory. The renderer rebuilds the same string. Two copies × concurrent sessions = wasted memory.

**Fix**: After streaming completes, ask the renderer to send the assembled response back via a single `gemini-stream-finalize:<id>` IPC. Or: IntelligenceManager observes the stream chunks directly via an in-process subscriber.

### B-4.6 P1 — No retry/resume on partial response if IPC channel breaks

If the renderer reloads (Cmd-R), the main aborts the controller, the cloud stream cancels, the partial response is lost — the user pays the full cloud token cost for nothing.

**Fix**: Persist `fullResponse` to a session-scoped file every 500 ms during streaming. On renderer reload, the renderer asks main `gemini-stream-resume:<id>` and gets the partial. If the cloud stream is still alive, continue forwarding tokens.

### B-4.7 P2 — `previousController.abort()` collides with new request on the same `requestId`

Lines 84-88 of `registerGeminiStreamIpcHandlers.ts`: if the renderer reuses a `requestId`, the previous controller is aborted and **its in-flight error event might still fire on the same channel**, confusing the renderer that just started a new stream.

**Fix**: When aborting a previous controller, swap its `requestId` to a tombstone (`<id>-aborted-<uuid>`) so any late events go to a dead channel.

### B-4.8 P2 — `gemini-chat` (non-streaming) returns the full response over IPC in one shot

For >32 KB responses, IPC serialization stalls the main thread. Should chunk responses ≥16 KB.

**Fix**: For non-streaming responses, if length > 16 KB, internally redirect to the streaming path with a single-listener pattern, then resolve the original promise on completion.

### B-4.9 P2 — Cancel handler doesn't propagate to in-flight cloud HTTP request fast enough

`gemini-chat-cancel` (lines 228-240) calls `controller.abort()`. The `streamChat` consumer must propagate this through to the actual `fetch` AbortController of the cloud SDK. Some SDKs don't honor abort during streaming → cloud request continues to bill until completion.

**Fix**: Verify each provider client honors abort signal during streaming; for ones that don't, force-close the HTTP socket.

### B-4.10 P3 — Metrics gauge `stream.cancel_latency_ms` is a *gauge*, not a histogram

`Metrics.gauge('stream.cancel_latency_ms', ...)` (line 233) overwrites on each call. Histogram or counter would be more useful for diagnostics.

**Fix**: Use `Metrics.histogram` or `Metrics.observeLatency`.


---

## B-5. Cross-cutting Edge Cases

### B-5.1 P0 — System sleep / wake not handled outside of stealth

No power-monitor integration in `IntelligenceEngine`, `IntelligenceManager`, `ConsciousAccelerationOrchestrator`, ASR pipeline, or `PauseDetector`. After wake:

- In-flight cloud streams are dead but not aborted → pending responses arrive minutes later, possibly written to a session that has moved on.
- Conscious-mode threads remain "active" — the next user turn appears as a continuation of a thread that's been stale for hours.
- Speculative entries / prefetch caches retain timestamps from before sleep but `Date.now()` jumped → TTL math is broken.
- ASR connection (WebSocket) is dead; reconnection only triggered by next audio frame.

**Fix**: Single `system:power_state` event bus; subscribers implement `onSuspend()`/`onResume()`. On suspend: snapshot, abort streams, mark threads stale. On resume: validate connections, force conscious-thread reset if `now - lastTurnTs > 60 s`.

### B-5.2 P0 — `Date.now()` time-jump after sleep breaks all TTL-based caches

`PrefetchedIntent` TTL, `ConsciousCache` `ttlMs`, dedupe cache (`DEFAULT_DEDUPE_TTL_MS = 1500`), `SpeculativeAnswerEntry.startedAt` — all use `Date.now()`. After 8 hours of sleep, all entries are far past TTL but the eviction logic only triggers on access. **Stale entries can still be served if the very first post-wake access is within ms of insertion**.

**Fix**: On `resume`, force a sweep of all TTL-based stores. Or use `process.hrtime.bigint()` (monotonic) for relative timing.

### B-5.3 P1 — No handling of multiple concurrent meeting apps

If the user has both Zoom and Teams open with active screen-share sessions, the stealth detector (B-1.4) sees one or none; the protection state machine doesn't know about the multi-source case. macOS allows multiple SCStream sessions concurrently — each must be tracked.

**Fix**: Native module enumerates all active capture clients via `SCShareableContent.current.shareables`; protection state machine tracks the set, not a single boolean.

### B-5.4 P1 — Multi-display ergonomics: protection re-applied but window position not migrated

`bindDisplayEvents` reapplies protection on `display-added`/`display-removed`. If the window was on the unplugged external monitor, it migrates to the primary, but **the user's existing conscious-mode position state** is now wrong → window may end up off-screen.

**Fix**: On display change, validate window bounds against `screen.getAllDisplays()`; clamp into visible area before reapplying protection.

### B-5.5 P1 — No language detection, English-only assumptions throughout

PauseDetector conjunction list, IntentClassifier cue regex, behavioral STAR detection, conscious verifier rules — all assume English. Spanish, German, or Mandarin interviews produce broken classification, broken pause detection, and broken verifier rules.

**Fix**: Lightweight language detector at the top of the classification pipeline; route to language-specific rule sets. Or declare English-only with a startup guard.

### B-5.6 P1 — ASR connection state not surfaced; if it dies, conscious mode silently degrades

If the ASR WebSocket dies, audio frames keep being captured but no transcripts arrive. The pause detector keeps running on stale RMS, the conscious-mode pipeline never fires, and the user sees nothing happen — no error surface.

**Fix**: ASR provider exposes `onConnectionStateChange` events; UI shows a discrete `asr:degraded` indicator. Auto-reconnect with exponential backoff; surface failures after 3 attempts.

### B-5.7 P1 — No graceful handling of cloud LLM rate limits

`streamChat` provider chain (`electron/LLMHelper.ts`) cycles through providers on error but doesn't track *rate limit* state per provider. After hitting a 429 on Gemini, we keep trying Gemini for the next request, hit another 429, fall through to Claude, etc. — wasting 1–3 s per request on retries.

**Fix**: Per-provider exponential cooldown. On 429, mark provider unavailable for `Retry-After` seconds (or default 30 s); skip directly to next provider during that window.

### B-5.8 P2 — No keyboard-shortcut accessibility for users with mobility constraints

Hide/show flow relies on a global keyboard shortcut. No alternative input modality (gesture, voice command, accessibility-API trigger).

**Fix**: Expose `accessibility:invoke-stealth-toggle` IPC; map to macOS Accessibility API for VoiceOver users.

### B-5.9 P2 — Renderer crash → orphaned background timers in main

`StealthManager.scStreamMonitorHandle`, `restoreRetryHandle`, `TCCMonitor.checkHandle`, `intentPrefetchAbortController`, etc. — none are tied to a specific `WebContents`. If renderer crashes and a new one is created, all these timers/controllers are still running against the dead renderer's state.

**Fix**: Track per-WebContents lifecycle; on `webContents.on('destroyed')`, cancel orphaned handles.

### B-5.10 P2 — No graceful degradation when audio device is unplugged mid-session

If the user unplugs their headset mid-interview, audio capture switches to a different device (or stops). No `device-change` event handler in the audio pipeline; the speaker-segregation ML model continues with the old voice profile, producing miscategorization.

**Fix**: Subscribe to `navigator.mediaDevices.ondevicechange`; on device switch, re-enroll voice profiles or pause speaker segregation until re-enrolled.

### B-5.11 P2 — Clipboard not protected during streaming responses

If the renderer renders a streamed response and the user's auto-clipboard-monitor app (Paste, Maccy, Raycast) is running, partial response chunks may be auto-captured. No clipboard guard during conscious-mode output.

**Fix**: Renderer suppresses copy-events on conscious-mode response containers until streaming is complete; document the recommendation.

### B-5.12 P3 — No "session export" path for post-mortem review

A user finishing an interview may want to export the full session (transcript, suggestions, intents, verifier verdicts) for review or sharing. No IPC handler for this.

**Fix**: Add `session:export` IPC returning a structured JSON dump. Useful for support, debugging, and user trust.


---

## B-6. Severity-rolled Action Plan

### P0 (correctness/safety — fix this quarter)

| ID | Title | Subsystem | Effort |
|---|---|---|---|
| B-1.1 | Capture-detection hide loop can leave window invisible | Stealth | S |
| B-1.2 | TCC.db read silently broken on macOS 10.15+ | Stealth | M |
| B-1.3 | Enterprise tool detection list hard-coded + 16x pgrep | Stealth | M |
| B-2.1 | `hasUnsupportedTechnologyClaim` substring vs word-boundary | Conscious | XS |
| B-3.1 | `PauseDetector` thresholds global, not per-user/lang | Acceleration | M |
| B-4.1 | Stealth-containment check missing from streaming-error path | IPC | XS |
| B-5.1 | System sleep/wake not handled outside stealth | Cross | M |
| B-5.2 | `Date.now()` time-jump after sleep breaks TTL caches | Cross | S |

### P1 (significant accuracy/UX risk — fix next quarter)

| ID | Title | Subsystem | Effort |
|---|---|---|---|
| B-1.4 | SCStream detector misses inline `ScreenCaptureKit` consumers | Stealth | M |
| B-1.5 | No `lock-screen`/`suspend` handlers; watchdog runs through sleep | Stealth | S |
| B-1.6 | `bindPowerMonitor` listeners never removed | Stealth | XS |
| B-1.7 | Display change reapply misses Stage Manager / Mission Control / Spaces | Stealth | M |
| B-1.8 | `processEnumerator` (pgrep) timeout 5s blocks watchdog | Stealth | XS |
| B-2.2 | `hasUnsupportedNumericClaim` over-rejects on year mentions | Conscious | XS |
| B-2.3 | Tech allowlist small and brittle | Conscious | S |
| B-2.4 | Behavioral STAR depth rules reject legitimate concise answers | Conscious | M |
| B-2.5 | Thread continuation tokenizer drops too many stopwords | Conscious | M |
| B-2.6 | Provenance verifier silently skipped in degraded mode | Conscious | XS |
| B-2.7 | `isCircuitOpen` cooldown global, not per-failure-type | Conscious | S |
| B-3.2 | `PauseDetector` energy decay floor not adaptive | Acceleration | S |
| B-3.3 | `scoreTranscriptCompleteness` over-trusts ASR punctuation | Acceleration | S |
| B-3.4 | `scoreConversationRhythm` returns 0.5 on first turn | Acceleration | XS |
| B-3.5 | Prefetch races on overlapping silence events | Acceleration | S |
| B-3.6 | `invalidateSpeculation` aborts in-flight streams unconditionally | Acceleration | S |
| B-3.7 | `evictStaleSpeculativeEntries` aborts oldest, not least useful | Acceleration | S |
| B-4.2 | First token delayed by up to 16ms by batch flush | IPC | XS |
| B-4.3 | Per-request channel name leaks renderer listeners | IPC | M |
| B-4.4 | No backpressure: main keeps producing while renderer is slow | IPC | M |
| B-4.5 | `fullResponse` accumulator stored in main process | IPC | S |
| B-4.6 | No retry/resume on partial response if IPC channel breaks | IPC | M |
| B-5.3 | No handling of multiple concurrent meeting apps | Cross | M |
| B-5.4 | Multi-display ergonomics: window position not migrated | Cross | S |
| B-5.5 | No language detection; English-only assumptions | Cross | M |
| B-5.6 | ASR connection state not surfaced; conscious mode silently degrades | Cross | S |
| B-5.7 | No graceful handling of cloud LLM rate limits | Cross | S |

### P2 / P3 (optimization & polish — opportunistic)

Tracked in B-1.9–B-1.11, B-2.8–B-2.13, B-3.8–B-3.11, B-4.7–B-4.10, B-5.8–B-5.12.

---

## B-7. Suggested Sprint-Level Sequencing

**Sprint 1 (P0 wave 1, ~1 week)**:
- B-2.1 (substring → word-boundary, 5 LOC)
- B-2.6 (always run rule-based provenance, 10 LOC)
- B-1.6 (track listener handles, 30 LOC)
- B-1.8 (parallelize pgrep with timeout, 30 LOC)
- B-3.4 (initialize avgTurnDurationMs, 10 LOC)
- B-4.1 (add containment check to error path, 5 LOC)
- B-4.2 (force-flush first token, 10 LOC)

**Sprint 2 (P0 system events, ~1 week)**:
- B-5.1 (`system:power_state` event bus + subscribers)
- B-5.2 (TTL sweep on resume; or migrate to monotonic clock)
- B-1.5 (lock-screen + suspend handlers in stealth)

**Sprint 3 (P0 stealth correctness, ~1.5 weeks)**:
- B-1.1 (capture-loop unrecoverable recovery + force-show)
- B-1.2 (replace TCC.db with `CGPreflightScreenCaptureAccess` + native helper)
- B-1.3 (single ps -ax + externalize threats.json)

**Sprint 4 (P1 acceleration accuracy, ~1.5 weeks)**:
- B-3.2 (adaptive noise floor)
- B-3.3 (discount ASR punctuation when prior was disfluent)
- B-3.6 (don't abort speculation on Jaccard-stable revisions)
- B-3.7 (semantic eviction, not pure age)

**Sprint 5 (P1 verifier hardening, ~1 week)**:
- B-2.3 (expand tech allowlist)
- B-2.4 (relax STAR floor + lean on LLM judge)
- B-2.7 (per-failure-type cooldowns)

**Sprint 6 (P1 IPC + reliability, ~1.5 weeks)**:
- B-4.3 (single multiplexed channel)
- B-4.4 (backpressure ack)
- B-4.5 (drop main-side response accumulator)
- B-4.6 (resume on renderer reload)

**Sprint 7 (P1 system robustness, ~1 week)**:
- B-5.5 (language detection or guard)
- B-5.6 (ASR `onConnectionStateChange`)
- B-5.7 (per-provider rate-limit cooldowns)

After Sprint 7, the system has shipped fixes for every P0 and the highest-leverage P1s. Remaining P1/P2/P3 are tracked as opportunistic.

---

## B-8. Verification & Telemetry Investments

To make these changes safe to roll out and to keep them safe:

1. **Eval harness**:
   - **Conscious eval** (`electron/conscious/ConsciousEvalHarness.ts`) — extend with cases that exercise B-2.1, B-2.2, B-2.4 (substring tech claims, year mentions, concise STAR).
   - **Acceleration eval** — new harness measuring `false-commit rate`, `missed-turn-end rate`, `speculative wasted spend per session` with synthetic transcripts.
   - **Stealth eval** — recorded SCK-active sessions; assert protection state transitions.

2. **Runtime telemetry (privacy-respecting)**:
   - Counter: `verifier.rule_failures{reason}` (split by reason: numeric, tech, behavioral_depth, etc.).
   - Counter: `acceleration.speculation_aborted{cause}` (transcript_revision, eviction, user_speaking, error).
   - Counter: `acceleration.speculation_wasted_tokens` (sum of partialText.length for aborted entries).
   - Counter: `stealth.capture_detected_total{tool}`.
   - Histogram: `stream.first_token_ms`, `stream.cancel_to_close_ms`.
   - Gauge: `stealth.confidence` (high/reduced/compromised).

3. **Feature flags** for risky changes:
   - `useAdaptivePauseDetector` (B-3.1, B-3.2)
   - `useFuzzySpeculationMatch` (B-2.12)
   - `useMultiplexedIpcChannel` (B-4.3)
   - `usePersistentRendererBackpressure` (B-4.4)

4. **Rollout safety**:
   - Each P0 lands behind a flag, defaulted **off**, and only flipped on after 7 days of canary metrics.
   - Each P1 lands behind a flag, defaulted **on**, with a kill-switch.
   - All rule-tuning changes (B-2.4, B-2.3) require eval-harness regression test before merge.

