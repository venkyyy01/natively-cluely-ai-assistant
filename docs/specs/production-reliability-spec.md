# Production Reliability Spec

## Purpose

Make the app dependable under prolonged, real-world, high-stakes use—including multi-hour critical meetings, unstable networks, and mission-sensitive workflows where data loss or app failure is unacceptable.

This spec focuses on stability, correctness, crash survival, data durability, recovery, and consistent runtime behavior.
It intentionally ignores security-only concerns unless they directly affect uptime or reliability.

## Scope

- Electron main process and renderer process crash isolation
- IPC layer between main and renderer
- Meeting persistence and recovery
- LLM orchestration and request lifecycle
- Audio/STT pipeline (all providers)
- Native audio module
- Background processing and indexing
- RAG/Vector pipeline (embeddings, live indexing, vector search)
- Network and WebSocket connection management
- Disk and storage management
- Production logging and diagnostics
- Graceful shutdown and startup reconciliation

## Out of Scope

- New product features
- UI redesign
- Security hardening not tied to runtime stability
- Cosmetic refactors

---

## Reliability Standard

The app should:

- stay responsive during 3+ hour meetings
- survive renderer crashes without losing meeting state
- avoid silent data corruption under any save/retry path
- recover cleanly from interruption, crash, or force-quit
- cancel stale work instead of accumulating it
- maintain bounded memory/cpu/disk growth
- preserve user intent across repeated start/stop cycles
- degrade gracefully when dependencies fail (LLM, STT, network)
- operate reliably on degraded or intermittent networks
- fail fast on invalid configuration rather than silently degrading
- produce actionable diagnostics in production (not just dev)

## Success Criteria

| Criterion | Target |
|---|---|
| Duplicate transcript rows for same meeting | 0 |
| Stale indexed data after delete/reset | 0 |
| Zombie LLM/processing jobs after cancel | 0 |
| Silent device/config drift after audio lifecycle changes | 0 |
| Listener/timer/worker growth across prolonged use | 0 (plateau within 5min) |
| Persistent "processing forever" meeting states | 0 |
| Major UI freezes during active meeting workflows | 0 (>500ms) |
| Multi-hour soak usage stable | 3h with <5% memory drift |
| Renderer crash → data loss | 0 events lost |
| App startup after crash → stuck state | 0 meetings permanently stuck |
| Disk usage growth during idle | 0 (after cleanup) |
| Network outage → app wedge | 0 (graceful degradation) |
| STT reconnection after transient failure | <10s recovery |

---

## 1. Current Reliability Problems

### 1.1 Persistence is not idempotent

- `electron/db/DatabaseManager.ts:638` inserts transcript rows every save.
- `electron/MeetingPersistence.ts:54` saves placeholder data.
- `electron/MeetingPersistence.ts:167` saves final data for the same logical meeting.
- Result: one meeting can accumulate duplicate transcript/interactions.

### 1.2 Session state is used after reset

- `electron/MeetingPersistence.ts:46` resets the session before background processing is fully isolated.
- `electron/MeetingPersistence.ts:88` later reads metadata from live session state.
- Result: metadata loss and timing-dependent behavior.

### 1.3 Transcript compaction can race with save

- `electron/SessionTracker.ts:176` launches compaction asynchronously.
- `electron/SessionTracker.ts:605` mutates transcript storage during compaction.
- Result: possible partial transcript loss or inconsistent persistence.

### 1.4 Delete/reset is incomplete

- `electron/db/DatabaseManager.ts:886` deletes the meeting row but not all derived/indexed artifacts.
- `electron/db/DatabaseManager.ts:936` clears only part of persisted state.
- Result: deleted data can still influence search/index behavior.

### 1.5 Async work ownership is weak

- Some jobs are logically abandoned but still run upstream.
- Some abort controllers are created but not actually wired into the work.
- Result: zombie jobs, stale results, wasted resources.

### 1.6 Memory growth is insufficiently bounded

- Caches in `electron/LLMHelper.ts:137` are not strongly bounded.
- Timers from helpers like `electron/LLMHelper.ts:34` are not rigorously lifecycle-managed.
- Some listeners/workers/buffers are not clearly cleaned up.
- Result: "works at first, degrades later."

### 1.7 Renderer can duplicate requests/listeners

