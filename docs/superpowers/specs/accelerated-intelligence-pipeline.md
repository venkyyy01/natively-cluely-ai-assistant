# Accelerated Intelligence Pipeline

## Overview

This spec defines a hybrid optimization approach for Natively's real-time interview copilot, combining Neural Engine acceleration, prompt optimization, and intelligent context management to achieve significant improvements in latency, context quality, memory efficiency, and token cost.

**Target Hardware**: Apple Silicon (M1+)
**Inference Strategy**: Hybrid (cloud primary, local fallback)
**Complexity Budget**: Moderate (new abstractions OK)

## Goals & Success Metrics

| Goal | Current State | Target | Measurement |
|------|---------------|--------|-------------|
| **Latency (time-to-first-token)** | ~800-1200ms | <400ms | P95 measured in production |
| **Latency (full response)** | ~2-4s | <1.5s perceived | User perception (streaming) |
| **Token usage per response** | ~4000-6000 tokens | ~2500-4000 tokens | Provider billing dashboard |
| **Memory (long interview)** | ~500MB+ after 1hr | <300MB | Electron process memory |
| **Context relevance** | Keyword-based | Semantic + temporal | User satisfaction / answer quality |
| **Embedding latency** | ~100-150ms | <10ms | Local benchmark |

## Non-Goals

- Windows/Linux support (Apple Silicon only for this phase)
- Fine-tuned local models (using pre-trained models only)
- Replacing cloud LLM for answer generation (cloud remains primary)
- Breaking changes to existing API contracts

---

## Architecture

### High-Level Flow

```
User Input → Parallel Processing Layer → Context Aggregator → Prompt Assembly → LLM Call (Streaming) → UI
                                                                                        ↓
                                                                              Background Processing
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                    Main Process                                      │
│                                                                                      │
│  ┌────────────────────────────────────────────────────────────────────────────────┐ │
│  │                         IntelligenceEngine (Enhanced)                          │ │
│  │                                                                                 │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                │ │
│  │  │ PromptCompiler  │  │ ContextManager  │  │ StreamManager   │                │ │
│  │  │ (new)           │  │ (enhanced)      │  │ (new)           │                │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                │ │
│  │                                                                                 │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              Worker Thread Pool                                 │ │
│  │                                                                                 │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                │ │
│  │  │ EmbeddingWorker │  │ ScoringWorker   │  │ PrefetchWorker  │                │ │
│  │  │ (ANE/ONNX)      │  │ (BM25+Semantic) │  │ (predictive)    │                │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                │ │
│  │                                                                                 │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              Cache Layer (Enhanced)                             │ │
│  │                                                                                 │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                │ │
│  │  │ LRUCache        │  │ SemanticCache   │  │ PrefetchCache   │                │ │
│  │  │ (TTL + eviction)│  │ (embedding-key) │  │ (warm responses)│                │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                │ │
│  │                                                                                 │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Quick Wins (Week 1)

### 1.1 Prompt Template Deduplication

**Problem**: The current `prompts.ts` (1500+ lines) contains massive redundancy:
- `CORE_IDENTITY` (~1200 chars) repeated in every prompt variant
- `CONSCIOUS_MODE_JSON_CONTRACT` (~2000 chars) repeated 10+ times
- 5 near-identical provider variants (Groq, OpenAI, Claude, Gemini, Universal)

**Solution**: Implement a `PromptCompiler` that:
1. Defines shared prompt components as constants
2. Assembles prompts at runtime with provider-specific deltas
3. Caches assembled prompts by (provider, phase, mode) tuple

**File Changes**:
- `electron/llm/prompts.ts` → Refactor to use `PromptCompiler`
- `electron/llm/PromptCompiler.ts` → New file

**Implementation**:

```typescript
// electron/llm/PromptCompiler.ts

interface PromptComponents {
  coreIdentity: string;
  jsonContract: string;
  phaseGuidance: Map<InterviewPhase, string>;
  providerAdapters: Map<Provider, ProviderAdapter>;
}

interface ProviderAdapter {
  systemPromptWrapper: (base: string) => string;
  responseFormatHints: string;
  tokenBudgetMultiplier: number;
}

class PromptCompiler {
  private cache: LRUCache<string, CompiledPrompt>;
  private components: PromptComponents;

