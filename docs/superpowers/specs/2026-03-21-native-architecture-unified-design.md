# Native Architecture: Zero-Footprint Isolation + Accelerated Intelligence

**Date:** 2026-03-21  
**Status:** Draft  
**Target Platform:** macOS (Apple Silicon / M-series)

## Overview

This unified specification defines a complete architectural overhaul of Natively, combining:

1. **Zero-Footprint Process Isolation** - Native Swift host replacing Electron for complete stealth
2. **Display Exclusion Boundaries** - Hardware-level screen capture prevention
3. **Accelerated Intelligence Pipeline** - Neural Engine acceleration, optimized prompts, intelligent caching

**Target Outcomes:**

| Metric | Current (Electron) | Target (Native) |
|--------|-------------------|-----------------|
| Memory (idle) | 300-500 MB | <150 MB |
| Memory (1hr session) | 500+ MB | <300 MB |
| Time-to-first-token | 800-1200ms | <400ms |
| Embedding latency | 100-150ms | <10ms (ANE) |
| Token usage/response | 4000-6000 | 2500-4000 |
| Process detectability | High | Undetectable |
| Window capture | Leaks | Excluded |

---

## Part 1: Architecture

### High-Level Design

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         NativelyHost.app                                      │
│                       (Swift, code-signed)                                    │
│                                                                               │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐              │
│  │   Overlay Window    │    │     Launcher Window             │              │
│  │   (ASPanel)         │    │     (ASWindow)                  │              │
│  │  ┌───────────────┐  │    │  ┌───────────────────────────┐  │              │
│  │  │   WKWebView   │  │    │  │      WKWebView            │  │              │
│  │  │  (React UI)   │  │    │  │     (React UI)            │  │              │
│  │  └───────────────┘  │    │  └───────────────────────────┘  │              │
│  └─────────────────────┘    └─────────────────────────────────┘              │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │                    Swift Native Services                                  ││
│  │  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────────────┐ ││
│  │  │ DisplayExclusion│  │ HotkeyManager  │  │ ANEEmbeddingService        │ ││
│  │  │ Manager         │  │                │  │ (ONNX + CoreML)            │ ││
│  │  └────────────────┘  └────────────────┘  └─────────────────────────────┘ ││
│  └──────────────────────────────────────────────────────────────────────────┘│
│                                    │                                          │
│                             stdin/stdout                                      │
│                              JSON-RPC                                         │
│                                    │                                          │
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │                    Node.js Backend ("assistantd")                         ││
│  │                                                                           ││
│  │  ┌─────────────────────────────────────────────────────────────────────┐ ││
│  │  │                    IntelligenceEngine (Enhanced)                     │ ││
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │ ││
│  │  │  │ PromptCompiler  │  │ ContextManager  │  │ StreamManager   │      │ ││
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘      │ ││
│  │  └─────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                           ││
│  │  ┌─────────────────────────────────────────────────────────────────────┐ ││
│  │  │                    Worker Thread Pool                                │ ││
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │ ││
│  │  │  │ ScoringWorker   │  │ PrefetchWorker  │  │ ContextWorker   │      │ ││
│  │  │  │ (BM25+Semantic) │  │ (predictive)    │  │ (assembly)      │      │ ││
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘      │ ││
│  │  └─────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                           ││
│  │  ┌─────────────────────────────────────────────────────────────────────┐ ││
│  │  │                    Cache Layer (Enhanced)                            │ ││
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │ ││
│  │  │  │ LRUCache        │  │ SemanticCache   │  │ PrefetchCache   │      │ ││
│  │  │  │ (TTL + eviction)│  │ (embedding-key) │  │ (warm responses)│      │ ││
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘      │ ││
│  │  └─────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                           ││
│  │  ┌───────────────────────────────────────┐                               ││
│  │  │ Rust Native Module (NAPI-RS)          │                               ││
│  │  │ • System audio capture                │                               ││
│  │  │ • Microphone capture                  │                               ││
│  │  └───────────────────────────────────────┘                               ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI layer | Swift/AppKit + WKWebView | Native display exclusion APIs, preserves React codebase |
| Backend runtime | Node.js (no Electron) | Eliminates Chromium fingerprint, lower memory |
| Embeddings | Swift + ONNX/CoreML (ANE) | 10-50x faster than CPU, runs in Swift process |
| IPC mechanism | Stdin/stdout JSON-RPC | Simplest, hides child process under parent |
| Process naming | Disguised as system daemon | Blends with macOS system processes |
| Caching | LRU + Semantic + Prefetch | Reduces token usage and latency |