- `src/components/GlobalChatOverlay.tsx:133` has overlapping auto-submit behavior.
- Similar flows showed duplicate event subscription patterns.
- Result: duplicate calls, interleaved streams, inconsistent UI.

### 1.8 Audio lifecycle is not fully dependable

- `native-module/src/lib.rs:93` consumes device id with `take()`.
- `native-module/src/speaker/core_audio.rs:163` can force incorrect channel assumptions.
- Result: device drift and degraded audio/STT behavior after repeated use.

### 1.9 Main-thread pressure is too high in some paths

- Synchronous DB/file work still sits on important paths.
- Result: UI responsiveness drops exactly when app load is highest.

### 1.10 STT reconnection logic is fragmented and inconsistent

- Each STT provider (`OpenAIStreamingSTT`, `ElevenLabsStreamingSTT`, `SonioxStreamingSTT`, `DeepgramStreamingSTT`) implements its own reconnect logic with different backoff strategies, max attempt limits, and cleanup patterns.
- No circuit breaker prevents infinite reconnect loops during sustained outages.
- No shared reconnection budget to prevent multiple STT providers from hammering APIs simultaneously.
- Result: inconsistent recovery behavior, potential API credit burn under sustained failures, no unified health reporting.

### 1.11 No crash recovery for renderer process

- If the renderer crashes mid-meeting, all in-memory transcript data and UI state is lost.
- Main process has `uncaughtException` and `unhandledRejection` handlers but they only log; no state preservation happens.
- No periodic checkpoint of critical in-flight data to durable storage.
- Result: a single renderer crash during a critical meeting can lose the entire session.

### 1.12 Disk usage is unbounded

- Screenshots, logs, RAG vector indexes, SQLite WAL files, and meeting artifacts accumulate without policy.
- Log rotation exists (`main.ts:38`) but only in dev mode. Production builds have no log management at all.
- No disk space monitoring or pre-emptive cleanup.
- Result: prolonged use can exhaust disk space, causing silent SQLite write failures and data corruption.

### 1.13 IPC layer has no timeout or error boundary

- `electron/ipcHandlers.ts` (50K+ lines) and `electron/preload.ts` (51K+) handle hundreds of IPC channels.
- No timeout on IPC round-trips—a hung handler blocks the renderer indefinitely.
- No dead-letter handling for messages sent to destroyed windows.
- Result: renderer freezes that require force-quit, lost messages during window lifecycle transitions.

### 1.14 RAG/Vector pipeline has no lifecycle management

- `electron/rag/EmbeddingPipeline.ts`, `VectorStore.ts`, `LiveRAGIndexer.ts` run background work without integration into the work registry.
- Vector search worker (`vectorSearchWorker.ts`) is not tracked for lifecycle or cancellation.
- Embedding provider cascade (OpenAI → Gemini → Ollama → Local) can silently fall to lowest quality without notification.
- Result: background CPU/memory spikes during indexing, no cancellation path, silent quality degradation.

### 1.15 Production logging is disabled

- `logToFile()` in `main.ts:72` returns immediately if `!isDev`.
- Production builds have zero file-level diagnostics.
- No structured logging, no log levels, no correlation IDs.
- Result: production issues are unreproducible; support requires users to "try dev mode."

### 1.16 Network failures cause cascading failures

- From historical incidents: "Network error during API request: Load failed" occurs intermittently.
- No circuit breaker on LLM API calls—transient failures trigger retry storms.
- No offline detection: the app continues attempting API calls during network outages.
- WebSocket STT connections and HTTP LLM calls have no coordinated backoff strategy.
- Result: CPU spikes from retries, wasted API credits, and user-visible errors during transient network issues.

### 1.17 No graceful shutdown sequence

- `app.on('before-quit')` does not coordinate an orderly shutdown of active meeting processing, STT sessions, RAG indexing, and pending DB writes.
- Force-quit during post-processing can leave meetings in permanent `processing` state.
- Result: restart after unclean exit requires manual recovery or data loss.

---

## 2. Design Goals

### 2.1 Correctness

- The same logical operation should not create duplicate durable state.
- A saved meeting should always represent one canonical truth.

### 2.2 Recoverability

- Interrupted work must resume or fail explicitly.
- No hidden limbo states.
- Crash mid-meeting must not lose more than 30 seconds of transcript data.

