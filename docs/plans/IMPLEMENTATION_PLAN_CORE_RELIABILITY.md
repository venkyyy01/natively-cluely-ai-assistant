# Core Reliability & Accuracy Implementation Plan

> **Scope:** Performance, accuracy, and reliability fixes only. No observability, security niceties, or stealth-hardening tickets.
> **Source:** Principal audit (10-pass) + Independent verification audit (10 findings, falsification-tested).
> **Philosophy:** Every ticket must make the product actually work more correctly. No cosmetic or defensive-only changes.

---

## Priority Tiers

| Tier | Description | Tickets |
|------|-------------|--------|
| P0 | Data loss, cross-session corruption, state machine breaks | CORE-001 through CORE-007 |
| P1 | Stale data, accuracy degradation, resource leaks | CORE-008 through CORE-014 |
| P2 | Performance bottlenecks on critical paths | PERF-001 through PERF-005 |

---

## P0: Data Loss & State Corruption

### CORE-001: In-flight AI Response Leaks Into Next Meeting Session

**Severity:** HIGH
**Confirmed by:** Independent verification, confidence 92%
**Source finding:** Audit Finding 1 (verified)

#### Problem Statement

When a meeting ends while an AI response is being generated, the in-flight `whatToSay` request completes and writes its answer to the **new** session (meeting N+1) because `setSession()` swaps `this.session` without canceling the in-flight request. The `shouldSuppressVisibleWork()` guard does not check session boundaries — it only checks `stealthContainmentActive`, abort signal, and request sequence ID, none of which change during session swap.

#### Root Cause

`IntelligenceEngine.setSession()` (line 325-341) swaps the session reference but does not call `cancelActiveWhatToSay()`. The existing method `cancelActiveWhatToSay()` (line 1783-1791) was designed for exactly this purpose but is only called from `reset()`, not from `setSession()`.

#### Proposed Fix

**File:** `electron/IntelligenceEngine.ts`

In `setSession()`, add a call to `cancelActiveWhatToSay()` before swapping the session reference:

```typescript
async setSession(session: SessionTracker): Promise<void> {
  // Cancel any in-flight AI response before session swap
  this.cancelActiveWhatToSay('session-switch');
  
  this.session = session;
  // ... rest of existing code
}
```

This aborts the in-flight controller, increments `activeWhatToSayRequestId`, and ensures `shouldSuppressVisibleWork()` returns `true` for any stale callback from the old session.

#### Affected Files

- `electron/IntelligenceEngine.ts` — lines 325-341
- `electron/IntelligenceManager.ts` — lines 233-241 (caller)

#### Test Plan

1. Start a meeting, trigger an AI response (e.g., "what to say")
2. Before the response completes, end the meeting and start a new one
3. Verify the in-flight response does NOT appear in the new meeting's session
4. Verify `activeWhatToSayRequestId` was incremented (stale responses are suppressed)
5. Verify the new meeting can generate its own AI responses normally

#### Regression Risk

LOW — `cancelActiveWhatToSay()` is a well-tested method that aborts the controller and increments the sequence counter. Calling it during session swap is its intended purpose.

---

### CORE-002: Async Restore Overwrites Newer Live Transcript Data

**Severity:** MEDIUM (data loss of recent transcript segments)
**Confirmed by:** Independent verification, confidence 90%
**Source finding:** Audit Finding 2 (verified)

#### Problem Statement

`SessionTracker.restoreFromMeetingId()` performs an async DB read (`findByMeeting`). During this async gap, live `addTranscript()` calls write data to `contextItemsBuffer` and `fullTranscript`. When the restore completes, lines 1737-1751 wipe all live state (`this.fullTranscript = []`, `this.contextItemsBuffer.clear()`) and replace it with the DB snapshot from before the live writes. Transcript segments that arrived during the async gap are silently lost.

#### Root Cause

`addTranscript()` (line 295) and `addAssistantMessage()` (line 366) write directly to shared mutable state without awaiting `pendingRestorePromise`. Only `getAdaptiveContext()` (line 1109) awaits the restore.

#### Proposed Fix

**File:** `electron/SessionTracker.ts`

Add a `pendingRestorePromise` await at the top of both write methods:

```typescript
async addTranscript(segment: TranscriptSegment): Promise<ContextItem | null> {
  // Wait for any in-flight restore to complete before writing
  if (this.pendingRestorePromise) {
    await this.pendingRestorePromise;
  }
  
  if (!segment.final) return null;
  // ... existing code
}

async addAssistantMessage(content: string, role: string = 'assistant', metadata?: Record<string, unknown>): Promise<void> {
  // Wait for any in-flight restore to complete before writing
  if (this.pendingRestorePromise) {
    await this.pendingRestorePromise;
  }
  
  // ... existing code
}
```

Alternatively, use a write gate that queues writes during restore:

```typescript
private writeQueue: Array<() => Promise<void>> = [];
private isRestoring = false;

private async gateWrite<T>(fn: () => Promise<T>): Promise<T> {
  if (this.isRestoring) {
    return new Promise<T>((resolve, reject) => {
      this.writeQueue.push(async () => {
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
    });
  }
  return fn();
}
```

