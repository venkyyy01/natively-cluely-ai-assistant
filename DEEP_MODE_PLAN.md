# Deep Mode — Implementation Plan

## Name
**"Deep Mode"** — UI toggle: *Comprehensive, human-like answers with full conversation context*

## Architecture Overview
```
Question enters → classifyDeepModeQuestion() → runDeepModeAnswer()
  ├─ Assemble FULL context (parallel, no budget)
  ├─ Intent classify via cURL
  ├─ executeDeep() → cURL + deep prompt + full context
  │   ├─ Stream spokenResponse IMMEDIATELY (~300ms TTFT)
  │   └─ Background: claim extraction + parallel verification
  └─ Fallback: Deep → Conscious (normal) → Standard flow
```

## Score Targets (>8/10 on all 10 passes)

| # | Pass | Current | Target | How |
|---|------|---------|--------|-----|
| 1 | Classification | 5 | 9 | Permit everything except explicit admin prompts |
| 2 | Context | 5 | 8 | Full transcript + all embeddings + answer history; adaptive trim |
| 3 | Token budget | 3 | 9 | Remove ALL limits; cURL template controls max_tokens |
| 4 | Response pipeline | 5 | 9 | Stream on first token; background verify; never block |
| 5 | Verification | 5 | 8 | Background parallel claim verification; log failures |
| 6 | Speculation | 5 | 8 | Aggressive intent prefetch; speculative answers disabled |
| 7 | Prompts | 6 | 9 | Remove anti-dump rules; keep speech style; deep answers |
| 8 | Model strategy | 5 | 8 | cURL-only; adaptive context window; smooth failover |
| 9 | Memory | 4 | 8 | Wire assistantResponseHistory into context; anti-repetition |
| 10 | Latency | 5 | 9 | Perceived ~1s (immediate stream); parallel context assembly |

## Advanced Accuracy: Stream-First, Verify-Background
```
cURL generates answer (streaming)
  ├─ [FOREGROUND] Stream tokens to UI immediately
  └─ [BACKGROUND] Extract claims → verify each (parallel) → emit correction if needed
```

## Implementation Steps

### Step 1: `electron/conscious/DeepMode.ts` (NEW)
- DeepModeState, DeepModeConfig interfaces
- classifyDeepModeQuestion() — permissive gate
- extractClaims() — claim decomposition from structured response

### Step 2: `electron/main/AppState.ts`
- Privacy shield race fix: guard stealth-degraded during undetectable disable

### Step 3: `electron/llm/prompts.ts`
- CONSCIOUS_DEEP_IDENTITY — speech style kept, anti-dump rules removed
- CONSCIOUS_DEEP_CONTRACT — field emptiness rules removed

### Step 4: `electron/conscious/TokenBudget.ts`
- Deep mode bypass: all token queries return Infinity

### Step 5: `electron/LLMHelper.ts`
- deepMode flag + setter/getter
- Skip context trimming in deep mode
- No standard provider fallback (line 3312)
- Adaptive context window (detect + halve on overflow)
- verifyClaimsInBackground() — parallel claim verification via cURL

### Step 6: `electron/ConsciousMode.ts`
- Expand isSystemDesignQuestion (+30 patterns)
- Expand isBroadConsciousSeed (+25 domain keywords)

### Step 7: `electron/conscious/ConsciousOrchestrator.ts`
- executeDeep() — streaming, non-blocking verify, adaptive context
- No circuit breaker in deep mode

### Step 8: `electron/IntelligenceEngine.ts`
- runDeepModeAnswer() — full pipeline entry
- Full context assembly (all transcripts, all embeddings, answer history)
- Fallback: deep → conscious (normal) → standard

### Step 9: `electron/ConsciousAccelerationOrchestrator.ts`
- Skip speculative answers in deep mode
- Keep intent prefetch

### Step 10: Tests — `electron/tests/deepMode.test.ts`
- 8+ tests covering classification, context, adaptive, fallback, verification, prompts, claims

### Step 11: Rebuild & verify
```bash
tsc -p electron/tsconfig.json
node --test dist-electron/electron/tests/deepMode.test.js
```

## Fallback Hierarchy
```
Deep Mode (cURL, full context)
  ├─ Success → stream + background verify
  ├─ Context overflow → halve (32K→16K→8K→4K) → retry
  ├─ cURL timeout → retry once
  └─ FALLBACK: Conscious Mode (normal) → Standard flow
```
Answer ALWAYS reaches UI. NEVER blocked.

## Files Changed
| File | Change |
|------|--------|
| electron/conscious/DeepMode.ts | NEW |
| electron/main/AppState.ts | privacy shield guard |
| electron/llm/prompts.ts | deep identity + contract |
| electron/conscious/TokenBudget.ts | deep mode bypass |
| electron/LLMHelper.ts | deep mode flag, adaptive context, claim verify, skip fallback |
| electron/ConsciousMode.ts | expanded patterns |
| electron/conscious/ConsciousOrchestrator.ts | executeDeep() |
| electron/IntelligenceEngine.ts | runDeepModeAnswer() |
| electron/ConsciousAccelerationOrchestrator.ts | skip speculation |
| electron/tests/deepMode.test.ts | NEW |
