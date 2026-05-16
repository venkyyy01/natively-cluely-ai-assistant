# Production Reliability — Implementation Plan

> Spec: `docs/specs/production-reliability-spec.md`
> Updated: 2026-03-27
> Scope of this plan is intentionally limited to the approved reliability priorities:
> - data correctness
> - cancellation
> - bounded memory
> - renderer dedupe
> - audio lifecycle
> - main-thread responsiveness

---

## Plan Philosophy

This plan is intentionally trimmed.

It avoids broad infrastructure work such as circuit breakers, network monitors, disk guards,
diagnostic bundles, and generalized platform abstractions until the app's concrete reliability
failures are fixed.

The goal is to first eliminate the bugs most likely to make the app choke under real prolonged use.

---

## Wave 1: Data Correctness (Do First)

### W1-1: Database Hardening Baseline
**Touches:** `electron/db/DatabaseManager.ts`

- [ ] Add startup pragmas immediately after opening the DB:
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA journal_mode = WAL;`
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA wal_autocheckpoint = 1000;`
  - `PRAGMA busy_timeout = 5000;`
- [ ] Add lightweight startup `integrity_check(1)` logging.
- [ ] Ensure future migrations always take a migration backup before schema changes.

**Acceptance:** DB starts reliably after unclean shutdown. WAL mode is active. Foreign key cascades are real.

---

### W1-2: Idempotent Meeting Persistence
**Touches:** `electron/MeetingPersistence.ts`, `electron/db/DatabaseManager.ts`

- [ ] In `DatabaseManager.saveMeeting()`, make child persistence idempotent:
  - delete prior `transcripts` for `meeting_id`
  - delete prior `ai_interactions` for `meeting_id`
  - reinsert canonical rows inside the same transaction
- [ ] Keep `meetings` row as the canonical parent record for placeholder and final save.
- [ ] Add explicit methods:
  - `createOrUpdateMeetingProcessingRecord(snapshot)`
  - `finalizeMeetingProcessing(meetingId, processedPayload)`
  - `markMeetingProcessingFailed(meetingId, error, retryable)`
- [ ] Ensure placeholder save writes `is_processed = 0` and final save writes `is_processed = 1`.

**Acceptance:** Placeholder save followed by final save results in one canonical transcript set and one canonical interaction set.

---

### W1-3: Immutable Meeting Snapshot
**Touches:** `electron/MeetingPersistence.ts`, `electron/SessionTracker.ts`

- [ ] Define `MeetingSnapshot` interface.
- [ ] Add `SessionTracker.createSnapshot()` that deep-copies:
  - transcript
  - usage
  - start time
  - duration
  - context
  - meeting metadata
- [ ] Capture snapshot before `session.reset()`.
- [ ] Remove all reads of live `this.session` from background meeting post-processing.
- [ ] Remove post-save metadata cleanup that assumes background code still owns session state.

**Acceptance:** `processAndSaveMeeting()` runs entirely from snapshot data and never touches live session state.

---

### W1-4: Compaction / Save Race Elimination
**Touches:** `electron/SessionTracker.ts`

- [ ] Prevent transcript compaction from mutating the same data structure being snapshotted for save.
- [ ] Preferred approach:
  - `createSnapshot()` copies transcript state first
  - compaction only mutates live state after snapshot handoff
- [ ] If needed, add minimal serialization guard for compaction vs snapshot.

**Acceptance:** Long meeting finalization is stable and repeatable even if compaction is active.

---

### W1-5: Delete / Reset Completeness
**Touches:** `electron/db/DatabaseManager.ts`

- [ ] In `deleteMeeting()`, remove all meeting-derived state:
  - `embedding_queue`
  - `chunk_summaries`
  - `chunks`
  - vec rows for all known dimensions
  - parent `meetings` row
- [ ] In `clearAllData()`, clear all relational and vectorized content, not just the primary tables.
- [ ] After delete/reset, invalidate related in-memory RAG/search caches.

