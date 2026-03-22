# Enhancement Specification: Acceleration Mode

**Spec ID:** enhancement-spec-accelerator  
**Version:** 1.0  
**Status:** PARTIALLY IMPLEMENTED  
**Created:** 2026-03-22  
**Author:** Implementation Review

---

## 1. Executive Summary

Acceleration Mode is a performance enhancement feature that leverages Apple Silicon Neural Engine (ANE) for faster embeddings, context assembly, and prompt compilation. The feature is controlled by a master toggle in Settings that activates a suite of optimization modules while maintaining full backward compatibility when disabled.

---

## 2. Feature Overview

### 2.1 Purpose

Enable hardware-accelerated processing for:
- Prompt compilation and deduplication
- Semantic caching with similarity lookup
- Parallel context assembly with BM25 scoring
- ANE-based embedding generation
- Adaptive context window selection
- Predictive prefetching during silence
- Stealth mode with content protection

### 2.2 User-Facing Behavior

| Toggle State | System Behavior |
|--------------|-----------------|
| OFF (default) | Existing system unchanged. No acceleration modules active. |
| ON | All acceleration modules activated. Faster response times on Apple Silicon. |

### 2.3 Scope

- **In Scope:** Apple Silicon Macs (M1/M2/M3/M4)
- **Out of Scope:** Intel Macs, Windows (modules gracefully degrade)

---

## 3. Architecture