The simpler approach (await `pendingRestorePromise`) is preferred because it adds minimal latency (the restore promise resolves quickly after the DB read completes) and is easier to reason about.

#### Affected Files

- `electron/SessionTracker.ts` — lines 295-361, 366-432

#### Test Plan

1. Start a meeting with existing persisted data
2. Simulate a reconnect that triggers `restoreFromMeetingId()`
3. During the async gap, inject transcript segments via `addTranscript()`
4. Verify that all live segments appear in the transcript after restore completes
5. Verify that persisted data from the DB is also present
6. Verify that no segments are lost (compare count of expected vs actual)

#### Regression Risk

LOW — Adding an await only delays writes until the restore completes. The restore is typically fast (DB read + parse). Worst case: slight delay in transcript processing during reconnection.

---

### CORE-003: Meeting Lifecycle State Not Synced to Renderer

**Severity:** HIGH (unrecoverable state after renderer crash)
**Confirmed by:** Principal audit Finding D7
**Source finding:** Original audit, not independently challenged

#### Problem Statement

`meetingLifecycleState` transitions (`starting`, `active`, `stopping`, `idle`) happen only on the main thread. The renderer process has no mechanism to query or receive these transitions. If the renderer crashes or reloads during an active meeting, it shows "idle" while STT and AI continue running on the main process.

#### Root Cause

No IPC event broadcast for lifecycle state changes. The renderer only receives `meeting-started` and `meeting-stopped` events, but not `starting` or `stopping` transitions.

#### Proposed Fix

**File:** `electron/ipc/registerMeetingHandlers.ts` (or wherever meeting IPC is registered)

Add a new IPC event for lifecycle state changes:

```typescript
// In the meeting start flow (after this.appState.meetingLifecycleState = 'starting'):
mainWindow.webContents.send('meeting-lifecycle-state', this.appState.meetingLifecycleState);

// In endMeeting (after this.appState.meetingLifecycleState = 'stopping'):
mainWindow.webContents.send('meeting-lifecycle-state', this.appState.meetingLifecycleState);

// In the stop callback (after this.appState.meetingLifecycleState = 'idle'):
mainWindow.webContents.send('meeting-lifecycle-state', this.appState.meetingLifecycleState);
```

**File:** `src/types/electron.d.ts`

Add to `ElectronAPI` interface:

```typescript
onMeetingLifecycleState: (callback: (state: 'idle' | 'starting' | 'active' | 'stopping') => void) => () => void;
getMeetingLifecycleState: () => Promise<'idle' | 'starting' | 'active' | 'stopping'>;
```

**File:** `src/components/NativelyInterface.tsx`

Add a `useEffect` that subscribes to the lifecycle state event and queries current state on mount:

```typescript
useEffect(() => {
  const fetchCurrentState = async () => {
    const state = await window.electronAPI.getMeetingLifecycleState();
    setMeetingLifecycleState(state);
  };
  fetchCurrentState();
  
  const unsub = window.electronAPI.onMeetingLifecycleState((state) => {
    setMeetingLifecycleState(state);
  });
  return () => { unsub(); };
}, []);
```

Use `meetingLifecycleState` to show correct UI state (loading spinner during `starting`, active UI during `active`, shutting down during `stopping`).

#### Affected Files

- `main.js` — broadcast lifecycle state transitions
- `electron/ipc/registerMeetingHandlers.ts` — add new IPC handlers
- `src/types/electron.d.ts` — add type definitions
- `src/components/NativelyInterface.tsx` — subscribe to lifecycle state

#### Test Plan

1. Start a meeting — verify renderer shows `starting` then `active`
2. End a meeting — verify renderer shows `stopping` then `idle`
3. Crash the renderer process during an active meeting (DevTools → crash)
4. Reload the renderer — verify it queries and displays `active` state
5. End the meeting from the recovered renderer — verify it works correctly

#### Regression Risk

LOW — Adding a new IPC event is additive. Existing `meeting-started` and `meeting-stopped` events continue to work.

---

### CORE-004: Audio Recovery Retries Overlap and Destroy Healthy Pipeline

**Severity:** MEDIUM (transient DoS, self-healing)
**Confirmed by:** Independent verification, confidence 88%
**Source finding:** Audit Finding 4 (verified)

#### Problem Statement

Two concurrent `handleAudioCaptureError()` calls can both enter the recovery path. Each calls `reconfigureAudio()`, which destroys BOTH audio pipelines (system + microphone) regardless of which source had the error. The second call tears down the pipeline that the first call just rebuilt.

#### Root Cause

No mutex, lock, or `isReconfiguring` flag in `handleAudioCaptureError()` or `reconfigureAudio()`. The shared `audioRecoveryAttempts` counter provides rate-limiting but not exclusion.

#### Proposed Fix

**File:** `electron/main.ts` (or the file containing `handleAudioCaptureError`)

Add a re-entrancy guard:

```typescript
private isReconfiguringAudio = false;

private async handleAudioCaptureError(source: 'system' | 'microphone', error: Error): Promise<void> {
  if (this.isReconfiguringAudio) {
    // Another recovery is in progress; skip this one
    return;
  }
  
  this.audioRecoveryAttempts++;
  if (this.audioRecoveryAttempts > MAX_AUDIO_RECOVERY_ATTEMPTS) {
    // ... existing max attempts logic
    return;
  }

  this.isReconfiguringAudio = true;
  try {
    await this.delay(AUDIO_RECOVERY_BACKOFF_BASE_MS * Math.pow(2, this.audioRecoveryAttempts - 1));
    if (!this.isMeetingActive) return;
    await this.reconfigureAudio();
  } finally {
    this.isReconfiguringAudio = false;
  }
}
```

This ensures only one recovery attempt runs at a time. A second error handler that fires during recovery will skip its attempt entirely, relying on the first recovery to fix both pipelines.

#### Affected Files

- `electron/main.ts` — lines 1442-1480, 1662-1791

#### Test Plan

1. Simulate simultaneous errors on both system audio and microphone
2. Verify only one `reconfigureAudio()` call executes
3. Verify both pipelines are rebuilt after the single recovery
4. Verify the skipped error handler does not increment `audioRecoveryAttempts` beyond the limit

#### Regression Risk

LOW — The guard only prevents concurrent recoveries. Sequential recoveries (after the first completes) still work normally. The only risk is if the first recovery fails to fix the second source's issue, but `reconfigureAudio()` already rebuilds both pipelines.

---

### CORE-005: FlushScheduledSave Misses In-Flight Save

**Severity:** MEDIUM (data loss on process exit)
**Confirmed by:** Independent verification, confidence 92%
**Source finding:** Audit Finding 8 (verified)

#### Problem Statement

`SessionPersistence.scheduleSave()` uses `void this.save(snapshot)` (fire-and-forget) when the 2-second timeout fires. If `flushScheduledSave()` is called after the timeout fires but before the save completes, it finds both `saveTimeout` and `pendingSession` null, and returns immediately without awaiting the in-flight save. Data is lost if the process exits during this window.

#### Root Cause

No `inFlightSave` promise is tracked. The analogous `MeetingPersistence` class correctly tracks in-flight saves with a `pendingSaves` Set.

#### Proposed Fix

**File:** `electron/memory/SessionPersistence.ts`

```typescript
export class SessionPersistence {
  private saveTimeout: NodeJS.Timeout | null = null;
  private pendingSession: PersistedSession | null = null;
  private inFlightSave: Promise<void> = Promise.resolve(); // ADD THIS
  private readonly sessionsDir: string;
  private readonly indexFile: string;

  // ... constructor unchanged ...

  scheduleSave(session: PersistedSession): void {
    this.pendingSession = session;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      const snapshot = this.pendingSession;
      this.saveTimeout = null;
      this.pendingSession = null;
      if (!snapshot) return;

      this.inFlightSave = this.save(snapshot).catch((error) => {
        console.warn('[SessionPersistence] Scheduled save failed:', error);
      });
    }, 2000);
  }

  async flushScheduledSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    const snapshot = this.pendingSession;
    this.pendingSession = null;

    // Await any in-flight save first
    await this.inFlightSave;

    if (!snapshot) return;
    await this.save(snapshot);
  }
}
```

The key change: track `inFlightSave` as a promise field. When the timeout fires, assign the save promise to `inFlightSave`. In `flushScheduledSave()`, await `inFlightSave` before processing the pending session.

#### Affected Files

- `electron/memory/SessionPersistence.ts` — lines 156-184
- `electron/SessionTracker.ts` — line 1796-1799 (caller `flushPersistenceNow()`)

#### Test Plan

1. Call `scheduleSave(sessionA)`
2. Wait for the 2-second timeout to fire (save starts)
3. Immediately call `flushScheduledSave()`
4. Verify that `flushScheduledSave()` waits for the in-flight save to complete
5. Kill the process after `flushScheduledSave()` returns
6. Verify that the session data is present and correct on disk

#### Regression Risk

LOW — The fix only adds a promise await. The `inFlightSave` field defaults to `Promise.resolve()`, so the `await` is a no-op when no save is in flight.

---

### CORE-006: Session Reset Doesn't Clear Streaming State

**Severity:** MEDIUM (ghost messages after session reset)
**Confirmed by:** Principal audit + renderer audit

#### Problem Statement

When `onSessionReset` fires, the handler clears messages and state but does NOT clear `activeIntelligenceStreamingIdsRef`, `activeGeminiStreamingIdRef`, or `activeRagStreamingIdRef`. If streaming tokens arrive after the reset event, they create ghost messages with stale IDs.

#### Proposed Fix

**File:** `src/components/NativelyInterface.tsx`

In the `onSessionReset` handler (around line 377-404), add cleanup for streaming refs:

```typescript
const unsubscribe = window.electronAPI.onSessionReset(() => {
  setMessages([]);
  setInputValue('');
  setAttachedContext([]);
  
  // Clear all streaming state
  activeIntelligenceStreamingIdsRef.current.clear();
  activeGeminiStreamingIdRef.current = null;
  activeRagStreamingIdRef.current = null;
  activeRagStreamingIdRef.current = null;
  
  isRecordingRef.current = false;
  manualFinalizeInFlightRef.current = false;
  // ... rest of existing resets
});
```

#### Affected Files

- `src/components/NativelyInterface.tsx` — lines 377-404

#### Test Plan

1. Start a meeting, trigger an AI response
2. During streaming, trigger a session reset
3. Verify no ghost messages appear after reset
4. Verify the new session starts clean

#### Regression Risk

MINIMAL — Clearing refs on reset is the intended behavior. These refs are initialized to their default values (empty set, null) on component mount, so resetting them to those values is correct.

---

### CORE-007: PromptCompiler Cache Serves Stale Context

**Severity:** MEDIUM (accuracy degradation)
**Confirmed by:** Independent verification (falsification pass confirmed this is a real bug)
**Source finding:** Audit Finding D9 (verified)

#### Problem Statement

`PromptCompiler.getCacheKey()` uses `${provider}:${phase}:${mode}` as the cache key, but `assemble()` appends `contextSnapshot.activeThread` and `contextSnapshot.recentTopics` to the prompt. A cached prompt from a different conversation context will contain stale `activeThread` and `recentTopics` for up to 5 minutes (the cache TTL).

#### Root Cause

Cache key does not include a hash of the context snapshot.

#### Proposed Fix

**File:** `electron/llm/PromptCompiler.ts`

```typescript
private getCacheKey(options: PromptOptions): string {
  const contextHash = options.contextSnapshot
    ? this.hashContext(options.contextSnapshot)
    : 'no-context';
  return `${options.provider}:${options.phase}:${options.mode}:${contextHash}`;
}

private hashContext(snapshot: NonNullable<PromptOptions['contextSnapshot']>): string {
  // Quick hash of the context constituents
  const thread = snapshot.activeThread || '';
  const topics = snapshot.recentTopics?.join(',') || '';
  // Simple string hash to avoid crypto overhead
  let hash = 0;
  const str = `${thread}::${topics}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
```

This ensures prompts with different context snapshots get different cache keys, preventing stale context from being served.

#### Affected Files

- `electron/llm/PromptCompiler.ts` — lines 57-70

#### Test Plan

1. Start a meeting, ask a question about topic A
2. Wait for the 5-minute cache TTL within the same provider/phase/mode
3. Ask a question about topic B
4. Verify the AI response references topic B, not topic A
5. Verify cache hits still work for the same topic (no regression)

#### Regression Risk

LOW — Adding context to the cache key makes it more specific, which means more cache misses but more accurate prompts. The trade-off is correct: accuracy over cache hit rate.

---

## P1: Stale Data, Accuracy & Resource Leak

### CORE-008: Native Stealth Re-Arms After Explicit Disable

**Severity:** HIGH (stealth violation, but classified as reliability since it's a state machine bug)
**Confirmed by:** Independent verification, confidence 95%
**Source finding:** Audit Finding 6 (verified)

#### Problem Statement

`fault()` clears session IDs and resets the restart counter but does NOT clear `lastArmRequest`. An in-flight `tryRestartAfterDisconnect()` that is awaiting its backoff delay will use the preserved `lastArmRequest` to re-arm the stealth system after `fault()` was called.

#### Proposed Fix

**File:** `electron/stealth/NativeStealthBridge.ts`

Add `this.lastArmRequest = null;` to the `fault()` method, and add a post-backoff guard to `tryRestartAfterDisconnect()`:

```typescript
async fault(reason: string): Promise<void> {
  const client = this.ensureClient();
  const sessionId = this.activeSessionId;
  this.activeSessionId = null;
  this.activeSurfaceId = null;
  this.restartAttemptsForActiveSession = 0;
  this.lastDisconnectReason = null;
  this.lastArmRequest = null;  // ADD THIS LINE

  // ... rest of existing code
}