### 2.3 Boundedness

- All caches, buffers, workers, subscriptions, and queues must have explicit limits.
- Disk usage must be monitored and bounded.

### 2.4 Cancellability

- Superseded work must actually stop, not just be ignored by UI.

### 2.5 Observability

- Failures and transitions must be visible in logs and state—in both dev AND production.
- Structured logs with correlation IDs for request tracing.
- Health status queryable by renderer for user-facing status indicators.

### 2.6 Repeatability

- Repeated start/stop, retry, cancel, reopen, and remount flows should remain stable.

### 2.7 Crash Isolation

- Renderer crash must not lose persisted or checkpointed data.
- Main process must detect renderer crash and re-establish session state.
- GPU process crash must not take down the app.

### 2.8 Network Resilience

- All external API calls must tolerate transient failures.
- Sustained outages must trigger graceful degradation, not retry storms.
- Offline state must be detected and surfaced to the user.

---

## 3. Core Design Principles

### 3.1 Immutable handoff

- Background processing must operate on immutable snapshots, never live mutable session state.

### 3.2 Single owner per resource

- Every listener, timer, worker, stream, and queue must have one clear owner and one cleanup path.

### 3.3 Explicit lifecycle

- Every long-running job must have:
  - id
  - owner
  - state
  - cancel path
  - cleanup path
  - failure mode

### 3.4 Idempotent persistence

- Re-running persistence must update, not duplicate.

### 3.5 Graceful degradation

- Provider/model failure should reduce functionality, not destabilize the app.

### 3.6 Circuit breaker

- Repeated failures to the same endpoint/service must trip a circuit breaker.
- Breaker states: `closed` (normal) → `open` (failing, stop requests) → `half-open` (probe).
- Applies to: LLM APIs, STT WebSockets, embedding endpoints, Ollama.

### 3.7 Fail-fast validation

- Invalid or missing configuration must cause immediate, clear failure at startup—not silent degradation minutes later.
- Applies to: API keys, device IDs, database path, required permissions.

### 3.8 Crash-safe checkpointing

- Critical in-flight data (transcript, meeting state) must be periodically checkpointed to durable storage.
- Checkpoint interval: ≤30 seconds.
- Recovery on startup must restore from latest checkpoint.

### 3.9 Coordinated shutdown

- Shutdown must follow a deterministic sequence:
  1. Stop accepting new work
  2. Cancel non-critical in-flight work
  3. Flush critical in-flight work (meeting save, transcript checkpoint)
  4. Close database connections
  5. Exit

---

## 4. Required Architecture Changes

### 4.1 Introduce `MeetingSnapshot`

- Create a dedicated immutable snapshot object before reset or async handoff.
- Must include:
  - transcript
  - usage
  - start time
  - duration
  - meeting metadata
  - source/calendar metadata
  - resolved context needed for post-processing

### 4.2 Introduce explicit meeting processing states

- Meeting state model:
  - `recording`
  - `processing`
  - `processed`
  - `failed_retryable`
  - `failed_terminal`
  - `deleted`
- Placeholder records should map to `processing`, not be treated as separate save semantics.

### 4.3 Introduce a work registry

- Track long-running work by type and owner.
- Applies to:
  - LLM requests
  - screenshot processing
  - meeting post-processing
  - transcript compaction
  - embedding/indexing
  - RAG vector operations
  - STT provider lifecycle
- Each work item must support:
  - `start`
  - `cancel`
  - `cleanup`
  - `retry`
  - `finalize`

### 4.4 Introduce bounded resource policy

- Every cache/buffer/queue/subscription collection must define:
  - size limit
  - age limit if relevant
  - overflow behavior
  - cleanup behavior

### 4.5 Introduce standardized request cancellation

- All long-running LLM and processing APIs must accept `AbortSignal`.
- Superseding a request must abort the prior request upstream.

### 4.6 Introduce `HealthMonitor`

- Centralized health monitor running in the main process.
- Tracks health of:
  - Renderer process (alive, responsive)
  - Database (writable, not locked)
  - STT connections (connected, reconnecting, failed)
  - LLM API (reachable, rate-limited, down)
  - Disk space (available bytes)
  - Memory usage (heap size, external)
- Exposes health status via IPC for renderer status indicators.
- Emits alerts when any subsystem enters degraded state.