  compile(options: {
    provider: Provider;
    phase: InterviewPhase;
    mode: 'conscious' | 'standard';
    context: ContextSnapshot;
  }): CompiledPrompt {
    const cacheKey = this.getCacheKey(options);
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const compiled = this.assemble(options);
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  private assemble(options: CompileOptions): CompiledPrompt {
    const adapter = this.components.providerAdapters.get(options.provider);
    const phaseGuidance = this.components.phaseGuidance.get(options.phase);

    const basePrompt = [
      this.components.coreIdentity,
      options.mode === 'conscious' ? this.components.jsonContract : '',
      phaseGuidance,
    ].filter(Boolean).join('\n\n');

    return {
      systemPrompt: adapter.systemPromptWrapper(basePrompt),
      responseFormat: adapter.responseFormatHints,
      estimatedTokens: this.estimateTokens(basePrompt) * adapter.tokenBudgetMultiplier,
    };
  }
}
```

**Token Savings Estimate**:
- Current: ~4000 tokens system prompt per request
- After: ~2500 tokens (shared components cached, only deltas transmitted)
- **Savings: 30-40%**

---

### 1.2 Streaming-First Response Pipeline

**Problem**: Current flow waits for full LLM response before rendering, causing perceived latency of 2-4 seconds.

**Solution**: Implement `StreamManager` that:
1. Streams tokens to UI immediately as they arrive
2. Runs background processing (context update, scoring) in parallel
3. Handles partial JSON parsing for conscious mode

**File Changes**:
- `electron/llm/StreamManager.ts` → New file
- `electron/LLMHelper.ts` → Integrate StreamManager
- `electron/IntelligenceEngine.ts` → Update response handling

**Implementation**:

```typescript
// electron/llm/StreamManager.ts

interface StreamConfig {
  onToken: (token: string) => void;
  onPartialJson: (partial: Partial<ConsciousResponse>) => void;
  onComplete: (full: ConsciousResponse) => void;
  onError: (error: Error) => void;
}

class StreamManager {
  private jsonAccumulator: string = '';
  private partialParser: PartialJsonParser;

  async processStream(
    stream: AsyncIterable<StreamChunk>,
    config: StreamConfig
  ): Promise<void> {
    const backgroundTasks: Promise<void>[] = [];

    for await (const chunk of stream) {
      // Immediate: send to UI
      config.onToken(chunk.text);

      // Accumulate for JSON parsing
      this.jsonAccumulator += chunk.text;

      // Try partial parse every N characters
      if (this.jsonAccumulator.length % 100 === 0) {
        const partial = this.partialParser.tryParse(this.jsonAccumulator);
        if (partial) {
          config.onPartialJson(partial);
          
          // Background: start context update early if we have enough
          if (partial.answer && partial.answer.length > 50) {
            backgroundTasks.push(this.prefetchRelatedContext(partial));
          }
        }
      }
    }

    // Wait for background tasks
    await Promise.all(backgroundTasks);
    
    const full = JSON.parse(this.jsonAccumulator);
    config.onComplete(full);
  }
}
```

**Latency Impact**:
- Time-to-first-token: ~100-200ms (down from ~800-1200ms)
- Perceived full response: User sees text immediately
- **Perceived latency reduction: 50-70%**

---

### 1.3 LRU Cache Upgrade

**Problem**: Current caches use TTL-only eviction, leading to:
- Memory growth over long sessions
- Cache misses for semantically similar queries
- No prioritization of frequently-used entries

**Solution**: Implement `EnhancedCache` with:
1. LRU eviction + TTL expiration (hybrid)
2. Optional semantic similarity lookup for near-miss hits
3. Memory pressure monitoring

**File Changes**:
- `electron/cache/EnhancedCache.ts` → New file
- `electron/LLMHelper.ts` → Replace existing caches

**Implementation**:

```typescript
// electron/cache/EnhancedCache.ts

interface CacheConfig {
  maxSize: number;
  ttlMs: number;
  enableSemanticLookup?: boolean;
  similarityThreshold?: number; // 0.0 - 1.0
}

class EnhancedCache<K, V> {
  private lru: Map<string, CacheEntry<V>> = new Map();
  private embeddings?: Map<string, number[]>; // For semantic lookup
  
  constructor(private config: CacheConfig) {
    if (config.enableSemanticLookup) {
      this.embeddings = new Map();
    }
  }