**Acceptance:** Deleted meetings no longer appear in retrieval, search, or derived state.

---

## Wave 2: Cancellation (Do Second)

### W2-1: Real LLM Cancellation
**Touches:** `electron/LLMHelper.ts`, `electron/IntelligenceEngine.ts`

- [ ] Thread `AbortSignal` through all major LLM request paths.
- [ ] Replace stale-response ignore behavior with actual upstream cancellation.
- [ ] Check cancellation before retries and between fallback attempts.
- [ ] Add bounded timeout policy for request start and full completion.

**Acceptance:** Starting a new request cleanly aborts the previous one. No stale tokens arrive after supersession.

---

### W2-2: Screenshot / Background Processing Cancellation
**Touches:** `electron/ProcessingHelper.ts`

- [ ] Pass `AbortSignal` into screenshot analysis and solution-generation flows.
- [ ] Cancel active screenshot/debug processing when:
  - user starts a new conflicting task
  - user closes relevant surface
  - shutdown begins
- [ ] Ensure late completions do not mutate UI after cancellation.

**Acceptance:** Cancelled screenshot or debug processing never updates state after user has moved on.

---

### W2-3: Minimal Request Ownership Model
**Touches:** critical request-producing modules only

- [ ] Do not build a fully generic platform registry yet.
- [ ] Add simple active-request ownership for:
  - intelligence answer generation
  - screenshot processing
  - renderer chat overlay
- [ ] Each owner tracks:
  - current request id
  - current abort controller
  - cleanup on replace/unmount

**Acceptance:** Critical user flows have one active request each and cleanly replace prior work.

---

## Wave 3: Bounded Memory (Do Third)

### W3-1: Bound LLM Caches
**Touches:** `electron/LLMHelper.ts`

- [ ] Add hard caps to:
  - `systemPromptCache`
  - `finalPayloadCache`
  - `responseCache`
  - `inFlightResponseCache`
- [ ] Add eviction on insert.
- [ ] Add periodic expired-entry cleanup.
- [ ] Ensure cleanup timer is stopped on shutdown.

**Acceptance:** Cache sizes plateau during long sessions.

---

### W3-2: Timer And Listener Cleanup Audit
**Touches:** `electron/LLMHelper.ts`, `electron/IntelligenceEngine.ts`, critical renderer components

- [ ] Audit `setTimeout`/`setInterval` in critical modules.
- [ ] Add matching cleanup for every timer.
- [ ] Audit event listeners and ensure they are removed on:
  - completion
  - cancellation
  - unmount
  - supersession

**Acceptance:** No monotonic growth in active timers/listeners during repeated use.

---

### W3-3: Audio Buffer Efficiency
**Touches:** STT provider implementations with large rolling buffers

- [ ] Replace O(n) eviction patterns with proper ring-buffer/head-tail behavior where needed.
- [ ] Define hard caps for buffered audio retained during reconnect/fallback situations.

**Acceptance:** Long-running capture does not show pathological GC or CPU spikes from buffer churn.

---

## Wave 4: Renderer Dedupe (Do Fourth)

### W4-1: Global Chat Overlay Deduplication
**Touches:** `src/components/GlobalChatOverlay.tsx`

- [ ] Remove overlapping initial-query auto-submit paths.
- [ ] Track one active request id.
- [ ] Abort previous request on new submit.
- [ ] Ensure one active listener bundle per request.
- [ ] Ensure all listeners are removed on unmount.

**Acceptance:** Opening overlay with initial query sends exactly one request. Rapid follow-ups do not interleave streams.

---

### W4-2: Renderer IPC Listener Audit
**Touches:** high-traffic renderer components

- [ ] Audit repeated `on()` registrations across renderer.
- [ ] Remove duplicate subscription patterns.
- [ ] Ensure cleanup functions remove every registered listener.
- [ ] Prioritize screenshot, queue, chat, and overlay surfaces.

**Acceptance:** Remounting or reopening surfaces does not multiply listeners.

---