### 4.7 Introduce `CrashRecoveryManager`

- Checkpoints critical session state to durable storage every 30s during active meetings:
  - Transcript buffer
  - Meeting metadata
  - Processing state
  - Active work registry snapshot
- On startup, reconciles:
  - Meetings in `processing` → check timestamp, retry or mark `failed_retryable`
  - Orphaned checkpoints → attempt recovery or archive
  - Stale work registry entries → clean up
- Handles renderer crash by reloading window and restoring last checkpoint.

### 4.8 Introduce `CircuitBreaker`

- Shared circuit breaker utility for all external service calls.
- Configuration per service:
  - failure threshold (e.g., 5 failures)
  - reset timeout (e.g., 60s)
  - half-open probe count (e.g., 1)
- Integrates with:
  - LLM API calls (per provider)
  - STT WebSocket connections (per provider)
  - Embedding API calls
  - Ollama health probes

### 4.9 Introduce `DiskGuard`

- Monitors available disk space at configurable interval (default: 60s).
- Thresholds:
  - Warning: <1GB available → log warning, notify renderer
  - Critical: <500MB → pause non-essential background work (RAG indexing, screenshot storage)
  - Emergency: <200MB → emergency cleanup (rotate logs, prune old meeting artifacts, compact SQLite)
- Integrates with work registry to pause/resume background tasks.

### 4.10 Introduce graceful shutdown coordinator

- Registered with `app.on('before-quit')` and `app.on('will-quit')`.
- Shutdown sequence:
  1. Set global `shuttingDown` flag
  2. Cancel all non-critical work via work registry
  3. Flush active meeting checkpoint
  4. Finalize pending DB transactions
  5. Close STT connections
  6. Close database
  7. Exit
- Timeout: 10s maximum before forced exit.

---

## 5. Subsystem Specs

### 5.1 Meeting Persistence

#### Problem

- Saving the same meeting in multiple phases creates duplicate child data.

#### Required behavior

- Meeting persistence must be idempotent.
- Placeholder save and final save must update one meeting record.
- Transcript/interactions must be replaced or upserted transactionally.
- Final save must not depend on live session state.

#### Implementation requirements

- Replace ad hoc save flow with:
  - `createOrUpdateMeetingProcessingRecord(snapshot)`
  - `finalizeMeetingProcessing(meetingId, processedPayload)`
  - `markMeetingProcessingFailed(meetingId, error, retryable)`
- Persist processing state explicitly.
- Ensure delete/reset removes all derived state.

#### Acceptance

- Saving placeholder then final data for same meeting produces one canonical transcript set.
- Re-running finalization does not duplicate transcript/interactions.

### 5.2 Database Reliability

#### Problem

- DB behavior is not fully tuned for prolonged desktop use.

#### Required behavior

- SQLite must be initialized for durable, concurrent desktop usage.
- Overview queries must avoid overfetching.
- Heavy writes must not noticeably stall the app.
- Database must survive unclean shutdown.

#### Implementation requirements

- Enforce DB pragmas on startup:
  - `foreign_keys = ON`
  - `journal_mode = WAL`
  - `synchronous = NORMAL`
  - `wal_autocheckpoint = 1000` (prevent unbounded WAL growth)
  - `busy_timeout = 5000` (prevent immediate lock failures)
- Periodic integrity check: `PRAGMA integrity_check` on startup (abortable, log-only).
- Reduce hot-path sync work where possible.
- Ensure cleanup paths remove all meeting-derived artifacts (transcripts, interactions, embeddings, vector entries).
- Implement database backup before schema migrations.

#### Acceptance

- Delete/reset leaves no stale meeting-derived search/index state.
- Long save/index flows do not visibly stall the app.
- Startup after unclean shutdown does not corrupt database.
- WAL file size stays bounded during prolonged sessions.

### 5.3 Session Tracking And Compaction

#### Problem

- Transcript compaction can mutate data while other flows need stable history.

#### Required behavior

- Compaction must never race with meeting finalization/snapshotting.
- Full transcript history used for persistence must be deterministic.

#### Implementation requirements

- Serialize compaction against snapshot/final save.
- Or snapshot from an immutable copy and compact only after handoff.
- Track compaction state explicitly.

#### Acceptance

