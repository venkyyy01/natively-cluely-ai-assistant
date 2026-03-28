# Production Reliability — Implementation Plan

> Spec: `docs/specs/production-reliability-spec.md`
> Created: 2026-03-27
> Goal: Harden the app for production and high-end local use in critical missions.

---

## Phase 0: Crash & Data Protection (Highest Priority)

### P0-1: Production Logging Infrastructure
**Files:** `electron/main.ts`
**Why first:** Every subsequent task benefits from production-visible logs.

- [ ] P0-1a: Remove `if (!isDev) return` guard in `logToFile()` (line 74)
- [ ] P0-1b: Add log level enum: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`
- [ ] P0-1c: Make production default log level `WARN` (configurable via `app_state` table)
- [ ] P0-1d: Add structured log fields: `timestamp`, `level`, `component`, `correlationId`
- [ ] P0-1e: Ensure existing log rotation (lines 38-70) works in production (currently gated by `isDev`)
- [ ] P0-1f: Add `[CRITICAL]` log level for crashes, data corruption, unrecoverable states

**Acceptance:** Production crash produces actionable log file. Logs ≤30MB total.

---

### P0-2: Crash-Safe Checkpointing
**New file:** `electron/CrashRecoveryManager.ts`
**Touches:** `electron/SessionTracker.ts`, `electron/main.ts`, `electron/MeetingPersistence.ts`

- [ ] P0-2a: Create `CrashRecoveryManager` class with:
  - `checkpoint(data: MeetingCheckpoint): void` — sync write to temp file
  - `loadCheckpoint(): MeetingCheckpoint | null` — read on startup
  - `clearCheckpoint(): void` — after successful meeting save
  - Checkpoint location: `app.getPath('userData')/meeting_checkpoint.json`
- [ ] P0-2b: Define `MeetingCheckpoint` interface:
  ```ts
  interface MeetingCheckpoint {
    meetingId: string;
    transcript: TranscriptSegment[];
    usage: any[];
    startTime: number;
    durationMs: number;
    context: string;
    checkpointedAt: number;
    meetingMetadata?: any;
  }
  ```
- [ ] P0-2c: In `SessionTracker`, add `toCheckpoint(): MeetingCheckpoint` method that serializes current state
- [ ] P0-2d: In `AppState` (main.ts), start a 30s `setInterval` during active meetings that calls `crashRecoveryManager.checkpoint(session.toCheckpoint())`
- [ ] P0-2e: Clear checkpoint on:
  - Successful `MeetingPersistence.stopMeeting()` completion
  - Session `reset()` without active meeting
- [ ] P0-2f: Wire into `uncaughtException` handler (main.ts:16): attempt emergency sync checkpoint write before crash

**Acceptance:** Kill renderer mid-meeting → restart → checkpoint data available with ≤30s loss.

---

### P0-3: Renderer Crash Detection & Recovery
**Touches:** `electron/main.ts` (AppState), `electron/WindowHelper.ts`

- [ ] P0-3a: Add `webContents.on('crashed')` handler on main window
- [ ] P0-3b: Add `webContents.on('unresponsive')` / `webContents.on('responsive')` handlers
- [ ] P0-3c: On crash: log details, reload window via `win.webContents.reload()`
- [ ] P0-3d: After reload: restore meeting state from `CrashRecoveryManager` checkpoint
- [ ] P0-3e: Send `meeting-checkpoint-restored` IPC event to renderer with recovered data
- [ ] P0-3f: Add `app.on('gpu-process-crashed')` handler → log + continue (don't terminate)

**Acceptance:** Renderer crash during meeting → auto-reload → transcript recovered → user notified.

---

### P0-4: Graceful Shutdown Coordinator
**Touches:** `electron/main.ts` (lines 2311-2327)

- [ ] P0-4a: Add global `shuttingDown` boolean flag, checked by all long-running operations
- [ ] P0-4b: Expand `before-quit` handler with sequenced shutdown:
  1. Set `shuttingDown = true`
  2. Cancel non-critical work (RAG indexing, screenshot processing)
  3. If meeting active: flush checkpoint + stop meeting
  4. Close STT WebSocket connections
  5. Close database (`db.close()`)
  6. Existing: scrub credentials, unregister shortcuts
- [ ] P0-4c: Add 10s safety timeout: `setTimeout(() => process.exit(0), 10000)`
- [ ] P0-4d: Expose `isShuttingDown()` method on `AppState` for other modules to check

**Acceptance:** Force-quit during post-processing → restart → no stuck meetings.

---

### P0-5: Startup Reconciliation
**Touches:** `electron/MeetingPersistence.ts`, `electron/db/DatabaseManager.ts`

- [ ] P0-5a: Add `processing_started_at INTEGER` column to `meetings` table (new migration v11)
- [ ] P0-5b: Set `processing_started_at = Date.now()` when saving placeholder (MeetingPersistence.ts:72)
- [ ] P0-5c: In `recoverUnprocessedMeetings()` (line 184), add timeout policy:
  - If `processing_started_at` > 10 minutes ago AND still `is_processed = 0`:
    - Attempt recovery from transcript
    - If recovery fails: mark `is_processed = -1` (terminal failure) with error message
- [ ] P0-5d: Check for CrashRecoveryManager checkpoint on startup:
  - If checkpoint exists AND its `meetingId` matches an unprocessed meeting → use checkpoint data for recovery
  - If checkpoint exists but no matching meeting → create meeting from checkpoint
  - Clear checkpoint after recovery attempt
- [ ] P0-5e: Call reconciliation from `initializeApp()` after database is ready

**Acceptance:** Startup after crash → stuck meetings resolved → no permanent "processing" state.

---

### P0-6: Database Hardening
**Touches:** `electron/db/DatabaseManager.ts` (init method, line 58+)

- [ ] P0-6a: Add pragmas after `new Database(this.dbPath)` (line 83):
  ```sql
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA busy_timeout = 5000;
  ```
- [ ] P0-6b: Add startup integrity check (light, abortable):
  ```ts
  try {
    const result = db.pragma('integrity_check(1)');
    // Log result, warn if not 'ok'
  } catch (e) {
    console.error('[DB] Integrity check failed:', e);
  }
  ```
- [ ] P0-6c: Ensure `createMigrationBackup()` is called before ALL future migrations (already done for v10, make systematic)

**Acceptance:** Startup after unclean shutdown → DB opens without corruption. WAL stays bounded.

---

## Phase 1: Correctness

### P1-1: Idempotent Meeting Persistence
**Touches:** `electron/MeetingPersistence.ts`, `electron/db/DatabaseManager.ts`

- [ ] P1-1a: In `DatabaseManager.saveMeeting()` (line 638), replace transcript `INSERT` with upsert flow:
  - Before inserting transcripts: `DELETE FROM transcripts WHERE meeting_id = ?`
  - Before inserting interactions: `DELETE FROM ai_interactions WHERE meeting_id = ?`
  - This makes `INSERT OR REPLACE` on meetings + `DELETE + INSERT` on children = idempotent
- [ ] P1-1b: Wrap the entire save operation in a single database transaction (already partially done at line 664, ensure delete+insert is inside)
- [ ] P1-1c: Add `createOrUpdateMeetingProcessingRecord(snapshot)` method:
  - Called from `stopMeeting()` placeholder save
  - Uses `INSERT OR REPLACE` on meetings
  - Sets `is_processed = 0`
- [ ] P1-1d: Add `finalizeMeetingProcessing(meetingId, processedPayload)` method:
  - Called from `processAndSaveMeeting()` on success
  - Deletes old transcripts/interactions, inserts new ones
  - Sets `is_processed = 1`
- [ ] P1-1e: Add `markMeetingProcessingFailed(meetingId, error, retryable)` method:
  - Sets `is_processed = -1` (failed terminal) or `is_processed = -2` (failed retryable)
  - Stores error message in `summary_json`

**Acceptance:** Saving placeholder then final for same meeting → one canonical transcript set. Re-running finalization → no duplicates.

---

### P1-2: Immutable Meeting Snapshot
**Touches:** `electron/MeetingPersistence.ts`, `electron/SessionTracker.ts`

- [ ] P1-2a: Define `MeetingSnapshot` interface (extract from inline object at MeetingPersistence.ts:38-44):
  ```ts
  interface MeetingSnapshot {
    transcript: TranscriptSegment[];
    usage: any[];
    startTime: number;
    durationMs: number;
    context: string;
    meetingMetadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' };
  }
  ```
- [ ] P1-2b: Add `SessionTracker.createSnapshot(): MeetingSnapshot` that deep-copies all state
- [ ] P1-2c: Capture `meetingMetadata` BEFORE `session.reset()` (fix bug at line 88 where `processAndSaveMeeting` reads metadata from already-reset session)
- [ ] P1-2d: Include `meetingMetadata` in snapshot, read from snapshot in `processAndSaveMeeting()` instead of `this.session.getMeetingMetadata()`
- [ ] P1-2e: Remove `this.session.clearMeetingMetadata()` from `processAndSaveMeeting()` (line 170) — snapshot owns the data now

**Acceptance:** `processAndSaveMeeting()` never touches `this.session` — operates entirely on snapshot.

---

### P1-3: Compaction/Save Race Fix
**Touches:** `electron/SessionTracker.ts`

- [ ] P1-3a: Add `compactionLock: Promise<void>` field to `SessionTracker`
- [ ] P1-3b: In `createSnapshot()`: await `compactionLock` before snapshotting
- [ ] P1-3c: In `compactTranscriptIfNeeded()`: set and clear `compactionLock` around the mutation
- [ ] P1-3d: Alternative (simpler): `createSnapshot()` copies `fullTranscript` array reference atomically (spread) and ignores in-flight compaction

**Acceptance:** Long meeting save after compaction → stable, repeatable results.

---

### P1-4: Delete/Reset Completeness
**Touches:** `electron/db/DatabaseManager.ts`

- [ ] P1-4a: In `deleteMeeting()` (line 886), add cascade cleanup:
  ```ts
  const deleteAll = this.db.transaction(() => {
    this.db.prepare('DELETE FROM embedding_queue WHERE meeting_id = ?').run(id);
    this.db.prepare('DELETE FROM chunk_summaries WHERE meeting_id = ?').run(id);
    this.db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(id);
    // Clean vec0 tables for all known dimensions
    for (const dim of DatabaseManager.KNOWN_DIMS) {
      try {
        this.db.prepare(`DELETE FROM vec_chunks_${dim} WHERE chunk_id IN (SELECT id FROM chunks WHERE meeting_id = ?)`).run(id);
        this.db.prepare(`DELETE FROM vec_summaries_${dim} WHERE summary_id IN (SELECT id FROM chunk_summaries WHERE meeting_id = ?)`).run(id);
      } catch {} // vec table may not exist
    }
    // CASCADE handles transcripts and ai_interactions
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  });
  deleteAll();
  ```
  **Note:** Order matters — delete vec entries before chunks/summaries since we query by meeting_id.
- [ ] P1-4b: In `clearAllData()` (line 936), add missing tables:
  ```ts
  // Add before existing deletes:
  for (const dim of DatabaseManager.KNOWN_DIMS) {
    try {
      this.db.exec(`DELETE FROM vec_chunks_${dim}`);
      this.db.exec(`DELETE FROM vec_summaries_${dim}`);
    } catch {}
  }
  ```
- [ ] P1-4c: After delete, notify RAG manager to invalidate caches for deleted meeting

**Acceptance:** Delete meeting → no stale search/index results. Clear all → truly empty.

---

### P1-5: Audio Lifecycle Correctness
**Touches:** `native-module/src/lib.rs`, `native-module/src/speaker/core_audio.rs`

- [ ] P1-5a: In `lib.rs:93`, replace `Option::take()` with `Option::as_ref().cloned()` for device id — don't consume the configured value
- [ ] P1-5b: In `core_audio.rs:163`, preserve actual channel count from device query instead of forcing assumptions
- [ ] P1-5c: Add test: repeated `start() -> stop() -> start()` cycle verifies same device id persists

**Acceptance:** Repeated start/stop keeps selected device. Mono stays mono.

---

## Phase 2: Lifecycle Discipline

### P2-1: Work Registry
**New file:** `electron/WorkRegistry.ts`

- [ ] P2-1a: Create `WorkRegistry` class:
  ```ts
  interface WorkItem {
    id: string;
    type: 'llm_request' | 'screenshot' | 'meeting_processing' | 'compaction' | 'embedding' | 'rag_indexing';
    owner: string;
    state: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
    createdAt: number;
    abortController: AbortController;
    cleanup?: () => void;
  }
  
  class WorkRegistry {
    register(item: Omit<WorkItem, 'state' | 'createdAt'>): WorkItem;
    cancel(id: string): void;
    cancelByType(type: string): void;
    cancelByOwner(owner: string): void;
    cancelAll(): void;
    complete(id: string): void;
    fail(id: string, error: Error): void;
    getActive(): WorkItem[];
    getActiveByType(type: string): WorkItem[];
    getStats(): { active: number; completed: number; cancelled: number; failed: number };
  }
  ```
- [ ] P2-1b: Make singleton, accessible from `AppState`
- [ ] P2-1c: On `shuttingDown`: call `workRegistry.cancelAll()`

**Acceptance:** All long-running work is trackable, cancellable, and cleaned up.

---

### P2-2: LLM Request Cancellation
**Touches:** `electron/LLMHelper.ts`, `electron/IntelligenceEngine.ts`

- [ ] P2-2a: Thread `AbortSignal` through all public LLM methods: `generateContent`, `generateWithFlash`, `generateWithPro`, `callOllama`
- [ ] P2-2b: In `withRetry()` (line 625): check `signal.aborted` before each retry attempt
- [ ] P2-2c: In `IntelligenceEngine`: when starting new mode, cancel prior mode's work via `WorkRegistry.cancelByOwner('intelligence_engine')`
- [ ] P2-2d: Replace "ignore stale response" pattern with actual abort — pass `signal` to `fetch()` calls and SDK `.create()` calls
- [ ] P2-2e: Add per-request timeout: 30s streaming start, 120s full response (extend existing `LLM_API_TIMEOUT_MS`)

**Acceptance:** New request cancels prior. No stale tokens arrive after supersession.

---

### P2-3: Bounded Caches and Timers
**Touches:** `electron/LLMHelper.ts`

- [ ] P2-3a: Add hard caps to all caches:
  - `systemPromptCache`: max 50 entries (line 137)
  - `finalPayloadCache`: max 20 entries (line 138)
  - `responseCache`: max 100 entries (line 139)
  - `inFlightResponseCache`: max 10 entries (line 140)
- [ ] P2-3b: Implement LRU eviction on each cache `set()` — when at capacity, delete oldest entry
- [ ] P2-3c: Add periodic cache cleanup interval (every 60s): delete expired entries
- [ ] P2-3d: Register cleanup interval with lifecycle manager — clear on shutdown
- [ ] P2-3e: Audit all `setTimeout`/`setInterval` calls in `LLMHelper` — ensure each has a corresponding `clearTimeout`/`clearInterval` in `scrubKeys()`

**Acceptance:** Long sessions show cache size plateau, not linear growth.

---

### P2-4: Renderer Duplicate Subscription Fix
**Touches:** `src/components/GlobalChatOverlay.tsx`, renderer-side IPC listeners

- [ ] P2-4a: Audit `GlobalChatOverlay.tsx` for overlapping auto-submit (line 133+ area)
- [ ] P2-4b: Add request deduplication: track `activeRequestId` and ignore responses for stale IDs
- [ ] P2-4c: In `useEffect` hooks: ensure cleanup functions remove ALL registered listeners
- [ ] P2-4d: Add `useRef` for active AbortController — abort on unmount and on new request
- [ ] P2-4e: Audit all IPC `on()` listeners in renderer — ensure corresponding `removeListener` in cleanup

**Acceptance:** Open overlay → one request. Remount → no listener multiplication.

---

### P2-5: IPC Timeout and Error Boundaries
**Touches:** `electron/ipcHandlers.ts`, `electron/preload.ts`

- [ ] P2-5a: Create `withIpcTimeout(handler, timeoutMs = 10000)` wrapper utility
- [ ] P2-5b: Create `withIpcErrorBoundary(handler)` wrapper that catches and logs errors
- [ ] P2-5c: Apply wrappers to top 10 most critical IPC handlers by traffic
- [ ] P2-5d: In `broadcast()` (main.ts:418): add `try/catch` per window (partially done — audit completeness)
- [ ] P2-5e: Add IPC slow-path logging: any handler taking >1s gets a `[WARN]` log

**Acceptance:** Hung IPC → timeout error to renderer. Single handler crash → others continue.

---

## Phase 3: Resilience

### P3-1: Circuit Breaker
**New file:** `electron/utils/CircuitBreaker.ts`

- [ ] P3-1a: Implement `CircuitBreaker` class:
  ```ts
  type CircuitState = 'closed' | 'open' | 'half-open';
  class CircuitBreaker {
    constructor(config: {
      failureThreshold: number;  // default 5
      resetTimeoutMs: number;    // default 60000
      halfOpenProbes: number;    // default 1
      name: string;
    });
    async execute<T>(fn: () => Promise<T>): Promise<T>;
    getState(): CircuitState;
    reset(): void;
    onStateChange(handler: (state: CircuitState) => void): void;
  }
  ```
- [ ] P3-1b: Create breaker instances for:
  - `llm-gemini`, `llm-openai`, `llm-claude`, `llm-groq`
  - `stt-openai`, `stt-deepgram`, `stt-soniox`, `stt-elevenlabs`
  - `embedding-openai`, `embedding-gemini`, `embedding-ollama`
- [ ] P3-1c: Integrate into `LLMHelper.withRetry()` — wrap each provider call with circuit breaker
- [ ] P3-1d: Log state transitions: `[CircuitBreaker:llm-openai] closed → open (5 failures)`

**Acceptance:** 5 consecutive LLM failures → breaker opens → no retry storms. Recovery within 120s.

---

### P3-2: Standardized STT Reconnection
**New file:** `electron/audio/WebSocketResilience.ts`
**Touches:** `electron/audio/OpenAIStreamingSTT.ts`, `ElevenLabsStreamingSTT.ts`, `SonioxStreamingSTT.ts`, `DeepgramStreamingSTT.ts`

- [ ] P3-2a: Create `WebSocketResilience` utility:
  ```ts
  interface WebSocketResilienceConfig {
    baseDelayMs: number;     // 1000
    maxDelayMs: number;      // 30000
    jitterPercent: number;   // 0.2
    maxAttempts: number;     // 10
    circuitResetMs: number;  // 120000
  }
  class WebSocketResilience {
    constructor(name: string, config?: Partial<WebSocketResilienceConfig>);
    scheduleReconnect(connectFn: () => void): void;
    onSuccess(): void;      // reset attempt counter
    onFailure(): void;      // increment counter
    getState(): 'connected' | 'reconnecting' | 'circuit_open' | 'stopped';
    stop(): void;
    reset(): void;
  }
  ```
- [ ] P3-2b: Refactor `OpenAIStreamingSTT` to delegate reconnection to `WebSocketResilience` (remove lines 86-87, 218, 254-528 reconnect logic)
- [ ] P3-2c: Refactor `ElevenLabsStreamingSTT` similarly (remove lines 15-16, 96, 103-105, 352-357)
- [ ] P3-2d: Refactor `SonioxStreamingSTT` similarly (remove lines 40-41, 337-345)
- [ ] P3-2e: Refactor `DeepgramStreamingSTT` similarly
- [ ] P3-2f: Emit health state changes for `HealthMonitor` consumption

**Acceptance:** Transient close → reconnect <10s. 10 failures → circuit opens. Provider switch → no leaked connections.

---

### P3-3: Network Monitor
**New file:** `electron/utils/NetworkMonitor.ts`
**Touches:** `electron/main.ts`, `electron/LLMHelper.ts`

- [ ] P3-3a: Create `NetworkMonitor` singleton:
  ```ts
  class NetworkMonitor {
    isOnline: boolean;
    start(): void;          // begin monitoring
    stop(): void;
    on(event: 'online' | 'offline', handler: () => void): void;
  }
  ```
- [ ] P3-3b: Implementation:
  - Primary: periodic lightweight HEAD to `https://dns.google` (30s interval)
  - Secondary: listen to Electron's `online`/`offline` events