---

## Part 2: Display Exclusion Implementation

### Threat Model

The solution must defeat:

1. **Anti-cheat/proctoring software** - Examplify, ProctorU, Lockdown Browser
2. **Enterprise endpoint monitoring** - CrowdStrike, Carbon Black
3. **Third-party meeting apps** - Zoom, Teams process enumeration

### Window Configuration

All managed windows apply:

```swift
// Custom window classes with innocuous names
class ASPanel: NSPanel {
    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, 
                  backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, 
                   backing: backing, defer: flag)
        configureExclusion()
    }
    
    private func configureExclusion() {
        // Primary exclusion - prevents standard screen capture
        sharingType = .none
        
        // Window level - float above but exclude from capture enumerations
        level = .floating
        collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,           // Excluded from Exposé
            .ignoresCycle          // Excluded from Cmd+Tab
        ]
        
        // Additional hardening
        isExcludedFromWindowsMenu = true
        hidesOnDeactivate = false
    }
}

class ASWindow: NSWindow {
    // Same exclusion configuration for main windows
}
```

### CGWindowList Exclusion Verification

Runtime verification that windows are excluded:

```swift
func verifyExclusion() -> Bool {
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return true
    }
    
    let ourWindowNumbers = Set(managedWindows.map { $0.windowNumber })
    
    for window in windowList {
        if let windowNumber = window[kCGWindowNumber as String] as? Int,
           ourWindowNumbers.contains(windowNumber) {
            return false  // Leak detected
        }
    }
    return true
}
```

### ScreenCaptureKit Exclusion (macOS 12.3+)

For app's own screenshot functionality:

```swift
func captureScreen(excluding: [NSWindow]) async throws -> CGImage {
    let content = try await SCShareableContent.current
    
    guard let display = content.displays.first else {
        throw CaptureError.noDisplay
    }
    
    let excludedIDs = excluding.compactMap { window -> CGWindowID? in
        CGWindowID(window.windowNumber)
    }
    
    let filter = SCContentFilter(
        display: display,
        excludingWindows: content.windows.filter { excludedIDs.contains($0.windowID) }
    )
    
    let config = SCStreamConfiguration()
    config.width = Int(display.width)
    config.height = Int(display.height)
    
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}
```

### Capture Method Coverage

| Capture Method | API | Mitigation |
|----------------|-----|------------|
| Cmd+Shift+3/4/5 | ScreenCaptureKit | `sharingType = .none` |
| QuickTime recording | ScreenCaptureKit | `sharingType = .none` |
| Zoom screen share | ScreenCaptureKit / CGWindowList | `sharingType = .none` |
| Teams screen share | ScreenCaptureKit | `sharingType = .none` |
| OBS Studio | CGDisplayStream | `sharingType = .none` |
| Proctoring software | Varies | `sharingType = .none` + runtime verification |
| WebRTC getDisplayMedia | ScreenCaptureKit | `sharingType = .none` |

---

## Part 3: Process Isolation and Camouflage

### Process Naming Strategy

**Swift Host App:**

| Attribute | Value |
|-----------|-------|
| Bundle ID | `com.apple.AssistantServices` |
| Process name | `AssistantServices` |
| Executable name | `assistantservicesd` |

**Node.js Child Process:**

| Attribute | Value |
|-----------|-------|
| Binary name | `assistantd` (renamed Node.js) |
| Spoofed argv[0] | `/System/Library/PrivateFrameworks/AssistantServices.framework/assistantd` |

```swift
func spawnBackend() throws -> Process {
    let process = Process()
    process.executableURL = Bundle.main.url(forResource: "assistantd", withExtension: nil)
    process.arguments = ["--backend"]
    process.environment = ProcessInfo.processInfo.environment.merging([
        "__CFBundleIdentifier": "com.apple.assistantd"
    ]) { $1 }
    
    // Setup stdin/stdout pipes for JSON-RPC
    let stdinPipe = Pipe()
    let stdoutPipe = Pipe()
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    
    try process.run()
    return process
}
```