  async get(key: K, embedding?: number[]): Promise<V | undefined> {
    const stringKey = this.serialize(key);
    
    // Exact match (fast path)
    const exact = this.lru.get(stringKey);
    if (exact && !this.isExpired(exact)) {
      this.touchEntry(stringKey);
      return exact.value;
    }

    // Semantic lookup (if enabled and embedding provided)
    if (this.config.enableSemanticLookup && embedding) {
      const similar = this.findSimilar(embedding);
      if (similar) {
        return similar.value;
      }
    }

    return undefined;
  }

  set(key: K, value: V, embedding?: number[]): void {
    const stringKey = this.serialize(key);
    
    // Evict if at capacity
    while (this.lru.size >= this.config.maxSize) {
      this.evictOldest();
    }

    this.lru.set(stringKey, {
      value,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    });

    if (this.config.enableSemanticLookup && embedding) {
      this.embeddings!.set(stringKey, embedding);
    }
  }

  private findSimilar(embedding: number[]): CacheEntry<V> | undefined {
    let bestMatch: { key: string; similarity: number } | undefined;

    for (const [key, storedEmbedding] of this.embeddings!) {
      const similarity = this.cosineSimilarity(embedding, storedEmbedding);
      if (similarity >= this.config.similarityThreshold! &&
          (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { key, similarity };
      }
    }

    if (bestMatch) {
      const entry = this.lru.get(bestMatch.key);
      if (entry && !this.isExpired(entry)) {
        return entry;
      }
    }

    return undefined;
  }
}
```

**Impact**:
- Memory: Bounded growth, automatic eviction
- Cache hits: 20-30% improvement from semantic similarity
- **Memory savings: 30-50% for long sessions**

---

## Phase 2: Neural Acceleration (Week 2)

### 2.1 ANE-Accelerated Embeddings

**Problem**: Current `LocalEmbeddingProvider` uses transformers.js which:
- Runs on CPU only
- Takes 100-150ms per embedding
- Doesn't leverage Apple Neural Engine

**Solution**: Replace with ONNX Runtime using CoreML execution provider:
1. Export `all-MiniLM-L6-v2` to ONNX format with CoreML optimization
2. Use `onnxruntime-node` with CoreML backend
3. Fall back to CPU if ANE unavailable

**File Changes**:
- `electron/rag/ANEEmbeddingProvider.ts` → New file
- `electron/rag/LocalEmbeddingProvider.ts` → Keep as fallback
- `electron/rag/EmbeddingPipeline.ts` → Add provider selection

**Dependencies**:
```json
{
  "onnxruntime-node": "^1.17.0"
}
```

**Implementation**:

```typescript
// electron/rag/ANEEmbeddingProvider.ts

import * as ort from 'onnxruntime-node';

class ANEEmbeddingProvider implements EmbeddingProvider {
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer;
  
  async initialize(): Promise<void> {
    const modelPath = path.join(__dirname, 'models', 'minilm-l6-v2.onnx');
    
    // Try CoreML (ANE) first, fall back to CPU
    const executionProviders = ['coreml', 'cpu'];
    
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });

    this.tokenizer = await this.loadTokenizer();
    
    console.log(`ANE Embedding Provider initialized with: ${this.session.handler.name}`);
  }

  async embed(text: string): Promise<number[]> {
    const tokens = this.tokenizer.encode(text);
    
    const inputIds = new ort.Tensor('int64', BigInt64Array.from(tokens.ids.map(BigInt)), [1, tokens.ids.length]);
    const attentionMask = new ort.Tensor('int64', BigInt64Array.from(tokens.attentionMask.map(BigInt)), [1, tokens.attentionMask.length]);

    const results = await this.session!.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
    });

    // Mean pooling
    const embeddings = results['last_hidden_state'].data as Float32Array;
    return this.meanPool(embeddings, tokens.attentionMask);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Batch processing for efficiency
    const paddedTokens = this.tokenizer.encodeBatch(texts);
    // ... batch inference
  }
}
```

**Performance Impact**:
- Current: 100-150ms per embedding (CPU)
- Target: 2-10ms per embedding (ANE)
- **Speedup: 10-50x**

---

### 2.2 Parallel Context Assembly

**Problem**: Context assembly is sequential:
1. Generate embedding → 2. Run BM25 → 3. Detect phase → 4. Score confidence

**Solution**: Run independent operations in parallel using worker threads:

```typescript
// electron/workers/ContextAssemblyWorker.ts