- [ ] P3-3c: On offline: broadcast `network-status-changed` IPC to renderer
- [ ] P3-3d: Integrate with `LLMHelper`: check `NetworkMonitor.isOnline` before API calls, skip if offline
- [ ] P3-3e: Integrate with STT providers: pause reconnection attempts while offline
- [ ] P3-3f: On online restore: stagger resume (avoid thundering herd)

**Acceptance:** Network loss → offline within 30s → no API calls → restore resumes within 60s.

---

### P3-4: RAG Pipeline Lifecycle
**Touches:** `electron/rag/LiveRAGIndexer.ts`, `electron/rag/VectorStore.ts`, `electron/rag/EmbeddingPipeline.ts`

- [ ] P3-4a: Register RAG indexing batches in `WorkRegistry`
- [ ] P3-4b: Add `AbortSignal` to `EmbeddingPipeline.processQueue()` and `LiveRAGIndexer.flush()`
- [ ] P3-4c: Add 30s timeout to `EmbeddingPipeline.waitForReady()` (prevent indefinite hang)
- [ ] P3-4d: Surface embedding provider fallback as user-visible notification via IPC:
  ```ts
  broadcast('embedding-provider-changed', { from: 'openai', to: 'ollama', reason: 'API key missing' });
  ```
- [ ] P3-4e: On meeting stop: cancel pending RAG indexing via work registry
- [ ] P3-4f: Bound in-memory vector cache size in `VectorStore`