private async tryRestartAfterDisconnect(reason: string): Promise<boolean> {
  if (this.restartAttemptsForActiveSession >= this.maxRestartAttempts || !this.lastArmRequest) {
    return false;
  }

  this.restartAttemptsForActiveSession += 1;
  const restartAttempt = this.restartAttemptsForActiveSession;
  const backoffMs = this.restartBackoffBaseMs * Math.max(1, 2 ** (restartAttempt - 1));

  try {
    await this.waitForRestartBackoff(backoffMs);
    
    // Post-backoff guard: check if fault() was called during the backoff
    if (this.activeSessionId === null && this.lastArmRequest === null) {
      // fault() was called during the backoff; abort restart
      return false;
    }
    
    const restarted = await this.arm(this.lastArmRequest);
    return restarted.connected;
  } catch (error) {
    this.logger.warn(`[NativeStealthBridge] Restart attempt after ${reason} failed:`, error);
    return false;
  }
}
```

#### Affected Files

- `electron/stealth/NativeStealthBridge.ts` — lines 289-296, 401-418

#### Test Plan

1. Arm native stealth
2. Simulate a disconnect that triggers `tryRestartAfterDisconnect()`
3. During the backoff delay, call `fault('user-disabled')`
4. Verify that the restart does NOT proceed after the backoff
5. Verify `activeSessionId` remains null

#### Regression Risk

LOW — Adding `this.lastArmRequest = null` to `fault()` prevents the backoff from finding a request to use. The post-backoff guard is an additional safety net.

---

### CORE-009: Rapid Undetectable Toggles Drop Latest User Intent

**Severity:** MEDIUM-HIGH
**Confirmed by:** Independent verification, confidence 88%
**Source finding:** Audit Finding 9 (verified)

#### Problem Statement

`setUndetectableAsync()` compares `this.isUndetectable === state` (applied state) before two `await` points. During the async gap, a second toggle sees the old applied state and incorrectly returns early (`no change needed`), dropping the user's most recent intent.

#### Proposed Fix

**File:** `electron/main.ts` (or the file containing `setUndetectableAsync`, around line 2873)

Add a `pendingUndetectableState` field that is set immediately (before any `await`) and checked by the guard:

```typescript
private pendingUndetectableState: boolean | null = null;

async setUndetectableAsync(state: boolean): Promise<void> {
  // Check against BOTH applied and pending state to prevent TOCTOU
  if (this.isUndetectable === state || this.pendingUndetectableState === state) {
    return;
  }

  this.pendingUndetectableState = state;

  const stealthSupervisor = this.runtimeCoordinator.getSupervisor<StealthSupervisor>('stealth');
  if (stealthSupervisor.getState() === 'idle') {
    await stealthSupervisor.start();
  }
  await stealthSupervisor.setEnabled(state);

  this.pendingUndetectableState = null;
  this.applyUndetectableState(state, startedAt, { runtime: 'coordinator' });
}
```

This ensures that during the async gap, a second call with the same intent returns early (correct), and a second call with the opposite intent sees the pending state and proceeds (correct).

#### Affected Files

- `electron/main.ts` — lines 2873-2889

#### Test Plan

1. Toggle stealth ON
2. Immediately toggle stealth OFF (within the async window)
3. Toggle stealth ON again
4. Verify the final state is ON (the user's last intent)
5. Test rapid toggling: ON-OFF-ON-OFF — verify final state is OFF

#### Regression Risk

LOW — The `pendingUndetectableState` field is only used for the guard check. It does not affect the applied state or any other component.

---

### CORE-010: Live RAG Queries Not Cancelable

**Severity:** MEDIUM (resource waste, inability to cancel)
**Confirmed by:** Independent verification, confidence 98%
**Source finding:** Audit Finding 10 (verified)

#### Problem Statement

Live RAG queries use `'live-${Date.now()}'` as their `activeRAGQueries` map key, but the cancel handler constructs keys as `'meeting-${meetingId}'` or `'global'`. The `'live-'` prefix never matches any cancel key. The public API type has no `live` option.

#### Proposed Fix

**File:** `electron/ipc/registerRagHandlers.ts`

Add live query cancellation to the cancel handler:

```typescript
ipcMain.handle('rag:cancel-query', (_event, options: { meetingId?: string; global?: boolean; live?: boolean }) => {
  const { meetingId, global, live } = options;
  let cancelledCount = 0;

  for (const [key, controller] of activeRAGQueries) {
    let shouldCancel = false;
    
    if (meetingId && key.startsWith(`meeting-${meetingId}`)) {
      shouldCancel = true;
    }
    if (global && key.startsWith('global')) {
      shouldCancel = true;
    }
    if (live && key.startsWith('live')) {
      shouldCancel = true;
    }
    
    if (shouldCancel) {
      controller.abort();
      activeRAGQueries.delete(key);
      cancelledCount++;
    }
  }

  return { status: 'ok', cancelled: cancelledCount };
});
```

**File:** `src/types/electron.d.ts`

Add `live` option to the cancel API:

```typescript
ragCancelQuery: (options: { meetingId?: string; global?: boolean; live?: boolean }) => Promise<StatusResult>
```

**File:** `src/components/NativelyInterface.tsx` (or wherever live RAG queries are initiated)

Add cancellation on session reset or meeting end:

```typescript
// In onSessionReset handler:
window.electronAPI.ragCancelQuery({ live: true });
```

Also add a `streamId` field to RAG live stream events for client-side correlation:

```typescript
// In the live query streaming section:
event.sender.send('rag:stream-chunk', { live: true, streamId: queryKey, chunk });
event.sender.send('rag:stream-done', { live: true, streamId: queryKey });
event.sender.send('rag:stream-error', { live: true, streamId: queryKey, error: '...' });
```

#### Affected Files

- `electron/ipc/registerRagHandlers.ts` — lines 95-103, 150-157
- `src/types/electron.d.ts` — line 279-283
- `src/components/NativelyInterface.tsx` — live query handling

#### Test Plan

1. Start a live RAG query
2. Call `ragCancelQuery({ live: true })` before the query completes
3. Verify the query is aborted and no more stream events arrive
4. Start a live RAG query, then end the meeting
5. Verify the query is cancelled as part of meeting cleanup

#### Regression Risk

LOW — Adding a new cancel option is additive. Existing meeting and global cancel paths continue to work.

---

### CORE-011: QualityLane Provider Calls Not Cancelled on Timeout

**Severity:** MEDIUM (resource waste, leaked network calls)
**Confirmed by:** Principal audit Finding D8

#### Problem Statement

`QualityLane` uses `Promise.race([provider, timeout])` which returns `null` on timeout but does NOT cancel the provider call. The timed-out call continues consuming API quota and network resources.

#### Proposed Fix

**File:** `electron/inference/QualityLane.ts`

Use `AbortController` to cancel timed-out provider calls:

```typescript
async run(request: QualityRequest): Promise<QualityResult | null> {
  for (const provider of this.providers) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), this.timeoutMs);
    
    try {
      const output = await this.runProvider(provider, request, abortController.signal);
      clearTimeout(timeoutId);
      
      if (output && output.text.length >= this.minLength) {
        if (this.verifyDraft) {
          const verdict = await this.verifyDraft(output, request);
          if (verdict.accepted) return output;
        } else {
          return output;
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      // Request was aborted or provider failed — try next provider
    } finally {
      // Ensure abort controller is cleaned up
    }
  }
  return null;
}

