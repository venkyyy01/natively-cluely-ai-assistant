# Natively Codebase Review Report

**Review Date:** March 2026  
**Reviewer Level:** Principal Engineer  
**Codebase Version:** Natively - AI Meeting Notes Assistant

---

## Executive Summary

Natively is an Electron-based AI meeting assistant providing real-time transcription, AI-powered suggestions, and interview copilot features through transparent overlay windows. The architecture spans a React frontend, Electron main process, Rust native audio module, and a SQLite-based RAG system.

**Overall Assessment:** The application demonstrates sophisticated technical implementation with significant architectural issues that pose risks to maintainability, security, and performance at scale.

**Critical Numbers:**
- ~2,800 lines in main Electron entry
- ~79KB IPC handlers file (~2,500+ lines)
- ~2,800 lines in SettingsOverlay React component
- ~105KB LLMHelper orchestration module
- ~0% test coverage
- 1 smoke test that checks for "learn react" text

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Critical Issues (Must Fix)](#2-critical-issues-must-fix)
3. [High Priority Issues](#3-high-priority-issues)
4. [Medium Priority Issues](#4-medium-priority-issues)
5. [Frontend React Issues](#5-frontend-react-issues)
6. [Backend/Electron Issues](#6-backendelectron-issues)
7. [Native Module Issues](#7-native-module-issues)
8. [RAG System Issues](#8-rag-system-issues)
9. [Security Concerns](#9-security-concerns)
10. [Build & Infrastructure Issues](#10-build--infrastructure-issues)
11. [Recommended Optimization Patterns](#11-recommended-optimization-patterns)
12. [Priority Roadmap](#12-priority-roadmap)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                        │
├─────────────────────────────────────────────────────────────────┤
│  Window Management (transparent overlay, launcher)               │
│  ├── IntelligenceEngine - AI orchestration                     │
│  ├── RAGManager - Vector search & retrieval                     │
│  ├── DatabaseManager - SQLite + sqlite-vec                      │
│  ├── CredentialsManager - Secure API key storage                │
│  ├── SettingsManager - App settings                             │
│  └── KeybindManager - Global shortcuts                           │
├─────────────────────────────────────────────────────────────────┤
│  Audio Pipeline                                                  │
│  ├── Native Audio (Rust NAPI) - System/mic capture               │
│  ├── STT Providers - Multiple speech-to-text backends          │
│  └── Rolling Transcript - Context window builder                │
├─────────────────────────────────────────────────────────────────┤
│  LLM Integration                                                 │
│  ├── LLMHelper - Multi-provider LLM orchestration (~105KB)     │
│  ├── IntentClassifier - Classifies user queries                 │
│  └── Prompt Templates - Specialized prompts (~50KB)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                    IPC (contextBridge ~100+ methods)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                   React Frontend (Renderer)                      │
├─────────────────────────────────────────────────────────────────┤
│  ├── NativelyInterface (~90KB) - Main overlay UI               │
│  ├── SettingsOverlay (~200KB) - Settings panel                  │
│  ├── Launcher - Dashboard                                       │
│  └── ErrorBoundary - Per-window error handling                  │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18.3.1, Vite 5.4.11, Tailwind CSS, Framer Motion |
| State | React Query 3.39.3 (per-window isolated instances) |
| Electron | 33.2.0, TypeScript 5.6.3 |
| Database | better-sqlite3 12.6.2, sqlite-vec |
| Native | Rust NAPI (napi-rs), cpal, rubato |
| LLM | OpenAI, Anthropic Claude, Google Gemini, Groq, Ollama |
| STT | Deepgram, ElevenLabs, Google Speech, OpenAI, Azure, IBM, Soniox |
| ML | @xenova/transformers (local embeddings) |

---

## 2. Critical Issues (Must Fix)

### 2.1 Resampler Buffer Memory Leak (Native Module)

**File:** `/native-module/src/resampler.rs:37-76`

```rust
pub fn resample(&mut self, input_data: &[f32]) -> Result<Vec<i16>> {
    self.input_buffer[0].extend_from_slice(input_data);  // grows unbounded!

    while self.input_buffer[0].len() >= frames_needed {
        let chunk: Vec<f32> = self.input_buffer[0].drain(0..frames_needed).collect();
        // ...
    }
    // BUG: If resample() called infrequently, input_buffer grows indefinitely
}
```

**Impact:** Memory exhaustion during sustained audio capture. If `resample()` isn't called frequently enough to drain the buffer, `input_buffer` accumulates indefinitely.

**Fix Required:**
- Add bounds checking to prevent unbounded growth
- Implement a maximum buffer size with overflow handling

---

### 2.2 IPC Handler Input Validation Failure

**File:** `/electron/ipcHandlers.ts`

```typescript
safeHandle("generate-followup-email", async (_, input: any) => {...})
safeHandle("save-custom-provider", async (_, provider: any) => {...})
safeHandle("gemini-chat", async (event, message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => {...})
```

**Impact:** Malicious renderer could send malformed data causing crashes, memory leaks, or exploitation of downstream services. 100+ IPC methods accept unvalidated `any` types.

**Fix Required:**
- Implement Zod/Joi validation for all IPC inputs
- Create typed IPC channel definitions

---

### 2.3 OAuth Redirect URI Security

**File:** `/electron/services/CalendarManager.ts:11-13, 64`

```typescript
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_CLIENT_ID_HERE";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "YOUR_CLIENT_SECRET_HERE";
const REDIRECT_URI = "http://localhost:11111/auth/callback";  // HTTP!
```

**Issues:**
- `localhost:11111` is unencrypted HTTP - vulnerable to DNS rebinding
- No CSRF protection (missing `state` parameter)
- Default placeholder credentials checked at runtime

**Fix Required:**
- Use `https://localhost` with self-signed certificate
- Implement OAuth state parameter for CSRF protection

---

### 2.4 macOS Entitlements Allow Code Injection

**File:** `entitlements.mac.plist`

```xml
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

**Impact:** Combined with `hardenedRuntime: false`, allows unsigned code execution and memory injection.

**Fix Required:**
- Remove dangerous entitlements or narrow scope
- Enable hardened runtime
- Consider notarization for macOS distribution

---

### 2.5 Stream With Gemini Parallel Race Breaks Streaming Contract

**File:** `/electron/llm/LLMHelper.ts:2059-2075`

```typescript
private async * streamWithGeminiParallelRace(fullMessage: string, imagePaths?: string[]): AsyncGenerator<string, void, unknown> {
    const flashPromise = this.collectStreamResponse(fullMessage, GEMINI_FLASH_MODEL, imagePaths);
    const proPromise = this.collectStreamResponse(fullMessage, GEMINI_PRO_MODEL, imagePaths);

    const result = await Promise.any([flashPromise, proPromise]);  // Waits for ALL

    // Then yields character by character - NOT actually streaming
    const chunkSize = 10;
    for (let i = 0; i < result.length; i += chunkSize) {
        yield result.substring(i, i + chunkSize);
    }
}
```

**Impact:** Increases latency (waits for slower model), defeats streaming UX (no real-time output), misleading method naming.

**Fix Required:**
- Implement true streaming with first-token-first-output
- Consider AbortController for cancellation

---

## 3. High Priority Issues

### 3.1 SettingsOverlay Re-render at 60fps

**File:** `/src/components/settings/SettingsOverlay.tsx:1103-1135`

```typescript
const updateLevel = () => {
    setMicLevel(smoothLevel);  // Triggers re-render ~60 times/second!
    rafRef.current = requestAnimationFrame(updateLevel);
};
```

**Impact:** Entire 2,800-line component re-renders 60 times/second when Audio tab is open.

**Additional Issues in Same File:**
- Zero `useCallback` hooks
- Zero `useMemo` hooks
- Zero `React.memo` components
- 50+ `useState` hooks

**Fix Required:**
- Extract mic level monitoring to isolated component with `useRef` for animation state
- Batch state updates or use `startTransition`

---

### 3.2 No Context Window/Token Management

**File:** `/electron/llm/LLMHelper.ts`

```typescript
MAX_OUTPUT_TOKENS = 65536  // Exceeds many models' limits
// No input token counting before sending
// No truncation of combined prompt + context
```

**Impact:** API errors when prompt exceeds context window. No prevention - only post-check handling.

**Fix Required:**
- Implement token counting before API calls
- Add prompt truncation with semantic awareness
- Validate `MAX_OUTPUT_TOKENS` against model limits

---

### 3.3 Inconsistent Retry Logic

**File:** `/electron/llm/LLMHelper.ts`

| Method | Retry | Notes |
|--------|-------|-------|
| `generateContent()` (line 432) | 503 only | Very limited |
| `generateContentStructured()` (line 927) | **NONE** | Single attempt only |
| `streamChatWithGemini()` (line 1551) | Partial | Mid-stream throws, no recovery |

**Impact:** Some failure paths have no retry, others have inconsistent backoff.

**Fix Required:**
- Standardize retry mechanism with configurable backoff
- Add retry to `generateContentStructured()`
- Implement stream recovery with provider fallback

---

### 3.4 Semantic Chunking Disregards Semantic Coherence

**File:** `/electron/rag/SemanticChunker.ts:87-142`

```typescript
const shouldSplit =
    (currentChunk.length > 0 && seg.speaker !== currentChunk[0].speaker) ||
    (currentTokens + segTokens > MAX_TOKENS && currentTokens >= MIN_TOKENS);
```

**Impact:** Chunking ignores semantic boundaries (topic transitions, mid-sentence splits). Embeddings capture half-thoughts, degrading RAG quality.

**Fix Required:**
- Add sentence boundary detection
- Implement topic transition detection
- Consider paragraph/section boundaries

---

### 3.5 Premium License Manager is No-Op

**File:** `/premium/electron/services/LicenseManager.ts`

```typescript
public activateLicense(_key: string): { success: boolean; error?: string } {
    this.premiumEnabled = true;  // Always succeeds
    return { success: true };
}
```

**Impact:** Premium features permanently unlocked. Business logic relying on license checks is bypassed.

**Fix Required:**
- Implement actual license verification
- Or remove fake implementation entirely

---

## 4. Medium Priority Issues

### 4.1 VAD Decimation Array Index Bug

**File:** `/native-module/src/silence_suppression.rs:242-281`

```rust
while (pos as usize) < frame.len() {
    self.vad_buf.push(frame[pos as usize]);  // BUG: truncates float to usize!
    pos += factor;
}
```

**Impact:** On 44.1kHz devices (MacBooks), `factor ≈ 2.75625` causes wrong sample indices (0, 2, 5, 8 instead of 0, 2, 5, 8... with rounding errors). VAD receives corrupted input.

**Fix Required:**
```rust
while (pos as usize) < frame.len() {
    self.vad_buf.push(frame[pos as usize]);
    pos += factor;
}
// Should be: frame[(pos.round() as usize)] for proper decimation
```

---

### 4.2 Per-Frame Allocation in Audio Path

**File:** `/native-module/src/lib.rs:168-198`

```rust
match action {
    FrameAction::Send(data) => {
        let bytes = i16_slice_to_le_bytes(&data);  // allocates Vec<u8>
        tsfn.call(Buffer::from(bytes), ...);  // another allocation
    }
    FrameAction::SendSilence => {
        let silence = vec![0u8; chunk_size * 2];  // allocates every 100ms!
    }
}
```

**Impact:** At 48kHz with 20ms frames = 50 allocations/second per audio source. GC pressure may cause audio glitches.

**Fix Required:**
- Pre-allocate reusable buffers
- Use arena/池化 allocation patterns

---

### 4.3 LiveRAGIndexer No Rate Limiting

**File:** `/electron/rag/LiveRAGIndexer.ts:122-139`

```typescript
// 5. Embed each chunk (fire-and-forget per chunk, but sequential to avoid rate limits)
if (this.embeddingPipeline.isReady()) {
    for (let i = 0; i < chunkIds.length; i++) {
        const embedding = await this.embeddingPipeline.getEmbedding(indexedChunks[i].text);
        // No actual rate limiting between iterations
    }
}
```

**Impact:** Claims "sequential to avoid rate limits" but does sequential API calls without delays. Will hit rate limits on dense chunks.

**Fix Required:**
- Add actual rate limiting (token bucket or delay)
- Consider batching embeddings

---

### 4.4 Screenshot Queue Race Condition

**File:** `/electron/services/ScreenshotHelper.ts:109-166`

```typescript
if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
    const removedPath = this.screenshotQueue.shift()  // Race here
```

**Impact:** Plain arrays with no thread safety. `fs.unlink` errors swallowed. No file size limits.

**Fix Required:**
- Use thread-safe queue data structure
- Add file size limits
- Handle deletion errors properly

---

### 4.5 Groq Rate Limiter Too Conservative

**File:** `/electron/llm/RateLimiter.ts`

```typescript
this.limits.set('groq', { tokens: 60, requestsPerMinute: 6 });
```

**Impact:** 6 req/min for Groq is extremely conservative. Under normal streaming usage, users exhaust this in seconds, causing very long queue waits.

**Fix Required:**
- Increase Groq limit or make configurable
- Implement adaptive rate limiting

---

### 4.6 Database Migration Atomicity Issue

**File:** `/electron/db/DatabaseManager.ts` (Migration v10)

```typescript
const migrate = this.db.transaction(() => {
    this.db!.exec('ALTER TABLE embedding_queue RENAME TO embedding_queue_old;');
    // If crash HERE, embedding_queue is gone, embedding_queue_old exists
    this.db!.exec('CREATE TABLE embedding_queue (...)');
    this.db!.exec('INSERT OR IGNORE INTO embedding_queue SELECT ...');
    this.db!.exec('DROP TABLE embedding_queue_old;');
});
```

**Impact:** Power failure mid-migration could corrupt `embedding_queue`.

**Fix Required:**
- Use SQLite backup API
- Implement repair mode for migration failures
- Add consistency check after migration

---

## 5. Frontend React Issues

### 5.1 SettingsOverlay - Monolithic 2,800 Line Component

**Issues:**
- Single file handling 8 distinct settings categories
- Profile tab alone is ~500 lines
- No `useCallback`, `useMemo`, or `React.memo` anywhere
- 50+ `useState` hooks causing cascade re-renders

**Recommended Extractions:**

| Component | Lines | Reason |
|-----------|-------|--------|
| `GeneralSettings` | 1277-1639 | General tab content |
| `ProfileSettings` | 1640-2128 | Profile tab - very large |
| `AudioSettings` | 2266-2688 | Audio tab content |
| `KeybindSettings` | 2136-2263 | Keybinds tab |
| `ApiKeyInput` | 2358-2519 | Repeated API key UI pattern |
| `DeviceSelect` | 127-186 | CustomSelect reusable |

---

### 5.2 No Shared State - Context API Missing

**Issue:** Every window is completely isolated. Settings changes don't propagate without explicit event listeners.

```typescript
// Current: No shared state
// If you wanted to share state across windows, you'd need:
<ModelContext.Provider value={{ model, setModel }}>
```

**Impact:** As app grows, passing state through IPC/localStorage becomes error-prone.

---

### 5.3 QueryClient Per-Window Anti-Pattern

**File:** `/src/App.tsx:16`

```typescript
const queryClient = new QueryClient()  // Created at module level
```

**Issue:** Each Electron BrowserWindow is a separate renderer process with its own JavaScript context. QueryClient instances are isolated per window, defeating shared caching purpose.

---

### 5.4 Questionable Cleanup Dependency

**File:** `/src/components/NativelyInterface.tsx:298-621`

```typescript
useEffect(() => {
    const cleanups: (() => void)[] = [];
    // ... 20+ event listeners ...
    return () => cleanups.forEach(fn => fn());
}, [isExpanded]);  // Only depends on isExpanded
```

**Impact:** Expanding/collapsing the widget disconnects and reconnects all audio/AI listeners.

---

### 5.5 386+ Optional Chaining on window.electronAPI

**Pattern:**
```typescript
window.electronAPI?.onMeetingsUpdated?.(() => { ... })
window.electronAPI?.getDefaultModel?.()
```

**Impact:** TypeScript only validates at compile time. Runtime could fail if main process doesn't implement all methods.

---

## 6. Backend/Electron Issues

### 6.1 79KB IPC Handlers File

**File:** `/electron/ipcHandlers.ts` (~2,500 lines)

**Issue:** Single massive file with no organization. 100+ handlers in one file.

**Recommended Structure:**
```
ipcHandlers/
├── index.ts                    # Registration
├── license.ts                  # License/premium handlers
├── window.ts                   # Window management
├── screenshot.ts               # Screenshot handlers
├── llm.ts                      # LLM configuration
├── credentials.ts              # API keys
├── stt.ts                      # STT providers
├── meetings.ts                 # Meeting CRUD
├── intelligence.ts             # AI/intelligence
├── profile.ts                  # Profile engine
├── calendar.ts                 # Calendar integration
├── rag.ts                      # RAG operations
└── update.ts                   # Auto-update
```

---

### 6.2 Credentials Fallback to Unencrypted Storage

**File:** `/electron/services/CredentialsManager.ts`

```typescript
if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
    const plainPath = CREDENTIALS_PATH + '.json';
    fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));  // PLAINTEXT!
}
```

**Impact:** If `safeStorage` fails, all API keys stored in plaintext.

---

### 6.3 IPC Error Information Disclosure

**Pattern:**
```typescript
safeHandle("set-provider-preferred-model", async (_, provider, modelId) => {
    try {
        CredentialsManager.getInstance().setPreferredModel(provider, modelId);
    } catch (error: any) {
        console.error(`[IPC] Failed to set preferred model for ${provider}:`, error);
        // NO return statement - renderer gets undefined
    }
});
```

**Impact:** Renderer cannot distinguish success from failure. Silent failures.

---

### 6.4 STT Provider Resource Leak

**File:** `/electron/services/IntelligenceManager.ts`

```typescript
public async reconfigureSttProvider(): Promise<void> {
    if (this.googleSTT) {
        this.googleSTT.stop();
        this.googleSTT.removeAllListeners();
        this.googleSTT = null;  // But .destroy() not called!
    }
```

**Impact:** WebSocket connections (Deepgram, Soniox, ElevenLabs) may not close properly.

---

### 6.5 Memory Scrubbing Incomplete

**File:** `/electron/ipcHandlers.ts`

```typescript
const scrubMemory = () => {
    // Only overwrites string fields
    // Nested objects not scrubbed
}
```

---

## 7. Native Module Issues

### 7.1 SCK Stream Drop Blocks for 100ms

**File:** `/native-module/src/speaker/sck.rs:281-288`

```rust
impl Drop for SpeakerStream {
    fn drop(&mut self) {
        self.stream.stop_with_ch(|_| { ... });
        thread::sleep(Duration::from_millis(100));  // BLOCKS!
    }
}
```

**Impact:** If Drop called on critical thread, 100ms block could cause timing issues.

---

### 7.2 No Backpressure in LiveRAGIndexer

**File:** `/electron/rag/LiveRAGIndexer.ts:66-69`

```typescript
feedSegments(segments: RawSegment[]): void {
    this.allSegments.push(...segments);  // unbounded growth!
}
```

**Impact:** If embedding fails entirely, memory grows with every segment indefinitely.

---

### 7.3 Token Estimation is Character-Based

**File:** `/electron/rag/TranscriptPreprocessor.ts:193-195`

```typescript
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);  // Assumes ~4 chars/token
}
```

**Impact:** Rough approximation. GPT uses ~0.75 tokens/word, not 4 chars/token. Significantly off for non-English.

---

## 8. RAG System Issues

### 8.1 Vector Search Worker RequestId Race (Low Risk)

**File:** `/electron/rag/VectorStore.ts:101-102`

```typescript
this.requestId = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
```

**Issue:** Unnecessary `%` operation. With async/await making calls sequential, race condition is low risk in practice.

---

### 8.2 Unbounded Rate Limiter Queue

**File:** `/electron/llm/RateLimiter.ts:31-43`

```typescript
public async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);  // UNBOUNDED QUEUE
    });
}
```

**Impact:** If service is down, queued requests never resolve. Memory grows unbounded.

---

### 8.3 Intent Classifier Downloads ML Model in Dev Mode

**File:** `/electron/llm/IntentClassifier.ts:100-118`

```typescript
if (app.isPackaged) {
    env.allowRemoteModels = false;
} else {
    env.allowRemoteModels = true;  // Silently downloads ~100MB from HuggingFace
    env.cacheDir = path.join(__dirname, '../../resources/models');
}
```

**Impact:** Unexpected network dependency in development. No integrity verification.

---

## 9. Security Concerns

### 9.1 Dynamic Code Evaluation

**Files:**
- `LocalEmbeddingProvider.ts:51`
- `IntentClassifier.ts:101`

```typescript
new Function("return import('@xenova/transformers')")()
```

**Impact:** Cannot be statically analyzed. Bypasses module security checks.

---

### 9.2 Weak macOS Entitlements

```xml
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

**Impact:** Allows unsigned code execution and memory injection.

---

### 9.3 Hardened Runtime Disabled

```json
"hardenedRuntime": false
```

**Impact:** Despite JIT entitlements, hardened runtime is off.

---

### 9.4 Web Security Disabled in Dev

```typescript
webSecurity: !isDev  // Disabled in dev mode
```

---

### 9.5 No Input Validation on 100+ IPC Channels

**Impact:** Large attack surface with no channel validation.

---

## 10. Build & Infrastructure Issues

### 10.1 Zero Test Coverage

| Test File | Lines | Content |
|-----------|-------|---------|
| `/renderer/src/App.test.tsx` | 9 | Single smoke test checking "learn react" (which doesn't exist) |

**No tests for:**
- Electron main process (2,000+ lines)
- IPC handlers
- Database operations
- RAG pipeline
- Audio processing

---

### 10.2 CI/CD Only Runs Build

```yaml
# .github/workflows/public-sync.yml
- name: Build
  run: npm run electron:build
```

**No:**
- Unit tests
- Security scans
- Dependency audit
- Performance benchmarks

---

### 10.3 Inconsistent TypeScript Configs

| Config | Strict Mode | Issues |
|--------|-------------|--------|
| Root `tsconfig.json` | `strict: true` | OK |
| Electron `tsconfig.json` | Partial | Missing full strict |
| Renderer `tsconfig.json` | `target: es5` | Outdated |

---

### 10.4 Version Conflicts

| Package | Root | Renderer | Issue |
|---------|------|----------|-------|
| TypeScript | ^5.6.3 | ^4.9.5 | Major mismatch |

---

### 10.5 Postinstall Runs Heavy Operations

```json
"postinstall": "sharp rebuild && electron-builder install-app-deps && node scripts/download-models.js && node scripts/ensure-sqlite-vec.js"
```

**Impact:** Every `npm install` triggers 4 heavy operations including model download and sqlite-vec setup.

---

## 11. Recommended Optimization Patterns

### 11.1 React Performance

```typescript
// BAD: Current pattern in SettingsOverlay
const [value, setValue] = useState(initial);
const handleChange = (newValue) => {
    setValue(newValue);  // Triggers re-render
    window.electronAPI?.save?.(newValue);  // Direct IPC
};

// BETTER: Batch updates
const handleChange = useCallback((newValue) => {
    setPendingUpdates(prev => [...prev, { key, value: newValue }]);
}, []);

// Flush pending updates with debounce
useEffect(() => {
    const timer = setTimeout(() => {
        if (pendingUpdates.length > 0) {
            window.electronAPI?.batchSave?.(pendingUpdates);
            setPendingUpdates([]);
        }
    }, 500);
    return () => clearTimeout(timer);
}, [pendingUpdates]);
```

### 11.2 Extract Mic Level to Isolated Component

```typescript
// Extract to useMicrophoneLevel custom hook
function useMicrophoneLevel(deviceId: string) {
    const levelRef = useRef(0);
    const rafRef = useRef<number>();
    
    useEffect(() => {
        const updateLevel = () => {
            // Update ref, not state - prevents re-renders
            levelRef.current = getCurrentLevel();
            rafRef.current = requestAnimationFrame(updateLevel);
        };
        rafRef.current = requestAnimationFrame(updateLevel);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [deviceId]);
    
    return levelRef;  // Return ref, let component read when needed
}
```

### 11.3 Typed IPC Channels

```typescript
// channels.ts
import { z } from 'zod';

export const Channels = {
    GET_MODEL: 'get-model',
    SET_MODEL: 'set-model',
    // ...
} as const;

export const Schemas = {
    setModel: z.object({
        provider: z.enum(['openai', 'anthropic', 'gemini', 'groq']),
        modelId: z.string(),
    }),
    // ...
};

// In handler
safeHandle(Channels.SET_MODEL, async (_, input: unknown) => {
    const result = Schemas.setModel.safeParse(input);
    if (!result.success) {
        return { success: false, error: result.error.message };
    }
    // ... handler logic
});
```

### 11.4 Database Migration Safety

```typescript
// Add repair mode
async migrate(): Promise<void> {
    const backupPath = `${this.path}.backup-${Date.now()}`;
    
    try {
        await this.backup(backupPath);
        await this.runMigrations();
    } catch (error) {
        // Restore from backup on failure
        await this.restore(backupPath);
        throw new Error(`Migration failed, restored from backup: ${error.message}`);
    }
}
```

### 11.5 Rate Limiter with Bounded Queue

```typescript
public async acquire(timeoutMs: number = 30000): Promise<void> {
    this.refill();
    
    if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
    }
    
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            const index = this.waitQueue.indexOf(resolve);
            if (index !== -1) this.waitQueue.splice(index, 1);
            reject(new Error('Rate limiter timeout'));
        }, timeoutMs);
        
        this.waitQueue.push(() => {
            clearTimeout(timeout);
            resolve();
        });
    });
}
```

---

## 12. Priority Roadmap

### Immediate (Critical - Fix Before Next Release)

1. **[Native]** Fix resampler buffer memory leak
2. **[Security]** Add IPC input validation with Zod
3. **[Security]** Fix OAuth redirect URI to use HTTPS
4. **[Security]** Review and remove dangerous macOS entitlements
5. **[LLM]** Fix `streamWithGeminiParallelRace` to actually stream

### Soon (High Priority - Next Sprint)

1. **[Frontend]** Extract SettingsOverlay into smaller components
2. **[Frontend]** Add `useCallback`/`useMemo` to SettingsOverlay
3. **[Frontend]** Fix 60fps mic level re-render issue
4. **[LLM]** Implement token counting and context management
5. **[LLM]** Standardize retry logic across all methods
6. **[RAG]** Fix semantic chunking to respect boundaries

### Medium Term (Important - This Quarter)

1. **[RAG]** Add VAD decimation bug fix
2. **[Native]** Pre-allocate audio buffers
3. **[Electron]** Split 79KB IPC handlers file
4. **[Electron]** Add typed IPC channel definitions
5. **[Security]** Implement proper license verification
6. **[RAG]** Add rate limiting to LiveRAGIndexer

### Later (Nice to Have)

1. **[Frontend]** Add React Context for cross-window state
2. **[Frontend]** Add React Query shared cache provider
3. **[Infrastructure]** Implement actual test coverage
4. **[Infrastructure]** Add security scanning to CI
5. **[Infrastructure]** Add unit tests for Electron main process
6. **[Build]** Fix TypeScript version mismatch
7. **[Build]** Enable hardened runtime for macOS

---

## Appendix: Issue Summary Table

| ID | Issue | Severity | Component | Fix Difficulty |
|----|-------|----------|-----------|----------------|
| C1 | Resampler buffer memory leak | Critical | native-module | Low |
| C2 | IPC input validation failure | Critical | electron | Medium |
| C3 | OAuth redirect uses HTTP | Critical | electron | Low |
| C4 | Dangerous macOS entitlements | Critical | build | Medium |
| C5 | Stream race defeats streaming | Critical | electron/llm | Medium |
| H1 | 60fps re-render in Settings | High | frontend | Medium |
| H2 | No token/context management | High | electron/llm | Medium |
| H3 | Inconsistent retry logic | High | electron/llm | Medium |
| H4 | Semantic chunking ignores coherence | High | electron/rag | Medium |
| H5 | License manager is no-op | High | premium | Low |
| M1 | VAD decimation index bug | Medium | native-module | Low |
| M2 | Per-frame audio allocations | Medium | native-module | Medium |
| M3 | LiveRAGIndexer no rate limit | Medium | electron/rag | Low |
| M4 | Screenshot queue race | Medium | electron | Low |
| M5 | Groq rate limit too low | Medium | electron/llm | Low |
| M6 | DB migration atomicity | Medium | electron/db | Medium |
| F1 | SettingsOverlay monolithic | Medium | frontend | High |
| F2 | No Context API | Medium | frontend | Medium |
| F3 | QueryClient per-window | Low | frontend | Low |
| F4 | Cleanup dependency issue | Low | frontend | Low |
| E1 | 79KB IPC handlers file | Medium | electron | High |
| E2 | Credentials plaintext fallback | Medium | electron | Low |
| E3 | IPC error swallowing | Medium | electron | Low |
| E4 | STT provider resource leak | Medium | electron | Low |
| S1 | Dynamic code evaluation | High | frontend | Medium |
| S2 | Web security disabled dev | Medium | electron | Low |
| S3 | No IPC channel validation | High | electron | Medium |
| B1 | Zero test coverage | High | infra | High |
| B2 | CI doesn't run tests | High | infra | Low |
| B3 | TypeScript config inconsistency | Medium | infra | Low |
| B4 | Version conflicts | Low | infra | Low |

---

*Report generated by Principal Engineer review process*