**Acceptance:** Meeting stop cancels RAG work. Provider fallback is visible. Memory bounded.

---

### P3-5: Disk Guard
**New file:** `electron/utils/DiskGuard.ts`
**Touches:** `electron/main.ts`, `electron/ScreenshotHelper.ts`

- [ ] P3-5a: Create `DiskGuard` class:
  ```ts
  class DiskGuard {
    start(intervalMs: number = 60000): void;
    stop(): void;
    getAvailableBytes(): number;
    getStatus(): 'ok' | 'warning' | 'critical' | 'emergency';
  }
  ```
- [ ] P3-5b: Threshold actions:
  - Warning (<1GB): log + IPC notification to renderer
  - Critical (<500MB): pause RAG indexing, screenshot storage
  - Emergency (<200MB): rotate logs, force WAL checkpoint, prune screenshots >7 days old
- [ ] P3-5c: Add screenshot retention policy to `ScreenshotHelper`: keep last 100 or 7 days
- [ ] P3-5d: Add WAL checkpoint trigger: if WAL > 100MB, force `PRAGMA wal_checkpoint(TRUNCATE)`
- [ ] P3-5e: Integrate with `WorkRegistry`: pause/resume background tasks based on disk status

**Acceptance:** 30-day use → disk bounded. Low disk warning before failures.