interface ContextAssemblyInput {
  query: string;
  transcript: TranscriptEntry[];
  previousContext: ContextSnapshot;
}

interface ContextAssemblyOutput {
  embedding: number[];
  bm25Results: ScoredEntry[];
  phase: InterviewPhase;
  confidence: number;
  relevantContext: ContextEntry[];
}

// Main thread orchestrator
class ParallelContextAssembler {
  private embeddingWorker: Worker;
  private scoringWorker: Worker;

  async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyOutput> {
    // Launch all independent tasks in parallel
    const [embedding, bm25Results, phase] = await Promise.all([
      this.embeddingWorker.embed(input.query),
      this.scoringWorker.runBM25(input.query, input.transcript),
      this.detectPhase(input.transcript), // Fast, can run on main thread
    ]);

    // Dependent task: needs embedding + bm25
    const relevantContext = await this.selectContext({
      embedding,
      bm25Results,
      phase,
      budget: this.getTokenBudget(phase),
    });

    const confidence = this.calculateConfidence(embedding, relevantContext);

    return { embedding, bm25Results, phase, confidence, relevantContext };
  }
}
```

**Latency Impact**:
- Current: ~200-300ms (sequential)
- Target: ~80-120ms (parallel)
- **Speedup: 2-3x**

---

## Phase 3: Intelligent Context (Week 3)

### 3.1 Adaptive Context Windowing

**Problem**: Current context selection uses fixed windows (recent 120 seconds) without considering semantic relevance.

**Solution**: Implement semantic relevance scoring for context selection:

```typescript
// electron/conscious/AdaptiveContextWindow.ts

interface ContextSelectionConfig {
  tokenBudget: number;
  recencyWeight: number;      // 0.0 - 1.0
  semanticWeight: number;     // 0.0 - 1.0
  phaseAlignmentWeight: number;
}

class AdaptiveContextWindow {
  async selectContext(
    query: string,
    queryEmbedding: number[],
    candidates: ContextEntry[],
    config: ContextSelectionConfig
  ): Promise<ContextEntry[]> {
    // Score each candidate
    const scored = await Promise.all(
      candidates.map(async (entry) => ({
        entry,
        score: await this.computeScore(entry, queryEmbedding, config),
      }))
    );

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Greedily select within token budget
    const selected: ContextEntry[] = [];
    let usedTokens = 0;

    for (const { entry, score } of scored) {
      const entryTokens = this.estimateTokens(entry);
      if (usedTokens + entryTokens <= config.tokenBudget) {
        selected.push(entry);
        usedTokens += entryTokens;
      }
    }

    return selected;
  }

  private async computeScore(
    entry: ContextEntry,
    queryEmbedding: number[],
    config: ContextSelectionConfig
  ): number {
    const recencyScore = this.computeRecency(entry.timestamp);
    const semanticScore = this.cosineSimilarity(entry.embedding, queryEmbedding);
    const phaseScore = this.computePhaseAlignment(entry.phase, this.currentPhase);

    return (
      config.recencyWeight * recencyScore +
      config.semanticWeight * semanticScore +
      config.phaseAlignmentWeight * phaseScore
    );
  }
}
```

---

### 3.2 Predictive Prefetching

**Problem**: Every question requires full context assembly, even for predictable follow-ups.

**Solution**: During silence periods, predict and pre-compute likely follow-up contexts:

```typescript
// electron/prefetch/PredictivePrefetcher.ts

class PredictivePrefetcher {
  private prefetchCache: EnhancedCache<string, PrefetchedContext>;
  private isUserSpeaking: boolean = false;

  onSilenceStart(): void {
    this.isUserSpeaking = false;
    this.startPrefetching();
  }

  private async startPrefetching(): Promise<void> {
    const predictions = this.predictFollowUps();
    
    for (const prediction of predictions) {
      if (this.isUserSpeaking) break; // Stop if user starts speaking
      
      const context = await this.assembleContext(prediction.query);
      this.prefetchCache.set(prediction.query, {
        context,
        embedding: prediction.embedding,
        confidence: prediction.confidence,
      });
    }
  }