### 3.1 Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Settings UI Toggle                        │
│                  (GeneralSettingsSection)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    SettingsManager                           │
│              accelerationModeEnabled: boolean                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   optimizations.ts                           │
│         isOptimizationActive(flag) → boolean                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌───────────┐  ┌───────────┐  ┌───────────┐
│PromptComp.│  │EnhancedC. │  │ANEEmbed.  │
│ (llm/)    │  │ (cache/)  │  │(rag/prov.)│
└───────────┘  └───────────┘  └───────────┘
```

### 3.2 Feature Flags

| Flag | Description | Default |
|------|-------------|---------|
| `accelerationEnabled` | Master toggle | `false` |
| `usePromptCompiler` | Deduplicated prompt assembly | `true` (when master on) |
| `useEnhancedCache` | LRU + TTL + semantic cache | `true` (when master on) |
| `useParallelContext` | Parallel context assembly | `true` (when master on) |
| `useANEEmbeddings` | Neural Engine embeddings | `true` (when master on) |
| `useAdaptiveWindow` | Phase-aware context selection | `true` (when master on) |
| `usePrefetching` | Predictive prefetch during silence | `true` (when master on) |
| `useStealthMode` | Content protection for windows | `true` (when master on) |
| `useStreamManager` | Semantic boundary streaming | `true` (when master on) |

### 3.3 Guard Pattern

All modules use the guard pattern:

```typescript
if (!isOptimizationActive('useModuleName')) {
  return fallbackImplementation();
}
// ... accelerated path
```

---

## 4. Implementation Status

### 4.1 Completed Components

| Component | Location | Status | Notes |
|-----------|----------|--------|-------|
| Feature flag system | `electron/config/optimizations.ts` | ✅ Complete | Master toggle + per-feature flags |
| Settings persistence | `electron/services/SettingsManager.ts` | ✅ Complete | `accelerationModeEnabled` persisted |
| IPC handlers | `electron/ipc/registerSettingsHandlers.ts` | ✅ Complete | `set-acceleration-mode`, `get-acceleration-mode` |
| Preload bridge | `electron/preload.ts` | ✅ Complete | Full IPC bridge |
| Type declarations | `src/types/electron.d.ts` | ✅ Complete | TypeScript types |
| AppState methods | `electron/main.ts` | ✅ Complete | `setAccelerationModeEnabled()`, `getAccelerationModeEnabled()` |
| Settings UI toggle | `src/components/settings/GeneralSettingsSection.tsx` | ✅ Complete | Toggle with error handling |
| PromptCompiler | `electron/llm/PromptCompiler.ts` | ✅ Complete | Deduplication + caching |
| StreamManager | `electron/llm/StreamManager.ts` | ✅ Complete | Semantic boundary streaming |
| EnhancedCache | `electron/cache/EnhancedCache.ts` | ✅ Complete | LRU + TTL + semantic lookup |
| ParallelContextAssembler | `electron/cache/ParallelContextAssembler.ts` | ✅ Complete | BM25 scoring |
| ANEEmbeddingProvider | `electron/rag/providers/ANEEmbeddingProvider.ts` | ✅ Complete | ONNX/CoreML fallback |
| AdaptiveContextWindow | `electron/conscious/AdaptiveContextWindow.ts` | ✅ Complete | Multi-signal selection |
| PredictivePrefetcher | `electron/prefetch/PredictivePrefetcher.ts` | ✅ Complete | Phase-based prefetch |
| StealthManager | `electron/stealth/StealthManager.ts` | ✅ Complete | Content protection |
| AccelerationManager | `electron/services/AccelerationManager.ts` | ✅ Complete | Orchestrator |
| Test suite | `electron/tests/*.test.ts` | ✅ Complete | 26 tests, all passing |

### 4.2 Deferred Integrations

These modules exist but are NOT YET wired into the existing pipeline:

| Integration Point | File | Required Change | Risk Level |
|-------------------|------|-----------------|------------|
| Prompt compilation | `electron/llm/prompts.ts` | Use PromptCompiler when flag active | HIGH - 2000+ line file |
| Response caching | `electron/LLMHelper.ts` | Replace Map cache with EnhancedCache | MEDIUM |
| Context assembly | `electron/IntelligenceEngine.ts` | Use ParallelContextAssembler | MEDIUM |
| Embedding provider | `electron/rag/EmbeddingPipeline.ts` | Add ANE provider selection | LOW |
| Context windowing | `electron/SessionTracker.ts` | Use AdaptiveContextWindow | MEDIUM |

---

## 5. API Specification

### 5.1 IPC Methods

#### `set-acceleration-mode`

**Request:**
```typescript
{ enabled: boolean }
```

**Response:**
```typescript
{ success: true; data: { enabled: boolean } }
// or
{ success: false; error: { code: string; message: string } }
```

#### `get-acceleration-mode`

**Request:** None

**Response:**
```typescript
{ success: true; data: { enabled: boolean } }
```

### 5.2 Renderer API

```typescript
interface ElectronAPI {
  setAccelerationMode(enabled: boolean): Promise<{
    success: true;
    data: { enabled: boolean }
  } | {
    success: false;
    error: { code: string; message: string }
  }>;
  getAccelerationMode(): Promise<{
    success: true;
    data: { enabled: boolean }
  } | {
    success: false;
    error: { code: string; message: string }
  }>;
  onAccelerationModeChanged(callback: (enabled: boolean) => void): () => void;
}
```

### 5.3 Settings Schema

```typescript
interface AppSettings {
  // ... existing settings
  accelerationModeEnabled?: boolean;
}
```

---

## 6. Test Specification

### 6.1 Unit Tests

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| `promptCompiler.test.ts` | 3 | Deduplication, caching, token estimation |
| `streamManager.test.ts` | 3 | Token accumulation, JSON parsing, background tasks |
| `enhancedCache.test.ts` | 4 | Store/retrieve, TTL, memory pressure, semantic lookup |
| `parallelContextAssembly.test.ts` | 3 | Parallel assembly, failure handling, thread count |
| `adaptiveContextWindow.test.ts` | 3 | Semantic selection, token budget, recency weighting |
| `predictivePrefetcher.test.ts` | 4 | Phase prediction, caching, speaking detection, topic shift |
| `stealthManager.test.ts` | 3 | Window options, disable state, platform detection |
| `accelerationModeIntegration.test.ts` | 3 | Master toggle, individual flags, feature gating |
| `aneEmbeddingProvider.test.ts` | 4 | Init, embedding, batch, fallback (requires onnxruntime) |

### 6.2 Integration Tests

Required but not yet implemented:
- E2E test: Toggle ON → verify modules active
- E2E test: Toggle OFF → verify fallback behavior
- E2E test: Toggle during active session

---

## 7. Dependencies

### 7.1 Production Dependencies

All existing - no new runtime dependencies required.

### 7.2 Optional Dependencies

| Package | Purpose | Status |
|---------|---------|--------|
| `onnxruntime-node` | ANE embedding acceleration | NOT ADDED - optional, graceful fallback |

---

## 8. Performance Targets

| Metric | Baseline (OFF) | Target (ON) |
|--------|----------------|-------------|
| Prompt compilation | ~50ms | ~5ms (cached) |
| Embedding generation | ~100ms | ~20ms (ANE) |
| Context assembly | ~200ms | ~50ms (parallel) |
| Cache hit rate | N/A | >80% |

---

## 9. Security Considerations

### 9.1 Settings Persistence

- Settings stored in `userData/settings.json`
- Validated via `sanitizeSettings()` before use
- No sensitive data in settings file

### 9.2 Guard Bypass Prevention

- All modules check `isOptimizationActive()` at entry point
- Cannot be bypassed by direct module instantiation
- Feature flags controlled solely by SettingsManager

---

## 10. Known Limitations

1. **ANE requires onnxruntime-node** - Optional dependency not installed by default
2. **Intel Macs** - Fall back to CPU implementations
3. **Windows** - Fall back to CPU implementations
4. **Integration incomplete** - Modules exist but not wired into pipeline (deferred)

---

## 11. Future Work

### 11.1 Short Term
- Add `onnxruntime-node` as optional dependency
- Complete PromptCompiler integration
- Complete EnhancedCache integration

### 11.2 Medium Term
- Complete ParallelContextAssembler integration
- Complete ANEEmbeddingProvider integration
- Add E2E integration tests

### 11.3 Long Term
- Performance telemetry and auto-tuning
- User-visible performance metrics
- A/B testing for optimization effectiveness

---

## 12. Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial specification based on implementation review |

---

## Appendix A: File Manifest

### New Files Created

```
electron/llm/promptComponents.ts
electron/llm/PromptCompiler.ts
electron/llm/StreamManager.ts
electron/cache/EnhancedCache.ts
electron/cache/ParallelContextAssembler.ts
electron/rag/providers/ANEEmbeddingProvider.ts
electron/rag/providers/IEmbeddingProvider.ts
electron/conscious/AdaptiveContextWindow.ts
electron/prefetch/PredictivePrefetcher.ts
electron/stealth/StealthManager.ts
electron/config/optimizations.ts
electron/services/AccelerationManager.ts
electron/tests/promptCompiler.test.ts
electron/tests/streamManager.test.ts
electron/tests/enhancedCache.test.ts
electron/tests/aneEmbeddingProvider.test.ts
electron/tests/parallelContextAssembly.test.ts
electron/tests/adaptiveContextWindow.test.ts
electron/tests/predictivePrefetcher.test.ts
electron/tests/stealthManager.test.ts
electron/tests/accelerationModeIntegration.test.ts
```

### Modified Files

```
electron/services/SettingsManager.ts (added accelerationModeEnabled)
electron/ipc/registerSettingsHandlers.ts (added IPC handlers)
electron/preload.ts (added bridge methods)
electron/main.ts (added AppState methods)
src/types/electron.d.ts (added type declarations)
src/components/SettingsOverlay.tsx (added state management)
src/components/settings/GeneralSettingsSection.tsx (added toggle UI)
```