---

## Phase 4: Prolonged-Use Hardening

### P4-1: Health Monitor
**New file:** `electron/utils/HealthMonitor.ts`
**Touches:** `electron/main.ts`, renderer status UI

- [ ] P4-1a: Create `HealthMonitor` singleton tracking:
  - Renderer: alive, responsive (via heartbeat IPC)
  - Database: writable (periodic test write to `app_state`)
  - STT: per-provider connection state from `WebSocketResilience`
  - LLM API: per-provider circuit breaker state
  - Disk: from `DiskGuard`
  - Memory: `process.memoryUsage()` periodically
- [ ] P4-1b: Expose health via IPC: `get-health-status` → returns full health snapshot
- [ ] P4-1c: Emit degraded-state events when any subsystem enters unhealthy state
- [ ] P4-1d: Add heartbeat IPC from renderer (every 5s) to detect frozen renderer

**Acceptance:** Health queryable. Degraded state visible in logs. Frozen renderer detected.

---

### P4-2: Main-Thread Pressure Reduction
**Touches:** `electron/db/DatabaseManager.ts`, `electron/ipcHandlers.ts`

- [ ] P4-2a: Audit IPC handlers for synchronous DB calls on hot paths
- [ ] P4-2b: Move heavy DB queries to `db.prepare().all()` with LIMIT clauses
- [ ] P4-2c: In `getRecentMeetings()` (line 784): ensure LIMIT is enforced (already has parameter, audit callers)
- [ ] P4-2d: Add `nativeSetImmediate` or `setImmediate` to yield main thread between large batch operations
- [ ] P4-2e: Profile `saveMeeting()` transaction time for meetings with >1000 transcript entries — consider batched inserts