private async runProvider(
  provider: QualityProvider,
  request: QualityRequest,
  signal: AbortSignal
): Promise<QualityResult | null> {
  // Pass signal to the provider call so it can abort the network request
  return provider.generate(request, { signal });
}
```

This requires updating `QualityProvider.generate()` to accept an optional `AbortSignal` and passing it through to the underlying HTTP request (e.g., `AbortSignal.timeout()` on `fetch` or `axios`).

#### Affected Files

- `electron/inference/QualityLane.ts` — lines 31-33
- `electron/LLMHelper.ts` — all provider methods need to accept and forward `AbortSignal`
- Provider interface definitions

#### Test Plan

1. Configure a QualityLane with a 2-second timeout
2. Send a request to a slow provider (>2s response time)
3. Verify the provider call is cancelled after 2 seconds
4. Verify no network resources are leaked (check no hanging connections)

#### Regression Risk

MEDIUM — Provider methods need to be updated to accept and forward `AbortSignal`. This is a wider change that touches multiple provider implementations. Ensure all providers handle `AbortError` gracefully.

---

### CORE-012: WarmStandbyManager Race on Shared Resources

**Severity:** MEDIUM (resource leak, state inconsistency)
**Confirmed by:** Independent verification, confidence 90%
**Source finding:** Audit Finding 7 (verified)

#### Problem Statement

`warmUp()`, `coolDown()`, and `invalidate*()` methods are async and operate on shared mutable state (`audioResource`, `sttResource`, `workerPoolResource`, `state`) with no synchronization. Concurrent calls can overlap, causing double-warm (resource leak) or state inconsistency.

#### Proposed Fix

**File:** `electron/runtime/WarmStandbyManager.ts`

Add a `lifecyclePromise` chain that serializes all lifecycle operations:

```typescript
export class WarmStandbyManager<...> {
  // ... existing fields ...
  private lifecyclePromise: Promise<void> = Promise.resolve();

  async warmUp(): Promise<WarmStandbyHealth> {
    return this.enqueueLifecycle(async () => {
      const shouldWarmMissingWorkerPool = !this.deferredBackgroundWarmup && this.workerPoolHandler && this.workerPoolResource === null;
      if ((this.state === 'ready' || this.state === 'bound') && !shouldWarmMissingWorkerPool) {
        return this.getHealth();
      }
  
      this.state = 'warming';
      this.lastError = null;
  
      try {
        if (this.audioHandler && this.audioResource === null) {
          this.audioResource = await this.audioHandler.warmUp();
        }
        if (this.sttHandler && this.sttResource === null) {
          this.sttResource = await this.sttHandler.warmUp();
        }
        if (!this.deferredBackgroundWarmup && this.workerPoolHandler && this.workerPoolResource === null) {
          this.workerPoolResource = await this.workerPoolHandler.warmUp();
        }
  
        this.state = this.activeMeetingId ? 'bound' : 'ready';
        return this.getHealth();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.state = 'faulted';
        await this.coolDownPartiallyWarmedResources();
        throw error;
      }
    });
  }