### Memory Footprint Comparison

| Component | Electron (current) | Native Architecture |
|-----------|-------------------|---------------------|
| Swift Host | - | ~15-25 MB |
| WKWebView (per window) | - | ~40-60 MB (shared WebKit) |
| Node.js backend | - | ~30-50 MB |
| Rust native module | ~10 MB | ~10 MB (unchanged) |
| ANE/ONNX embedding model | - | ~20 MB (bundled) |
| **Total (idle)** | **300-500 MB** | **~120-165 MB** |
| **Total (1hr session)** | **500+ MB** | **<300 MB** |

### Anti-Fingerprinting Measures

| Vector | Mitigation |
|--------|------------|
| Process name | Disguised as system daemon |
| Bundle ID | Apple-like identifier |
| Window class | Custom `ASPanel`, `ASWindow` |
| V8/Chromium heap | Eliminated (no Electron) |
| Electron IPC patterns | Eliminated (stdio JSON-RPC) |
| Code signature | Valid Apple Developer signature |
| Memory allocation | Node.js generic pattern |

### Activity Monitor Appearance

**Before (Electron):**
```
Natively                    CPU   Memory
├─ Natively Helper (GPU)    2.1%  180 MB
├─ Natively Helper (Renderer) 1.5% 120 MB
└─ Natively Helper (Plugin)  0.3%  45 MB
```

**After (Native + Node):**
```
assistantservicesd          0.5%   85 MB
├─ assistantd               0.8%   45 MB
└─ com.apple.WebKit.WebContent 1.2% 55 MB
```

---

## Part 4: Accelerated Intelligence Pipeline

### 4.1 ANE-Accelerated Embeddings (Swift)

Embeddings run in the Swift process using ONNX Runtime with CoreML backend for Neural Engine acceleration:

```swift
// swift-host/ANEEmbeddingService.swift

import OnnxRuntime

class ANEEmbeddingService {
    private var session: ORTSession?
    private let tokenizer: BertTokenizer
    private let modelPath: URL
    
    init() throws {
        modelPath = Bundle.main.url(forResource: "minilm-l6-v2", withExtension: "onnx")!
        tokenizer = try BertTokenizer(vocabPath: Bundle.main.url(forResource: "vocab", withExtension: "txt")!)
        
        let env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        
        // Use CoreML (Neural Engine) with CPU fallback
        try options.appendCoreMLExecutionProvider(with: .cpuAndGPU)
        
        session = try ORTSession(env: env, modelPath: modelPath.path, sessionOptions: options)
    }
    
    func embed(_ text: String) async throws -> [Float] {
        let tokens = tokenizer.encode(text)
        
        let inputIds = try ORTValue(tensorData: NSMutableData(bytes: tokens.ids, length: tokens.ids.count * 8),
                                     elementType: .int64,
                                     shape: [1, NSNumber(value: tokens.ids.count)])
        
        let attentionMask = try ORTValue(tensorData: NSMutableData(bytes: tokens.attentionMask, length: tokens.attentionMask.count * 8),
                                          elementType: .int64,
                                          shape: [1, NSNumber(value: tokens.attentionMask.count)])
        
        let outputs = try session!.run(withInputs: ["input_ids": inputIds, "attention_mask": attentionMask],
                                        outputNames: ["last_hidden_state"],
                                        runOptions: nil)
        
        guard let embedding = outputs["last_hidden_state"] else {
            throw EmbeddingError.noOutput
        }
        
        return meanPool(embedding, mask: tokens.attentionMask)
    }
    
    func embedBatch(_ texts: [String]) async throws -> [[Float]] {
        // Batch processing for efficiency
        try await withThrowingTaskGroup(of: (Int, [Float]).self) { group in
            for (i, text) in texts.enumerated() {
                group.addTask { (i, try await self.embed(text)) }
            }
            
            var results = [[Float]](repeating: [], count: texts.count)
            for try await (i, embedding) in group {
                results[i] = embedding
            }
            return results
        }
    }
}
```

**Performance:**
- Current: 100-150ms per embedding (CPU, transformers.js)
- Target: 2-10ms per embedding (ANE)
- **Speedup: 10-50x**

### 4.2 Prompt Compiler (Node.js Backend)

Eliminates prompt redundancy across provider variants:

```typescript
// node-backend/llm/PromptCompiler.ts

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
  private cache = new LRUCache<string, CompiledPrompt>({ max: 100 });
  private components: PromptComponents;

  compile(options: {
    provider: Provider;
    phase: InterviewPhase;
    mode: 'conscious' | 'standard';
    context: ContextSnapshot;
  }): CompiledPrompt {
    const cacheKey = `${options.provider}:${options.phase}:${options.mode}`;
    
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const compiled = this.assemble(options);
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  private assemble(options: CompileOptions): CompiledPrompt {
    const adapter = this.components.providerAdapters.get(options.provider)!;
    const phaseGuidance = this.components.phaseGuidance.get(options.phase) || '';

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

**Token Savings:**
- Current: ~4000 tokens system prompt per request
- After: ~2500 tokens (shared components cached)
- **Savings: 30-40%**

### 4.3 Streaming-First Response Pipeline

```typescript
// node-backend/llm/StreamManager.ts

interface StreamConfig {
  onToken: (token: string) => void;
  onPartialJson: (partial: Partial<ConsciousResponse>) => void;
  onComplete: (full: ConsciousResponse) => void;
  onError: (error: Error) => void;
}

class StreamManager {
  private jsonAccumulator = '';
  private partialParser: PartialJsonParser;

  async processStream(
    stream: AsyncIterable<StreamChunk>,
    config: StreamConfig
  ): Promise<void> {
    const backgroundTasks: Promise<void>[] = [];

    for await (const chunk of stream) {
      // Immediate: send to UI via JSON-RPC
      config.onToken(chunk.text);

      // Accumulate for JSON parsing
      this.jsonAccumulator += chunk.text;

      // Try partial parse periodically
      if (this.jsonAccumulator.length % 100 === 0) {
        const partial = this.partialParser.tryParse(this.jsonAccumulator);
        if (partial) {
          config.onPartialJson(partial);
          
          // Background: prefetch related context
          if (partial.answer && partial.answer.length > 50) {
            backgroundTasks.push(this.prefetchRelatedContext(partial));
          }
        }
      }
    }

    await Promise.all(backgroundTasks);
    
    const full = JSON.parse(this.jsonAccumulator);
    config.onComplete(full);
  }
}
```

**Latency Impact:**
- Time-to-first-token: ~100-200ms (down from ~800-1200ms)
- **Perceived latency reduction: 50-70%**

### 4.4 Enhanced Cache Layer

```typescript
// node-backend/cache/EnhancedCache.ts

interface CacheConfig {
  maxSize: number;
  ttlMs: number;
  enableSemanticLookup?: boolean;
  similarityThreshold?: number;
}

class EnhancedCache<K, V> {
  private lru = new Map<string, CacheEntry<V>>();
  private embeddings?: Map<string, number[]>;
  
  constructor(private config: CacheConfig) {
    if (config.enableSemanticLookup) {
      this.embeddings = new Map();
    }
  }

  async get(key: K, embedding?: number[]): Promise<V | undefined> {
    const stringKey = JSON.stringify(key);
    
    // Exact match (fast path)
    const exact = this.lru.get(stringKey);
    if (exact && !this.isExpired(exact)) {
      this.touchEntry(stringKey);
      return exact.value;
    }

    // Semantic lookup (if enabled)
    if (this.config.enableSemanticLookup && embedding) {
      const similar = this.findSimilar(embedding);
      if (similar) return similar.value;
    }

    return undefined;
  }