- Long meeting save after compaction produces stable, repeatable results.

### 5.4 LLM Request Lifecycle

#### Problem

- Requests can outlive user intent and continue consuming resources.

#### Required behavior

- Every LLM request must:
  - be cancellable
  - be bounded by timeout
  - clean up timers/listeners on completion
  - stop upstream when superseded
- Retry logic must be explicit and bounded.
- Circuit breaker must prevent retry storms.

#### Implementation requirements

- Thread `AbortSignal` through all LLM entry points.
- Replace logical "ignore stale response" patterns with real abort.
- Bound caches by count and TTL.
- Ensure speculative backup calls cancel losers immediately.
- Preserve provider config when switching active provider.
- Integrate circuit breaker: 5 consecutive failures → open breaker for 60s.
- Add per-request timeout: 30s for streaming start, 120s for full response.

#### Acceptance

- Starting a new request cancels prior active request cleanly.
- No stale tokens/results arrive after supersession.
- Long sessions do not show steady cache/timer growth.
- Network outage triggers circuit breaker, not retry storm.
- Breaker recovery resumes normal operation within 120s of network restore.

### 5.5 Screenshot And Background Processing

#### Problem

- Screenshot analysis and other background tasks are not fully lifecycle-managed.

#### Required behavior

- Screenshot processing must be tracked as explicit jobs.
- Cancellation must stop actual processing, not just hide the UI.
- One user action must create one processing path.

#### Implementation requirements

- Use work registry for screenshot tasks.
- Wire abort controller through image analysis and solution generation.
- Ensure duplicate listeners cannot trigger duplicate work.

#### Acceptance

- One screenshot action creates one processing job.
- Canceling processing prevents late completion events from mutating UI.

### 5.6 Renderer Request Ownership

#### Problem

- UI surfaces can create overlapping requests and duplicate subscriptions.

#### Required behavior

- One interactive surface owns one active request at a time.
- Subscriptions must be registered once and disposed predictably.
- Auto-submit behavior must be single-trigger.

#### Implementation requirements

- Refactor streaming surfaces to maintain:
  - active request id
  - active listener bundle
  - teardown-on-supersede
- Remove overlapping initial-query flows.
- Audit repeated event subscriptions.

#### Acceptance

- Opening overlay with initial query triggers exactly one request.
- Subsequent query cancels/replaces the first.
- Remounting does not multiply listeners.

### 5.7 Audio And Native Reliability

#### Problem

- Audio device/channel lifecycle can drift from expected behavior.

#### Required behavior

- Selected device must remain selected across repeated start/stop.
- Channel semantics must remain correct.
- Audio buffering must be efficient and stable under long sessions.

#### Implementation requirements

- Separate persisted config from runtime mutable state in native module.
- Stop consuming configured device id with destructive mutation.
- Preserve actual channel count unless explicitly transformed.
- Replace inefficient queue eviction structures with proper ring buffer behavior where needed.

#### Acceptance

- Repeated start/stop keeps the selected device.
- Mono stays mono logically.
- Long capture runs do not show pathological CPU/memory growth.

### 5.8 Recovery And Restart Behavior

#### Problem

- Interrupted processing can leave meetings in unclear states.

#### Required behavior

- On startup, incomplete work must be reconciled.
- Retryable work resumes or requeues.
- Terminal failures become explicit state.
- No meeting remains indefinitely `processing` without policy.

#### Implementation requirements

- Persist processing state and timestamps.
- Add startup reconciliation pass.
- Distinguish retryable from terminal failure.
- Avoid reconstructing fragile fields if canonical persisted fields are available.
- Apply timeout policy: meetings in `processing` for >10 minutes → `failed_retryable`.
- Checkpoint recovery: load latest checkpoint if available, offer recovery to user.

#### Acceptance

- Restart during processing results in explicit recovery or explicit failed state.
- No permanent ambiguous placeholder records.

### 5.9 STT Connection Resilience

#### Problem

- Each STT provider implements independent reconnection logic with inconsistent behavior.
- No circuit breaker prevents infinite reconnection under sustained outages.

#### Required behavior

- All STT providers must follow a standardized reconnection contract.
- Circuit breaker must prevent reconnection storms.
- Health state must be surfaced to main process and renderer.

#### Implementation requirements