## Wave 5: Audio Lifecycle (Do Fifth)

### W5-1: Preserve Device Identity Across Start/Stop
**Touches:** `native-module/src/lib.rs`

- [ ] Replace destructive consumption of configured device id with non-destructive access.
- [ ] Separate persisted config state from runtime capture state.

**Acceptance:** Repeated `start() -> stop() -> start()` keeps the same selected device.

---

### W5-2: Preserve Channel Semantics
**Touches:** `native-module/src/speaker/core_audio.rs`

- [ ] Stop forcing mono paths into stereo assumptions.
- [ ] Preserve actual channel count from source format/device query.
- [ ] Add regression coverage for mono and stereo paths.

**Acceptance:** Mono remains mono logically. No silent capture semantic drift.

---

## Wave 6: Main-Thread Responsiveness (Do Sixth)

### W6-1: Hot-Path Main-Thread Audit
**Touches:** `electron/db/DatabaseManager.ts`, `electron/ipcHandlers.ts`, `electron/main.ts`

- [ ] Identify sync work on hot paths during active meeting workflows.
- [ ] Prioritize:
  - meeting save
  - recent meetings queries
  - screenshot-related IPC
  - repeated logging/file operations
- [ ] Reduce or defer heavy sync work where it causes visible responsiveness loss.

**Acceptance:** No obvious UI hitching during combined meeting, screenshot, and indexing use.

---

### W6-2: Query And Batch Efficiency
**Touches:** `electron/db/DatabaseManager.ts`

- [ ] Ensure list-style queries fetch only required columns.
- [ ] Profile `saveMeeting()` for large meetings.
- [ ] If needed, batch large inserts or yield between large non-critical operations.

**Acceptance:** Large meetings do not cause noticeable UI freeze during persistence.

---

## Validation Plan

### Must-pass tests

- [ ] Placeholder save then final save => no duplicate transcript/interactions
- [ ] Re-running finalization => no duplicate durable rows
- [ ] Delete meeting => no stale indexed/searchable artifacts
- [ ] New LLM request => prior request cancelled with no stale token delivery
- [ ] Cancelled screenshot/debug processing => no late UI mutation
- [ ] Reopening/remounting renderer surfaces => no listener multiplication
- [ ] Repeated audio start/stop => selected device preserved
- [ ] Mono/stereo regression tests pass
- [ ] Long session cache sizes plateau
- [ ] Long session remains responsive during combined workflows

### Soak focus

- [ ] 3-hour simulated meeting
- [ ] continuous transcript input
- [ ] periodic suggestions
- [ ] periodic screenshot processing
- [ ] intermittent provider hiccups
- [ ] capture memory usage, active listeners, active request counts, and responsiveness

---

## Implementation Order

1. W1-1 Database Hardening Baseline
2. W1-2 Idempotent Meeting Persistence
3. W1-3 Immutable Meeting Snapshot
4. W1-4 Compaction / Save Race Elimination
5. W1-5 Delete / Reset Completeness
6. W2-1 Real LLM Cancellation
7. W2-2 Screenshot / Background Processing Cancellation
8. W3-1 Bound LLM Caches
9. W3-2 Timer And Listener Cleanup Audit
10. W4-1 Global Chat Overlay Deduplication
11. W4-2 Renderer IPC Listener Audit
12. W5-1 Preserve Device Identity Across Start/Stop
13. W5-2 Preserve Channel Semantics
14. W6-1 Hot-Path Main-Thread Audit
15. W6-2 Query And Batch Efficiency
16. W3-3 Audio Buffer Efficiency

---

## Exit Criteria

- [ ] No duplicate transcript/interactions under save/retry paths
- [ ] No stale jobs after cancel/supersede in critical flows
- [ ] No sustained listener/timer growth over prolonged use
- [ ] No stale indexed content after delete/reset
- [ ] No silent device drift after repeated start/stop
- [ ] App remains responsive during real combined workflows
- [ ] Multi-hour soak usage remains stable