  async coolDown(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.state = 'cooling';
      this.activeMeetingId = null;
      this.lastError = null;
  
      await this.coolDownResource(this.workerPoolHandler, this.workerPoolResource);
      this.workerPoolResource = null;
      await this.coolDownResource(this.sttHandler, this.sttResource);
      this.sttResource = null;
      await this.coolDownResource(this.audioHandler, this.audioResource);
      this.audioResource = null;
  
      this.state = 'idle';
    });
  }

  async invalidateAudioResource(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.coolDownResource(this.audioHandler, this.audioResource);
      this.audioResource = null;
      this.state = this.hasAnyWarmResources() ? 'ready' : 'idle';
    });
  }

  // ... similarly for invalidateSttResource and invalidateWorkerPoolResource

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    this.lifecyclePromise = this.lifecyclePromise.then(operation, operation);
    // Return the result of the operation, not the chain
    // This is tricky — we need to return the operation's result
    // Use a different approach:
    let resolve: (value: T) => void;
    let reject: (reason: unknown) => void;
    const resultPromise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    
    this.lifecyclePromise = this.lifecyclePromise.then(
      () => operation().then(resolve!, reject!),
      () => operation().then(resolve!, reject!)
    );
    
    return resultPromise;
  }
}
```

#### Affected Files

- `electron/runtime/WarmStandbyManager.ts` — entire file

#### Test Plan

1. Call `warmUp()` and `coolDown()` concurrently
2. Verify that they execute sequentially (no overlap)
3. Verify that resources are properly cleaned up (no leaked warm-up resources)
4. Verify that `state` is consistent after concurrent operations

#### Regression Risk

MEDIUM — The serialization changes the timing of lifecycle operations. Previously concurrent operations now execute sequentially, which may increase overall warm-up/cool-down time. This is an acceptable trade-off for correctness.

---

### CORE-013: Meeting Finalization Data Integrity Guard

**Severity:** MEDIUM (design smell with no practical reproduction path)
**Confirmed by:** PLAUSIBLE BUT UNPROVEN, but defensive fix recommended
**Source finding:** Audit Finding 3 (verified as plausible)

#### Problem Statement

`createOrUpdateMeetingProcessingRecord()` forcibly sets `isProcessed: false` and uses `INSERT OR REPLACE` without checking the current `is_processed` state. While temporal ordering prevents regression under current code paths, no defensive guard exists.

#### Proposed Fix

**File:** `electron/db/DatabaseManager.ts`

Change `createOrUpdateMeetingProcessingRecord()` to use a conditional update instead of blind `INSERT OR REPLACE`:

```typescript
createOrUpdateMeetingProcessingRecord(meeting: Meeting): void {
  const existing = this.getMeetingById(meeting.id);
  
  if (existing && existing.isProcessed) {
    // Don't overwrite a finalized meeting record with provisional data
    console.warn(`[DatabaseManager] Skipping overwrite of finalized meeting ${meeting.id}`);
    return;
  }
  
  // ... existing INSERT OR REPLACE logic
}
```

Alternatively, add a `WHERE is_processed = 0` condition to the SQL:

```sql
INSERT INTO meetings (id, title, ...is_processed...)
VALUES (?, ?, ...0...)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  ...,
  is_processed = CASE WHEN meetings.is_processed = 0 THEN 0 ELSE meetings.is_processed END,
  ...
```

The CASE WHEN approach preserves `is_processed` if it's already `true`.

#### Affected Files

- `electron/db/DatabaseManager.ts` — lines 774-785

#### Test Plan

1. Start a meeting, let the checkpointer create a provisional record (`isProcessed: false`)
2. End the meeting, let finalization set `isProcessed: true`
3. Simulate a checkpointer run on the finalized meeting
4. Verify the finalized record is NOT overwritten back to `isProcessed: false`

#### Regression Risk

LOW — The change only prevents downgrades from `true` to `false`. All other upsert behavior is preserved.

---

### CORE-014: AnswerLatencyTracker Snapshots Never Evicted

**Severity:** LOW (slow memory leak)
**Confirmed by:** Principal audit

#### Problem Statement

`AnswerLatencyTracker.snapshots` Map adds entries per AI interaction but never removes them. Over a long meeting, this grows unboundedly.

#### Proposed Fix

**File:** `electron/latency/AnswerLatencyTracker.ts`

Add a max size to the snapshots map and evict oldest entries:

```typescript
private readonly MAX_SNAPSHOTS = 100;

private evictOldSnapshots(): void {
  while (this.snapshots.size > this.MAX_SNAPSHOTS) {
    const oldestKey = this.snapshots.keys().next().value;
    if (oldestKey) this.snapshots.delete(oldestKey);
  }
}

// Call evictOldSnapshots() after each add
```

#### Test Plan

1. Generate 150 AI interactions in a single meeting
2. Verify that only the last 100 snapshots are retained
3. Verify memory usage does not grow unboundedly

---

## P2: Performance

### PERF-001: ResizeObserver IPC Debounce

**Severity:** LOW-MEDIUM (UI jank)
**Source:** Renderer audit

#### Problem Statement

`NativelyInterface.tsx` lines 272-293 call `window.electronAPI?.updateContentDimensions()` on every `ResizeObserver` callback without debounce, causing hundreds of IPC calls per second during window resize.

#### Proposed Fix

**File:** `src/components/NativelyInterface.tsx`

```typescript
const resizeDebounceRef = useRef<NodeJS.Timeout | null>(null);