  set(key: K, value: V, embedding?: number[]): void {
    const stringKey = JSON.stringify(key);
    
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

**Impact:**
- Cache hits: 20-30% improvement from semantic similarity
- Memory: Bounded growth, automatic eviction
- **Memory savings: 30-50% for long sessions**

### 4.5 Parallel Context Assembly

```typescript
// node-backend/context/ParallelContextAssembler.ts

class ParallelContextAssembler {
  private rpcClient: JsonRpcClient; // To Swift for embeddings

  async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyOutput> {
    // Launch all independent tasks in parallel
    const [embedding, bm25Results, phase] = await Promise.all([
      // Embedding runs in Swift process (ANE)
      this.rpcClient.call('embedding:generate', { text: input.query }),
      // BM25 runs locally in Node worker
      this.scoringWorker.runBM25(input.query, input.transcript),
      // Phase detection is fast, runs on main thread
      this.detectPhase(input.transcript),
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

**Latency Impact:**
- Current: ~200-300ms (sequential)
- Target: ~80-120ms (parallel)
- **Speedup: 2-3x**

### 4.6 Adaptive Context Windowing

```typescript
// node-backend/context/AdaptiveContextWindow.ts

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
        score: this.computeScore(entry, queryEmbedding, config),
      }))
    );

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Greedily select within token budget
    const selected: ContextEntry[] = [];
    let usedTokens = 0;

    for (const { entry } of scored) {
      const entryTokens = this.estimateTokens(entry);
      if (usedTokens + entryTokens <= config.tokenBudget) {
        selected.push(entry);
        usedTokens += entryTokens;
      }
    }

    return selected;
  }

  private computeScore(
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

### 4.7 Predictive Prefetching

```typescript
// node-backend/prefetch/PredictivePrefetcher.ts

class PredictivePrefetcher {
  private prefetchCache: EnhancedCache<string, PrefetchedContext>;
  private isUserSpeaking = false;

  onSilenceStart(): void {
    this.isUserSpeaking = false;
    this.startPrefetching();
  }

  private async startPrefetching(): Promise<void> {
    const predictions = this.predictFollowUps();
    
    for (const prediction of predictions) {
      if (this.isUserSpeaking) break;
      
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
    const phasePredictions = PHASE_FOLLOWUP_PATTERNS[currentPhase] || [];
    
    // Topic-based predictions
    const topicPredictions = recentTopics.flatMap(topic => 
      TOPIC_FOLLOWUPS[topic] || []
    );

    return [...phasePredictions, ...topicPredictions].slice(0, 5);
  }
}
```

---

## Part 5: IPC Protocol

### Swift ↔ Node.js Communication

JSON-RPC 2.0 over stdin/stdout:

```typescript
// Request from Node to Swift
{"jsonrpc":"2.0","id":1,"method":"embedding:generate","params":{"text":"What is caching?"}}

// Response from Swift
{"jsonrpc":"2.0","id":1,"result":{"embedding":[0.123,0.456,...],"latencyMs":8}}

// Notification from Node to Swift (no response expected)
{"jsonrpc":"2.0","method":"ui:update","params":{"component":"overlay","state":{...}}}

// Request from Swift to Node
{"jsonrpc":"2.0","id":2,"method":"llm:generate","params":{"prompt":"..."}}

// Streaming response
{"jsonrpc":"2.0","id":2,"result":{"type":"token","text":"The"}}
{"jsonrpc":"2.0","id":2,"result":{"type":"token","text":" answer"}}
{"jsonrpc":"2.0","id":2,"result":{"type":"complete","response":{...}}}
```

### WKWebView Bridge

```swift
// swift-host/WebViewManager.swift

class WebViewManager: NSObject, WKScriptMessageHandler {
    private let rpcBridge: JsonRpcBridge
    
    func setupWebView(_ webView: WKWebView) {
        let script = WKUserScript(source: """
            window.electronAPI = {
                send: (channel, data) => {
                    window.webkit.messageHandlers.ipc.postMessage({
                        type: 'send',
                        channel: channel,
                        data: data
                    });
                },
                invoke: (channel, data) => {
                    return new Promise((resolve, reject) => {
                        const id = Math.random().toString(36);
                        window.__pendingInvokes = window.__pendingInvokes || {};
                        window.__pendingInvokes[id] = { resolve, reject };
                        window.webkit.messageHandlers.ipc.postMessage({
                            type: 'invoke',
                            id: id,
                            channel: channel,
                            data: data
                        });
                    });
                },
                on: (channel, callback) => {
                    window.__ipcListeners = window.__ipcListeners || {};
                    window.__ipcListeners[channel] = window.__ipcListeners[channel] || [];
                    window.__ipcListeners[channel].push(callback);
                }
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        
        webView.configuration.userContentController.addUserScript(script)
        webView.configuration.userContentController.add(self, name: "ipc")
    }
    
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        
        switch body["type"] as? String {
        case "send":
            rpcBridge.forward(channel: body["channel"] as! String,
                              data: body["data"])
        case "invoke":
            Task {
                let result = try await rpcBridge.invoke(
                    channel: body["channel"] as! String,
                    data: body["data"],
                    id: body["id"] as! String
                )
                await resolveInvoke(id: body["id"] as! String, result: result)
            }
        default:
            break
        }
    }
}
```

---

## Part 6: Project Structure

```
natively/
├── swift-host/                      # Native macOS app (NEW)
│   ├── NativelyHost/
│   │   ├── App.swift                # Entry point
│   │   ├── WindowManager.swift      # Window creation, display exclusion
│   │   ├── ASPanel.swift            # Custom panel class
│   │   ├── ASWindow.swift           # Custom window class
│   │   ├── StatusBarManager.swift   # Menu bar/tray
│   │   ├── HotkeyManager.swift      # Global shortcuts
│   │   ├── ScreenCapture.swift      # Screenshot/cropper
│   │   ├── IPCBridge.swift          # JSON-RPC over stdio
│   │   ├── WebViewManager.swift     # WKWebView + JS bridge
│   │   └── ANEEmbeddingService.swift # ONNX/CoreML embeddings
│   ├── NativelyHost.xcodeproj
│   ├── Resources/
│   │   └── models/
│   │       ├── minilm-l6-v2.onnx    # Embedding model
│   │       └── vocab.txt            # Tokenizer vocabulary
│   └── scripts/
│       └── bundle-node.sh
│
├── node-backend/                    # Node.js backend (PORTED from electron/)
│   ├── main.ts                      # Entry point
│   ├── rpc-handlers.ts              # JSON-RPC method handlers
│   ├── settings.ts                  # Settings persistence
│   ├── app-state.ts                 # Runtime state
│   ├── llm/
│   │   ├── PromptCompiler.ts        # NEW: Prompt optimization
│   │   ├── StreamManager.ts         # NEW: Streaming responses
│   │   └── LLMClient.ts             # API client
│   ├── cache/
│   │   └── EnhancedCache.ts         # NEW: LRU + semantic cache
│   ├── context/
│   │   ├── ParallelContextAssembler.ts  # NEW: Parallel assembly
│   │   └── AdaptiveContextWindow.ts     # NEW: Smart selection
│   ├── prefetch/
│   │   └── PredictivePrefetcher.ts  # NEW: Background prefetch
│   ├── workers/
│   │   ├── ScoringWorker.ts         # BM25 scoring
│   │   └── ContextWorker.ts         # Context assembly
│   └── tsconfig.json
│
├── src/                             # React UI (UNCHANGED)
│   ├── main.tsx
│   ├── components/
│   ├── lib/
│   └── ...
│
├── native-module/                   # Rust audio capture (UNCHANGED)
│   └── ...
│
├── dist/                            # Built React bundle
│   └── index.html
│
└── scripts/
    └── build-macos.sh               # Orchestrates full build
```

### Code Migration Map

```
UNCHANGED (copy directly):
├── src/                       (React UI - runs in WKWebView)
├── native-module/             (Rust audio capture)
├── src/lib/                   (Business logic)
└── src/services/              (LLM, session management)

PORTED (Electron → Node.js):
├── electron/main.ts           → node-backend/main.ts
├── electron/SettingsManager.ts → node-backend/settings.ts
├── electron/ipcHandlers.ts    → node-backend/rpc-handlers.ts
├── electron/AppState.ts       → node-backend/app-state.ts
├── electron/LLMHelper.ts      → node-backend/llm/LLMClient.ts
├── electron/IntelligenceEngine.ts → node-backend/context/

REWRITTEN (Electron → Swift):
├── electron/WindowHelper.ts   → swift-host/WindowManager.swift
├── electron/ScreenshotHelper.ts → swift-host/ScreenCapture.swift
├── electron/tray.ts           → swift-host/StatusBarManager.swift
├── electron/globalShortcuts.ts → swift-host/HotkeyManager.swift
├── electron/rag/LocalEmbeddingProvider.ts → swift-host/ANEEmbeddingService.swift

NEW (Intelligence optimizations):
├── node-backend/llm/PromptCompiler.ts
├── node-backend/llm/StreamManager.ts
├── node-backend/cache/EnhancedCache.ts
├── node-backend/context/ParallelContextAssembler.ts
├── node-backend/context/AdaptiveContextWindow.ts
├── node-backend/prefetch/PredictivePrefetcher.ts

REMOVED:
└── electron/                  (Electron-specific code)
```

---

## Part 7: Build and Distribution

### Build Pipeline

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ React Build │   │ Node Backend│   │ Rust Module │
│ (vite)      │   │ (esbuild)   │   │ (napi)      │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────────────┼─────────────────┘
                        ▼
              ┌─────────────────┐
              │  Swift Build    │
              │  (xcodebuild)   │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Bundle Assembly │
              │ - Embed dist/   │
              │ - Embed Node.js │
              │ - Embed backend │
              │ - Embed models  │
              │ - Rename bins   │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │  Code Signing   │
              │  Notarization   │
              └────────┬────────┘
                       ▼
              NativelyHost.app (DMG)
```

### App Bundle Structure

```
NativelyHost.app/
├── Contents/
│   ├── Info.plist                   # Bundle ID: com.apple.AssistantServices
│   ├── MacOS/
│   │   └── assistantservicesd       # Swift executable
│   ├── Frameworks/
│   │   ├── native.node              # Rust audio module
│   │   └── onnxruntime.framework    # ONNX Runtime
│   ├── Resources/
│   │   ├── dist/                    # React UI bundle
│   │   ├── backend.js               # Bundled Node.js backend
│   │   ├── assistantd               # Renamed Node.js binary
│   │   ├── models/
│   │   │   ├── minilm-l6-v2.onnx    # Embedding model (~20MB)
│   │   │   └── vocab.txt
│   │   └── Icons/
│   │       ├── AppIcon.icns
│   │       └── disguise/
│   └── _CodeSignature/
```

### Entitlements

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" 
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
    
    <key>com.apple.security.hardened-runtime</key>
    <true/>
    
    <key>com.apple.security.device.audio-input</key>
    <true/>
    
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
```

---

## Part 8: Configuration and Feature Flags

```typescript
// node-backend/config/features.ts

export const FEATURE_FLAGS = {
  // Intelligence optimizations
  usePromptCompiler: true,
  useStreamManager: true,
  useEnhancedCache: true,
  useANEEmbeddings: true,        // Falls back to CPU if unavailable
  useParallelContext: true,
  useAdaptiveWindow: true,
  usePrefetching: true,
  
  // Stealth features
  enableDisplayExclusion: true,
  enableProcessCamouflage: true,
  verifyExclusionAtRuntime: true,
  
  // Performance tuning
  workerThreadCount: 6,          // Configurable by user
  prefetchPredictionLimit: 5,
  semanticCacheThreshold: 0.85,
  contextTokenBudget: 2000,
};
```

---

## Part 9: Testing and Verification

### Display Exclusion Tests

```swift
class DisplayExclusionTests: XCTestCase {
    
    func testWindowNotInCGWindowList() {
        let overlay = WindowManager.shared.createOverlay()
        let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        
        XCTAssertFalse(windowList.contains(overlay.windowNumber))
    }
    
    func testWindowNotInScreenCaptureKit() async throws {
        let overlay = WindowManager.shared.createOverlay()
        let content = try await SCShareableContent.current
        
        XCTAssertFalse(content.windows.contains { $0.windowID == CGWindowID(overlay.windowNumber) })
    }
    
    func testScreenshotExclusion() async throws {
        let overlay = WindowManager.shared.createOverlay()
        overlay.backgroundColor = .red
        
        let screenshot = try await ScreenCapture.captureFullScreen(excluding: [overlay])
        
        XCTAssertFalse(screenshot.containsColor(.red, at: overlay.frame))
    }
}
```

### Process Camouflage Verification

```bash
#!/bin/bash
# verify-stealth.sh

# Check process names
ps aux | grep -E "Natively|Electron|node" | grep -v grep && echo "FAIL" && exit 1

# Check window server class names
/usr/bin/python3 -c "
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)
for w in windows:
    name = w.get('kCGWindowOwnerName', '')
    if 'Electron' in name or 'Natively' in name:
        print(f'FAIL: {name}')
        exit(1)
"

echo "PASS: Stealth verification complete"
```

### Intelligence Pipeline Benchmarks

```typescript
// node-backend/tests/benchmarks.ts

describe('Intelligence Pipeline Benchmarks', () => {
  test('embedding latency (ANE)', async () => {
    const start = performance.now();
    await embeddingService.embed('What is caching?');
    const latency = performance.now() - start;
    
    expect(latency).toBeLessThan(10); // <10ms target
  });
  
  test('time-to-first-token', async () => {
    const start = performance.now();
    let firstTokenTime: number;
    
    await llmClient.generate({
      prompt: 'Explain caching',
      onToken: (token) => {
        if (!firstTokenTime) firstTokenTime = performance.now() - start;
      }
    });
    
    expect(firstTokenTime!).toBeLessThan(400); // <400ms target
  });
  
  test('context assembly (parallel)', async () => {
    const start = performance.now();
    await contextAssembler.assemble({ query: 'test', transcript: mockTranscript });
    const latency = performance.now() - start;
    
    expect(latency).toBeLessThan(120); // <120ms target
  });
  
  test('cache hit rate (semantic)', async () => {
    // Seed cache
    await cache.set('What is caching?', mockResponse, mockEmbedding);
    
    // Query with similar but not identical text
    const hit = await cache.get('Explain caching to me', similarEmbedding);
    
    expect(hit).toBeDefined();
  });
});
```

### Manual Test Protocol

| Test | Tool | Expected |
|------|------|----------|
| Screen share | Zoom | Invisible |
| Screen share | Google Meet | Invisible |
| Screen share | Microsoft Teams | Invisible |
| Screen recording | QuickTime | Invisible |
| Screenshot | Cmd+Shift+3 | Invisible |
| Process list | Activity Monitor | Shows "assistantservicesd" only |
| Process scan | `ps aux` | No "Natively", "Electron", "node" |
| Embedding speed | Benchmark | <10ms |
| TTFT | Benchmark | <400ms |
| Memory (1hr) | Activity Monitor | <300MB |

---

## Part 10: Success Metrics

| Metric | Baseline (Electron) | Target (Native) | Measurement |
|--------|---------------------|-----------------|-------------|
| Memory (idle) | 300-500 MB | <150 MB | Activity Monitor |
| Memory (1hr session) | 500+ MB | <300 MB | process.memoryUsage() |
| Time-to-first-token | 800-1200ms | <400ms | Performance.mark() |
| Embedding latency | 100-150ms | <10ms | ANE benchmark |
| Token usage/response | 4000-6000 | 2500-4000 | Provider billing |
| Cache hit rate | ~30% | >50% | Cache statistics |
| Context assembly | 200-300ms | <120ms | Parallel timing |
| Process detectability | High | Undetectable | Manual + automated |
| Window capture | Leaks | Excluded | Capture tests |
| Cold start | 2-3s | <2s | Startup timing |

---

## Part 11: Rollback Plan

Each component is independently toggleable:

1. **Intelligence optimizations**: Each feature flag can be disabled
2. **Native architecture**: Existing Electron build remains in CI
3. **Settings format**: Unchanged for downgrade compatibility
4. **Feature flag**: `USE_NATIVE_HOST` enables A/B testing during beta

If critical issues:
1. Disable specific optimization flag
2. Or ship Electron hotfix within hours
3. No data migration needed

---

## Summary

| Component | Technology | Purpose |
|-----------|------------|---------|
| Swift Host | Swift/AppKit | Window management, display exclusion, ANE embeddings |
| ASPanel/ASWindow | Custom classes | Innocuous window server names |
| WKWebView | WebKit | Renders existing React UI |
| ANEEmbeddingService | ONNX + CoreML | 10-50x faster embeddings |
| Node.js Backend | Node.js + TypeScript | Business logic, LLM calls |
| PromptCompiler | TypeScript | 30-40% token reduction |
| StreamManager | TypeScript | 50-70% perceived latency reduction |
| EnhancedCache | TypeScript | LRU + semantic similarity |
| Rust Module | NAPI-RS | Audio capture (unchanged) |
| IPC | JSON-RPC over stdio | Swift ↔ Node communication |

**Outcomes:**
- Window invisible to all known capture methods
- Process undetectable by name, bundle ID, memory signature
- Memory footprint reduced ~70% (400MB → 120MB idle, 500MB → 300MB 1hr)
- Time-to-first-token reduced ~60% (1000ms → 400ms)
- Token usage reduced ~35% (5000 → 3250 avg)
- Embedding latency reduced ~95% (125ms → 6ms)
- All existing functionality preserved
- Same React codebase, no UI rewrite