- Extract reconnection logic into a shared `WebSocketResilience` utility:
  - Exponential backoff: base 1s, max 30s, jitter ±20%
  - Max reconnect attempts: 10 before circuit breaker trips
  - Circuit breaker reset: 120s
  - Health states: `connected`, `reconnecting`, `circuit_open`, `stopped`
- Each STT provider delegates reconnection to `WebSocketResilience`.
- Health state changes emit events consumed by `HealthMonitor`.
- Provider switch during active session must cleanly teardown old provider before starting new.

#### Acceptance

- After transient WebSocket close, STT reconnects within 10s.
- After 10 consecutive failures, circuit breaker trips and reconnection pauses.
- After circuit breaker reset, STT resumes on next audio input.
- Switching STT provider mid-session does not leak listeners or connections.

### 5.10 RAG Pipeline Reliability

#### Problem

- RAG subsystem runs significant background work (embedding generation, vector indexing, search) without lifecycle management.

#### Required behavior

- RAG operations must be tracked in the work registry.
- Embedding provider fallback must notify the user of quality changes.
- Vector indexing must be cancellable and bounded.

#### Implementation requirements

- Register `LiveRAGIndexer` batches and `VectorStore` operations in work registry.
- Add explicit cancellation path for in-flight embedding batches.
- Bound in-memory vector index size; spill to disk beyond threshold.
- Surface embedding provider fallback as user-visible notification (not just log).
- `EmbeddingPipeline.waitForReady()` must have a timeout (30s) to prevent indefinite blocking.

#### Acceptance

- Meeting stop cancels pending RAG indexing work.
- Embedding provider fallback is surfaced to user.
- Vector index memory usage stays bounded during multi-hour sessions.

### 5.11 IPC Reliability

#### Problem

- IPC channels have no timeout, no error boundaries, and can deadlock the renderer.

#### Required behavior

- IPC calls must not block the renderer indefinitely.
- Messages to destroyed windows must not throw or accumulate.
- Critical IPC paths must have error boundaries.

#### Implementation requirements

- Add IPC timeout wrapper: default 10s, configurable per channel.
- In `broadcast()`, skip destroyed windows (already partially done, audit completeness).
- Add error boundaries around IPC handler registration: a single handler crash must not prevent other handlers from running.
- Log IPC slow paths: any handler taking >1s gets a warning.
- Consider splitting `ipcHandlers.ts` into domain modules for maintainability (non-blocking).

#### Acceptance

- A hung IPC handler times out and returns an error to the renderer.
- Renderer remains responsive even if one IPC handler throws.
- No "send on destroyed WebContents" errors in logs.

### 5.12 Network Resilience

#### Problem

- Network failures cause cascading retry storms and user-visible errors.

#### Required behavior

- The app must detect online/offline state.
- All external calls must use circuit breakers and bounded retry.
- Offline state must surface to user and pause external work.

#### Implementation requirements

- Implement `NetworkMonitor`:
  - Periodic connectivity probe (lightweight HEAD request, 30s interval)
  - Electron `online`/`offline` events as secondary signal
  - Expose `isOnline` state to all subsystems
- All HTTP/WebSocket clients check `NetworkMonitor.isOnline` before initiating.
- Offline → queue non-critical work for later, surface banner in renderer.
- Online → resume queued work with staggered backoff (avoid thundering herd).

#### Acceptance

- Network loss triggers offline banner within 30s.
- No API calls attempted while offline.
- Network restore resumes STT and LLM within 60s.
- No retry storms during or after network outage.

### 5.13 Crash Recovery

#### Problem

- Renderer crashes lose all in-memory state. Main process crashes lose everything.

#### Required behavior

- Renderer crash must preserve meeting data up to last checkpoint.
- Main process must have defensive guards against termination.

#### Implementation requirements

- `CrashRecoveryManager` checkpoints to temp file every 30s during active meetings:
  - Serialized transcript buffer
  - Meeting ID, start time, duration
  - Active processing state
- On renderer `crashed` or `unresponsive` event:
  - Log crash details
  - Reload renderer
  - Restore session from checkpoint
  - Notify user of recovery