useEffect(() => {
  if (!containerRef.current) return;
  const observer = new ResizeObserver((entries) => {
    if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
    resizeDebounceRef.current = setTimeout(() => {
      for (const entry of entries) {
        window.electronAPI?.updateContentDimensions?.({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    }, 16); // ~1 frame at 60fps
  });
  observer.observe(containerRef.current);
  return () => observer.disconnect();
}, [/* deps */]);
```

#### Affected Files

- `src/components/NativelyInterface.tsx` — lines 272-293

---

### PERF-002: Transcript Array shift() O(n)

**Severity:** LOW (performance degradation on long meetings)
**Source:** Audio pipeline audit

#### Problem Statement

`SessionTracker.fullTranscript` uses `Array.shift()` to remove entries when `MAX_TRANSCRIPT_ENTRIES` is exceeded. `shift()` is O(n) and is called frequently on arrays that can reach 5000 entries.

#### Proposed Fix

**File:** `electron/SessionTracker.ts`

Replace `fullTranscript` array with a `RingBuffer<TranscriptSegment>` (the same class already used for `contextItemsBuffer`):

```typescript
private fullTranscript = new RingBuffer<TranscriptSegment>(MAX_TRANSCRIPT_ENTRIES);
```

Add a `toArray()` method for consumers that need an array:

```typescript
getTranscript(): TranscriptSegment[] {
  return this.fullTranscript.toArray();
}
```

#### Affected Files

- `electron/SessionTracker.ts` — lines 350-352, 409-411, and all usages of `fullTranscript`

---

### PERF-003: Conversation Context Recomputation on Every Token

**Severity:** MEDIUM (unnecessary renders during streaming)
**Source:** Renderer audit

#### Problem Statement

`conversationContext` is recalculated on every message update (including streaming tokens) with no memoization. The `useEffect` at lines 337-344 depends on `[messages]` and processes all messages on each update.

#### Proposed Fix

**File:** `src/components/NativelyInterface.tsx`

```typescript
const conversationContext = useMemo(() => {
  return messages
    .filter(m => m.role !== 'user' || !m.hasScreenshot)
    .map(m => `${m.role === 'interviewer' ? 'Interviewer' : 'Assistant'}: ${m.content}`)
    .slice(-20)
    .join('\n');
}, [messages]);
```

Replace the `useEffect` + `useState` pair with `useMemo` to avoid the extra state update and re-render cycle.

#### Affected Files

- `src/components/NativelyInterface.tsx` — lines 337-344

---

### PERF-004: Deepgram hasNonSilentAudio O(n) Per Chunk

**Severity:** LOW (unnecessary CPU on audio path)
**Source:** Audio pipeline audit

#### Problem Statement

`DeepgramStreamingSTT.hasNonSilentAudio()` iterates every 2-byte sample in a chunk. With 48kHz stereo 20ms chunks, that's ~1920 comparisons per chunk. Called on every `write()`.

#### Proposed Fix

**File:** `electron/audio/DeepgramStreamingSTT.ts`

Sample every Nth byte instead of every byte:

```typescript
private hasNonSilentAudio(chunk: Buffer): boolean {
  const step = 20; // Check every 20th sample
  for (let i = 0; i < chunk.length; i += 2 * step) {
    if (chunk.readInt16LE(i) !== 0) return true;
  }
  return false;
}
```

This matches the approach used in `OpenAIStreamingSTT._isSilent()` and `RestSTT`.

#### Affected Files

- `electron/audio/DeepgramStreamingSTT.ts` — lines 499-506

---

### PERF-005: PredictivePrefetcher BM25 Cache Unbounded

**Severity:** LOW (slow memory leak over long meetings)
**Source:** LLM/memory audit

#### Problem Statement

`PredictivePrefetcher.bm25Cache` grows with each unique query/transcript combination and is only cleared on transcript revision change.

#### Proposed Fix

**File:** `electron/prefetch/PredictivePrefetcher.ts`

Add an LRU eviction with a max size:

```typescript
private readonly MAX_BM25_CACHE_SIZE = 50;

private evictBm25Cache(): void {
  while (this.bm25Cache.size > this.MAX_BM25_CACHE_SIZE) {
    const oldestKey = this.bm25Cache.keys().next().value;
    if (oldestKey) this.bm25Cache.delete(oldestKey);
  }
}
```

Call `evictBm25Cache()` after each cache insertion.

#### Affected Files

- `electron/prefetch/PredictivePrefetcher.ts` — line 92

---

## Implementation Order

```
Week 1: CORE-001, CORE-002, CORE-005 (data loss fixes — most critical)
Week 1: CORE-004 (audio recovery mutex — prevents pipeline destruction)
Week 2: CORE-003 (meeting lifecycle state sync — renderer recovery)
Week 2: CORE-007 (prompt cache key fix — accuracy)
Week 2: CORE-008 (stealth re-arm — state machine fix)
Week 2: CORE-009 (toggle TOCTOU — state machine fix)
Week 2: CORE-010 (RAG cancel key mismatch — functional bug)
Week 3: CORE-006 (session reset streaming cleanup)
Week 3: CORE-011 (QualityLane abort controller)
Week 3: CORE-012 (WarmStandbyManager serialization)
Week 3: CORE-013 (meeting finalization guard)
Week 3: CORE-014 (latency tracker eviction)
Week 4: PERF-001 through PERF-005 (performance)
```