  private predictFollowUps(): PredictedFollowUp[] {
    const currentPhase = this.getInterviewPhase();
    const recentTopics = this.extractRecentTopics();
    
    // Phase-based predictions
    const phasePredictions = PHASE_FOLLOWUP_PATTERNS[currentPhase];
    
    // Topic-based predictions (e.g., if discussing "caching", predict "invalidation", "TTL", "eviction")
    const topicPredictions = recentTopics.flatMap(topic => 
      TOPIC_FOLLOWUPS[topic] || []
    );

    return [...phasePredictions, ...topicPredictions]
      .slice(0, 5) // Limit to 5 predictions
      .map(query => ({
        query,
        embedding: this.quickEmbed(query),
        confidence: this.estimateConfidence(query),
      }));
  }

  async getContext(query: string, embedding: number[]): Promise<ContextSnapshot | null> {
    // Check prefetch cache with semantic similarity
    return this.prefetchCache.get(query, embedding);
  }
}
```

---

## Migration Strategy

### Phase 1 (Week 1) - Non-Breaking
1. Add `PromptCompiler` alongside existing prompts
2. Add `StreamManager` with feature flag
3. Add `EnhancedCache` with gradual rollout

### Phase 2 (Week 2) - Optional New Dependencies
1. Add ONNX Runtime as optional dependency
2. `ANEEmbeddingProvider` auto-detects and falls back
3. Worker thread pool with graceful degradation

### Phase 3 (Week 3) - New Features
1. `AdaptiveContextWindow` replaces fixed window
2. `PredictivePrefetcher` runs opportunistically
3. All features can be disabled via config

---

## Testing Strategy

### Unit Tests
- `PromptCompiler`: Token count accuracy, cache behavior
- `StreamManager`: Partial JSON parsing, error handling
- `EnhancedCache`: LRU eviction, TTL expiration, semantic lookup
- `ANEEmbeddingProvider`: Output dimension, similarity preservation

### Integration Tests
- End-to-end latency measurement
- Memory usage over 1-hour simulated interview
- Fallback behavior when ANE unavailable

### Benchmarks
- Embedding latency: CPU vs ANE
- Cache hit rates before/after semantic lookup
- Token usage with new vs old prompts

---

## Rollback Plan

Each optimization is independently toggleable:

```typescript
// electron/config/optimizations.ts
export const OPTIMIZATION_FLAGS = {
  usePromptCompiler: true,
  useStreamManager: true,
  useEnhancedCache: true,
  useANEEmbeddings: true,
  useParallelContext: true,
  useAdaptiveWindow: true,
  usePrefetching: true,
};
```

If issues arise:
1. Disable specific flag
2. System falls back to previous implementation
3. No data migration needed

---

## Success Criteria

| Metric | Baseline | Target | Measurement Method |
|--------|----------|--------|-------------------|
| Time-to-first-token | 800-1200ms | <400ms | Performance.mark() in renderer |
| Token usage | 4000-6000/response | 2500-4000/response | Provider billing API |
| Memory (1hr interview) | 500MB+ | <300MB | process.memoryUsage() sampling |
| Embedding latency | 100-150ms | <10ms | Worker thread timing |
| Cache hit rate | ~30% | >50% | Cache statistics logging |

---

## Open Questions

1. **ONNX Model Hosting**: Bundle with app or download on first run?
2. **Worker Thread Count**: Fixed (e.g., 4) or adaptive to CPU cores?
3. **Prefetch Aggressiveness**: How many predictions during silence?
4. **Semantic Cache Threshold**: What similarity score for cache hit?

---

## Appendix: File Changes Summary

### New Files
- `electron/llm/PromptCompiler.ts`
- `electron/llm/StreamManager.ts`
- `electron/cache/EnhancedCache.ts`
- `electron/rag/ANEEmbeddingProvider.ts`
- `electron/workers/ContextAssemblyWorker.ts`
- `electron/conscious/AdaptiveContextWindow.ts`
- `electron/prefetch/PredictivePrefetcher.ts`
- `electron/config/optimizations.ts`

### Modified Files
- `electron/llm/prompts.ts` - Refactor to use PromptCompiler
- `electron/LLMHelper.ts` - Integrate StreamManager, EnhancedCache
- `electron/IntelligenceEngine.ts` - Use parallel context assembly
- `electron/rag/EmbeddingPipeline.ts` - Add ANE provider selection
- `electron/conscious/ThreadManager.ts` - Use adaptive windowing

### New Dependencies
- `onnxruntime-node` - ONNX Runtime with CoreML support
- `lru-cache` - LRU cache implementation (or implement custom)