- On main process `uncaughtException`:
  - Attempt emergency checkpoint write (sync, <100ms)
  - Log full stack trace
  - Allow default crash behavior (don't swallow)
- GPU process crash handler: `app.on('gpu-process-crashed')` → log and continue.

#### Acceptance

- Renderer crash during 2-hour meeting recovers transcript within 30s of loss.
- Startup after crash restores meeting list and processing states.
- GPU crash does not terminate the app.

### 5.14 Disk Management

#### Problem

- Long-term use can exhaust disk space, causing silent failures.

#### Required behavior

- Disk usage must be monitored and bounded.
- Old artifacts must be pruned automatically.
- Low disk space must trigger protective measures.

#### Implementation requirements

- `DiskGuard` runs every 60s:
  - Check available space on app data volume
  - Enforce retention policies:
    - Logs: 10MB max, 3 rotations (already partially implemented—extend to production)
    - Screenshots: keep last 100 or 7 days, whichever is smaller
    - Meeting artifacts older than configurable retention (default 90 days): prompt for cleanup
    - SQLite WAL: force checkpoint if WAL > 100MB
  - Surface warnings to renderer at <1GB threshold
- On meeting delete, cascade to: transcript rows, interaction rows, RAG embeddings, vector entries, screenshots.

#### Acceptance

- 30-day continuous use does not exhaust disk.
- Deleting a meeting removes all derived artifacts.
- Low disk space warning appears before failures occur.

### 5.15 Production Logging

#### Problem

- Production builds have no file-level diagnostics.

#### Required behavior

- Critical events must be logged in production without performance impact.
- Log levels must be configurable.
- Logs must be rotatable and bounded.

#### Implementation requirements

- Enable `logToFile()` in production with filtered log level (default: WARN+ERROR).
- Add log levels: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`.
- Add structured fields: `timestamp`, `level`, `component`, `correlationId`.
- Extend existing log rotation to production (10MB max, 3 rotations).
- Add `CRITICAL` level for: crashes, data corruption, unrecoverable states.
- Add exportable diagnostic bundle: last 3 log files + DB integrity check + system info.

#### Acceptance

- Production crash produces actionable log file.
- Logs do not exceed 30MB total across rotations.
- User can export diagnostic bundle from settings.

---

## 6. Operational Constraints

### Memory

- All caches and buffers must have hard caps.
- Memory use during 3-hour sessions should plateau, not climb linearly.
- Target: <500MB heap after 3-hour session.

### CPU

- Audio and LLM orchestration must not create runaway background load.
- The UI must stay responsive while background processing continues.
- Target: <30% sustained CPU during active meeting (excluding user-initiated actions).

### Main Thread

- Avoid repeated sync heavy work in hot paths.
- List and polling views should not parse/load unnecessary data.
- Target: no main-thread task >50ms during active meeting.

### Disk

- Total app data (excluding user content) must stay bounded.
- WAL file must not grow beyond 100MB.
- Log files must not exceed 30MB total.
- Screenshot cache must be bounded by count and age.

### Network

- No retry loop may exceed 3 attempts without backoff.
- No circuit breaker may allow >5 failed requests before opening.
- Offline detection must trigger within 30s.
- No thundering herd on connectivity restore.

### State Consistency

- UI state must reflect true work state.
- Background completion after cancellation must not overwrite newer UI state.

---

## 7. Testing Requirements

### 7.1 Soak Tests

- 3-hour simulated meeting with:
  - continuous transcript input
  - suggestions
  - screenshot processing
  - indexing
  - intermittent provider hiccups
- Measure:
  - memory plateau (must be <5% growth after first 30min)
  - stable listener count
  - no duplicate durable state
  - UI responsiveness (<200ms p95)
  - disk usage plateau

### 7.2 Chaos Tests

- Inject:
  - model timeout
  - empty model response
  - network failure (complete outage, flapping)
  - cancel during active processing
  - repeated start/stop meeting (10x rapid cycles)
  - restart during post-processing
  - STT WebSocket kill mid-stream
  - database lock contention (concurrent writers)
- Validate:
  - no wedge states
  - no duplicate durable output
  - explicit failure/recovery transitions
  - circuit breakers engage and recover appropriately

### 7.3 Persistence Integrity Tests

- placeholder then final save
- repeated final save
- delete meeting
- clear all data
- interrupted processing recovery
- cascade delete verification (all derived artifacts)

### 7.4 Renderer Concurrency Tests

- one initial query => one request
- second request cancels first
- one screenshot => one processing path
- remount does not multiply subscriptions

### 7.5 Audio Lifecycle Tests

- selected device survives repeated lifecycle changes
- channel handling remains correct
- long capture remains stable

### 7.6 Crash Recovery Tests

- Kill renderer during active meeting → verify transcript recovery
- Kill main process during meeting save → verify startup reconciliation
- Force GPU process crash → verify app continues
- Corrupt checkpoint file → verify graceful fallback
- Startup with meetings stuck in `processing` → verify timeout policy applies

### 7.7 Network Resilience Tests

- Disable network during active meeting → verify offline detection, STT stops, LLM queues
- Restore network → verify STT reconnects, LLM resumes, no duplicate work
- Flap network (on/off every 5s for 2min) → verify no retry storms, bounded CPU
- Rate limit response from LLM → verify circuit breaker engages

### 7.8 Disk Exhaustion Tests

- Simulate <500MB available → verify non-essential work pauses
- Simulate <200MB available → verify emergency cleanup triggers
- 30-day simulated usage → verify disk usage stays bounded
- Delete meeting → verify all derived artifacts removed

---

## 8. Rollout Plan

### Phase 0: crash & data protection (highest priority)

- Crash-safe checkpointing for active meetings
- Renderer crash detection and recovery
- Graceful shutdown coordinator
- Production logging (WARN+ to file)
- Startup reconciliation for stuck meetings
- Database pragmas and integrity check

### Phase 1: correctness

- meeting snapshot
- idempotent persistence
- compaction/save race fix
- delete/reset completeness (cascade to all derived artifacts)
- explicit processing states
- audio lifecycle correctness

### Phase 2: lifecycle discipline

- request cancellation propagation
- bounded caches/timers/workers
- duplicate subscription removal
- request ownership in renderer
- IPC timeout and error boundaries
- work registry (all subsystems including RAG)

### Phase 3: resilience

- circuit breaker for LLM and STT
- standardized STT reconnection
- network monitor and offline detection
- RAG pipeline lifecycle management
- disk guard and retention policies

### Phase 4: prolonged-use hardening

- main-thread pressure reduction
- buffer/query efficiency
- soak test instrumentation
- health monitor and status indicators
- fix findings from long-run testing
- diagnostic bundle export

---

## 9. Exit Criteria

### Hard requirements (all must pass)

- No duplicate transcript/interactions under any save/retry path
- No stale jobs after cancel/supersede
- No silent device drift after repeated start/stop
- No stale indexed content after delete/reset
- No listener/timer/worker growth over prolonged use
- No persistent ambiguous processing states
- App remains responsive during real combined workflows
- Soak and chaos tests pass with no major degradation
- Renderer crash during meeting recovers transcript within 30s of loss
- Startup after crash produces clean state (no stuck meetings)
- Production builds produce actionable log files during failures
- No retry storms during network outage

### Soft requirements (target, not blocking)

- 3-hour session memory growth <5% after initial 30min plateau
- Crash recovery loses <30s of transcript data
- Offline detection within 30s of network loss
- All circuit breakers recover within 120s of service restore
- Disk usage stays bounded over 30-day simulated use

---

## 10. Critical Path Guarantees

For "critical mission" usage, the following paths have the highest reliability bar. These must be the last to degrade and the first to recover:

| Critical Path | Guarantee | Degradation Behavior |
|---|---|---|
| Meeting transcript capture | Must not lose data | Checkpoint every 30s; recover from crash |
| Meeting save/persistence | Must be idempotent | Retry from snapshot; never duplicate |
| Audio device lifecycle | Must not drift | Persist config separate from runtime state |
| Active meeting UI | Must stay responsive | Offload all heavy work; bound main-thread tasks |
| Startup recovery | Must resolve stuck state | Timeout policy; explicit failed state |

For non-critical paths (RAG indexing, screenshot analysis, conscious mode suggestions), degradation is acceptable:

| Non-Critical Path | Degradation Behavior |
|---|---|
| RAG live indexing | Pause and resume; skip if resources constrained |
| Screenshot analysis | Cancel and notify user |
| Conscious mode suggestions | Disable silently under load |
| Embedding quality | Fall back to lower quality with notification |
| Knowledge orchestrator | Skip enrichment; proceed with basic context |