**Acceptance:** No main-thread task >50ms during active meeting. UI stays responsive.

---

### P4-3: Diagnostic Bundle Export
**Touches:** `electron/ipcHandlers.ts`, settings UI

- [ ] P4-3a: Add `export-diagnostic-bundle` IPC handler
- [ ] P4-3b: Bundle includes:
  - Last 3 log files (rotated)
  - DB integrity check result
  - `process.memoryUsage()` snapshot
  - System info: OS, Electron version, Node version, architecture
  - HealthMonitor snapshot
  - WorkRegistry stats
  - Current DB schema version
- [ ] P4-3c: Save as timestamped zip to desktop
- [ ] P4-3d: Add "Export Diagnostic Data" button in settings UI

**Acceptance:** User can export diagnostic bundle. Support doesn't require dev mode.

---

### P4-4: Soak Test Instrumentation
**New file:** `electron/tests/soak-test.ts`

- [ ] P4-4a: Create automated 3-hour simulated meeting test:
  - Continuous transcript input (1 segment/second)
  - Periodic suggestions (every 60s)
  - Periodic screenshot processing (every 5 min)
  - Intermittent provider hiccups (random 5xx every 10 min)
- [ ] P4-4b: Instrument metrics collection:
  - Memory usage (every 30s)
  - Active listener count
  - Active work items
  - Cache sizes
  - UI responsiveness (IPC round-trip time)
- [ ] P4-4c: Define pass/fail criteria:
  - Memory growth <5% after first 30 min plateau
  - Listener count stable ±5%
  - No duplicate durable state
  - IPC latency p95 <200ms

**Acceptance:** Soak test passes with all metrics within bounds.

---

## Implementation Order & Dependencies

```
P0-1 (Logging) ─── no deps, do first ───────────────────────────┐
P0-6 (DB Hardening) ─── no deps ──────────────────────────────┐ │
P0-2 (Checkpointing) ─── depends on P0-1 ──────────────────┐ │ │
P0-3 (Crash Recovery) ─── depends on P0-2 ───────────────┐ │ │ │
P0-4 (Graceful Shutdown) ─── depends on P0-1 ─────────┐ │ │ │ │
P0-5 (Startup Reconciliation) ─── depends on P0-2,6 ┐ │ │ │ │ │
                                                     v v v v v v
P1-1 (Idempotent Persistence) ─── depends on P0-6 ──────────────┐
P1-2 (Snapshot) ─── depends on P1-1 ──────────────────────────┐ │
P1-3 (Compaction Race) ─── depends on P1-2 ────────────────┐ │ │
P1-4 (Delete Cascade) ─── depends on P0-6 ──────────────┐ │ │ │
P1-5 (Audio) ─── independent ────────────────────────┐ │ │ │ │
                                                     v v v v v
P2-1 (Work Registry) ─── depends on P0-4 ────────────────────────┐
P2-2 (LLM Cancellation) ─── depends on P2-1 ──────────────────┐ │
P2-3 (Bounded Caches) ─── independent ─────────────────────┐ │ │
P2-4 (Renderer Fix) ─── independent ────────────────────┐ │ │ │
P2-5 (IPC Timeout) ─── independent ──────────────────┐ │ │ │ │
                                                     v v v v v
P3-1 (Circuit Breaker) ─── depends on P2-1 ──────────────────────┐
P3-2 (STT Reconnect) ─── depends on P3-1 ──────────────────────┐ │
P3-3 (Network Monitor) ─── depends on P3-1 ──────────────────┐ │ │
P3-4 (RAG Lifecycle) ─── depends on P2-1 ─────────────────┐ │ │ │
P3-5 (Disk Guard) ─── depends on P0-1 ─────────────────┐ │ │ │ │
                                                       v v v v v
P4-1 (Health Monitor) ─── depends on P3-1,2,3,5 ────────────────┐
P4-2 (Main Thread) ─── independent ──────────────────────────┐ │
P4-3 (Diagnostic Bundle) ─── depends on P4-1 ─────────────┐ │ │
P4-4 (Soak Test) ─── depends on all above ──────────────┐ │ │ │
                                                        v v v v
                                                    ✅ EXIT CRITERIA
```

---

## Exit Criteria Checklist

### Hard (must pass)
- [ ] No duplicate transcript/interactions under any save/retry path
- [ ] No stale jobs after cancel/supersede
- [ ] No silent device drift after repeated start/stop
- [ ] No stale indexed content after delete/reset
- [ ] No listener/timer/worker growth over prolonged use
- [ ] No persistent ambiguous processing states
- [ ] App remains responsive during real combined workflows
- [ ] Renderer crash during meeting recovers transcript within 30s of loss
- [ ] Startup after crash produces clean state (no stuck meetings)
- [ ] Production builds produce actionable log files during failures
- [ ] No retry storms during network outage

### Soft (target, not blocking)
- [ ] 3h session memory growth <5% after 30min plateau
- [ ] Crash recovery loses <30s of transcript data
- [ ] Offline detection within 30s
- [ ] Circuit breakers recover within 120s
- [ ] Disk usage bounded over 30-day simulated use

---

## Review Notes
*Updated after each phase completion.*
