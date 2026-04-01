# Conscious Mode — Repo-Grounded Technical Design Spec

## Status

**FINALIZED** — Ready for implementation. Architectural decisions documented in ADR-001.

This document replaces the earlier prompt-style spec and is grounded in the current repository state.

**Phase 1A implementation can begin immediately** — all critical blockers resolved.

---

## ⚠️ IMPLEMENTATION DECISIONS (2026-04-01)

**See ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md for detailed rationale.**

**Key Decisions:**
1. ✅ **Timestamps:** Arrival-time heuristic acceptable for Phase 1, instrument variance
2. ✅ **Backend Policy:** Runtime-only metadata, no IPC changes needed
3. ✅ **Turns:** Transient runtime constructs, segments remain source of truth
4. ✅ **Triggers:** Dual-mode (interviewer-gated + conversation-state) with priority system
5. ✅ **UI Migration:** Incremental fallback, keep structured parsing

**Phase 1A Scope (Week 1):**
- Turn assembly with arrival-time heuristics
- Dual trigger implementation (conversation-state disabled by default)
- UI spokenResponse fallback
- Timing instrumentation
- Backend policy documentation

All changes behind feature flags. Zero user-visible changes unless explicitly enabled.

---

## Why This Rewrite Exists

The previous version assumed the product only listened to the user's microphone and had no real bidirectional context stack.

That is no longer accurate for this repo.

Today the app already has:

- Dual-source capture: microphone plus system audio
- Per-source transcript labeling: `user` and `interviewer`
- Real-time transcript ingestion into `SessionTracker`
- Long-session transcript compaction with epoch summaries
- Meeting persistence plus live RAG indexing
- A Conscious Mode path with thread management and prompt families

This means the next effort is not "build bidirectional awareness from scratch."

The real effort is:

1. Make the audio path safe and reliable for live meeting apps on macOS
2. Turn raw source-labeled transcripts into stable bidirectional conversation turns
3. Make Conscious Mode reason over both sides of the conversation consistently
4. Enforce short spoken output instead of structured wall-of-text responses

---

## Goals

1. Preserve safe coexistence with live Google Meet, Zoom, and Microsoft Teams calls on macOS
2. Maintain full bidirectional conversational awareness across user and interviewer speech
3. Keep long-session context coherent for 1-2 hour meetings without truncation-driven drift
4. Generate short, coherent, context-grounded responses that match the live conversational moment
5. Reuse the current architecture where it is already correct instead of rewriting working subsystems

---

## Non-Goals

1. Do not introduce mixed-stream diarization as the default v1 approach
2. Do not attempt same-speaker multi-person identification within system audio in v1
3. Do not replace the current meeting persistence or RAG stack unless required by the new turn model
4. Do not expand visible output into multi-section structured responses

---

## Current Repo Audit

### 1. Audio Capture

Current state:

- The meeting pipeline starts both system audio capture and microphone capture
- `electron/main.ts` initializes both captures, both STT providers, and starts them together during `startMeeting`
- System audio uses a macOS backend abstraction with CoreAudio tap as default and ScreenCaptureKit as fallback or explicit override
- Microphone capture is a read-only input stream path

Relevant modules:

- `electron/audio/SystemAudioCapture.ts`
- `electron/audio/MicrophoneCapture.ts`
- `native-module/src/speaker/core_audio.rs`
- `native-module/src/speaker/sck.rs`
- `native-module/src/microphone.rs`
- `electron/main.ts`

What is good already:

- The architecture is already dual-source, not mic-only
- Mic capture appears read-only and does not explicitly reroute defaults
- SCK exists as an alternative backend for macOS system audio capture

What is still missing or risky:

- The default CoreAudio path is not validated as meeting-safe on live macOS calls
- There is a documented mute and quality-drop risk when the native monitor is created too early
- Startup still probes system-audio sample rate before capture start, which recreates the same risk path
- No live meeting-app validation matrix exists in the repo

### 2. Transcription Pipeline

Current state:

- STT is streaming, not batch
- The app creates separate STT providers for `interviewer` and `user`
- Supported STT providers already exist behind a common runtime path
- Final transcript segments are passed to the intelligence path, UI, and live RAG feed

Relevant modules:

- `electron/main.ts`
- `electron/IntelligenceManager.ts`
- `electron/preload.ts`

What is good already:

- Bidirectional transcript ingestion already exists
- Speaker labels are attached by source at ingestion time
- Final transcript segments already flow into live reasoning and persistence

What is still missing:

- No explicit turn assembly layer between STT segments and higher-level reasoning
- No overlap policy beyond simple source labels
- No confidence-aware turn stabilization strategy

### 3. Speaker Attribution

Current state:

- Speaker attribution is currently source-based, not diarization-based
- Microphone-originated segments map to `user`
- System-audio-originated segments map to `interviewer`

Relevant module:

- `electron/SessionTracker.ts`

What is good already:

- This is the correct low-latency v1 approach for interviews and one-on-one calls
- It avoids the latency and complexity of diarization for the common case

What is still missing:

- No explicit support for overlapping user and interviewer speech
- No support for multiple remote speakers on the system-audio side
- No metadata for turn boundaries, overlap groups, or merged segment provenance

### 4. Context Storage and Long-Session Memory

Current state:

- `SessionTracker` already keeps a short-term context buffer
- It also keeps the full transcript, assistant response history, and rolling epoch summaries
- Old transcript entries are compacted into summaries instead of being dropped outright
- Meeting snapshots preserve reconstructed context for persistence

Relevant modules:

- `electron/SessionTracker.ts`
- `electron/MeetingPersistence.ts`
- `electron/rag/RAGManager.ts`

What is good already:

- The repo already has a two-tier memory direction
- Long sessions are already handled with compaction plus summary preservation
- There is already a persistence boundary for crash recovery and post-meeting processing

What is still missing:

- Context selection is still mostly transcript-item oriented rather than turn oriented
- Conscious Mode state updates are interviewer-centric
- Retrieval of older context is not yet explicitly tied to live conversational state transitions

### 5. Response Generation

Current state:

- The prompt family is trying to move toward concise spoken output
- However the runtime Conscious Mode schema still expects older structured fields such as `implementationPlan`, `edgeCases`, and `scaleConsiderations`
- The formatter still expands those fields into multi-section output

Relevant modules:

- `electron/llm/prompts.ts`
- `electron/llm/AnswerLLM.ts`
- `electron/llm/WhatToAnswerLLM.ts`
- `electron/llm/FollowUpLLM.ts`
- `electron/ConsciousMode.ts`

What is good already:

- The prompt layer already contains anti-dump guidance
- The model contract is already moving toward natural spoken answers

What is still missing:

- Runtime contract and formatter do not match the new prompt philosophy
- Conscious Mode can still emit structured, section-heavy responses
- The visible answer contract is not yet strictly enforced as short conversational speech

### 6. Session Lifecycle

Current state:

- Meeting start initializes audio capture, STT, health checks, and live RAG indexing
- Meeting end stops capture, tears down STT, snapshots session state, and persists the meeting in the background
- Successor session creation is already built in

Relevant modules:

- `electron/main.ts`
- `electron/MeetingPersistence.ts`

What is good already:

- Session lifecycle boundaries already exist
- Crash recovery and post-meeting processing are already present

What is still missing:

- No explicit audio-safe meeting mode for macOS
- No validation gate that blocks unsafe backend combinations from being the default live-call path

---

## Corrected Problem Statement

The current system already captures both sides of the conversation at the source level, but it still has four structural problems:

1. The macOS system-audio path is not yet validated as safe for live meeting coexistence
2. Transcript ingestion is source-labeled but not yet normalized into reliable conversation turns
3. Conscious Mode still behaves as if the interviewer is the only turn that matters for state updates and auto-triggering
4. The visible response contract still allows structured verbosity instead of strict short spoken answers

---

## Design Principles

1. Keep dual-source capture as the default architecture for v1 bidirectional awareness
2. Prefer source attribution over diarization when the product controls both audio sources
3. Separate raw transcript segments from higher-level conversation turns
4. Keep hidden reasoning richer than visible output
5. Make meeting-safe macOS behavior a release gate, not a follow-up task

---

## Proposed Architecture

```text
Microphone Capture -----> User STT -----------\
                                               \
                                                -> Transcript Segment Normalizer
                                               /        -> Turn Assembler
System Audio Capture --> Interviewer STT -----/         -> Conversation State
                                                        -> Context Builder
                                                        -> Conscious Mode Router
                                                        -> LLM
                                                        -> Short Spoken Response

Turn Store + Assistant History + Epoch Summaries ------/
```

---

## Component Design

### A. Audio Ingestion Layer

Decision:

- Keep separate mic and system-audio capture paths
- Do not switch to mixed-stream diarization as the base design

Why:

- Lower latency
- Lower implementation risk
- Better attribution in the common interview case
- Compatible with the current repo architecture

Required changes:

- Introduce a macOS meeting-safe backend policy
- Stop eager system-audio monitor creation during sample-rate probing
- Prefer SCK for validated live-call mode if testing confirms it is safer than CoreAudio

### B. Transcript Segment Normalizer

Purpose:

- Convert raw STT events into a consistent internal segment format before they reach higher-level reasoning

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 1):**
- `startedAt`/`endedAt` will use **arrival-time heuristic** (Date.now() at receipt) in Phase 1
- True provider timestamps deferred to Phase 2 pending variance measurement
- Acceptable error margin: ~50-200ms for turn-level analysis
- Instrument P95/P99 variance during Phase 1A to validate approach

Proposed internal shape:

```ts
type NormalizedTranscriptSegment = {
  id: string;
  speaker: 'user' | 'interviewer';
  source: 'microphone' | 'system';
  text: string;
  startedAt: number; // Date.now() at receipt - KNOWN LIMITATION, see ADR-001
  endedAt: number;   // Date.now() at receipt - KNOWN LIMITATION, see ADR-001
  final: boolean;
  confidence?: number;
};
```

Responsibilities:

- De-duplicate repeated finals
- Collapse harmless micro-fragments
- Preserve source identity
- Pass through timestamp data needed for overlap detection
- **NEW:** Log arrival-time variance for validation

### C. Turn Assembler

Purpose:

- Convert low-level transcript segments into coherent conversation turns

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 3):**
- Turns are **TRANSIENT RUNTIME CONSTRUCTS**, not persisted
- Segments remain source of truth in database
- Turn assembly computed on-demand from segments (~1ms per 1000 segments)
- Cached during session, recomputed on meeting load
- Zero storage migration risk

Proposed turn shape:

```ts
type ConversationTurn = {
  id: string;
  speaker: 'user' | 'interviewer' | 'assistant';
  source: 'microphone' | 'system' | 'assistant';
  text: string;
  startedAt: number; // Derived from first segment
  endedAt: number;   // Derived from last segment
  final: boolean;
  confidence?: number; // Average or min of segment confidences
  overlapGroupId?: string;
  mergedSegmentIds: string[]; // References to persisted segments
};
```

Responsibilities:

- Merge adjacent final segments from the same speaker within a short threshold
- Preserve simultaneous turns when the user and interviewer overlap
- Provide a stable unit for reasoning, summarization, and persistence
- **NEW:** Cache assembled turns, invalidate on new segments

### D. Conversation State Layer

Current issue:

- Conscious Mode thread updates and auto-trigger logic are interviewer-centric

Required change:

- Move from "interviewer asked something" to "conversation state changed"

New state inputs:

- Latest interviewer turn
- Latest user turn
- Latest assistant turn
- Active reasoning thread
- Current interview phase
- Recent unresolved topics
- Previous assistant responses

### E. Context Builder

Purpose:

- Assemble only the context needed for the current response

Input sources:

1. Most recent finalized conversation turns
2. Current overlap group if present
3. Prior assistant responses for anti-repetition
4. Epoch summaries from earlier discussion
5. Optional live RAG retrieval when the current turn references older material

Output shape:

- A concise prompt context bundle, not the raw full transcript by default

Strategy:

- Recent turns first
- Relevant earlier summaries second
- Older raw transcript only when explicitly retrieved

### F. Response Layer

Decision:

- Separate hidden reasoning schema from visible response schema

Target visible contract:

```ts
type ConsciousSpokenResponse = {
  spokenResponse: string; // 1-3 sentences, strict
  likelyFollowUps?: string[];
  tradeoffHint?: string;
};
```

Rules:

- `spokenResponse` is the only field rendered by default
- `spokenResponse` must stay under a tight sentence limit
- Internal reasoning can remain structured, but must not be expanded into visible sections

Compatibility note:

- The current runtime schema still expects legacy fields like `implementationPlan`
- The implementation plan below includes a migration step to remove that mismatch

---

## Memory Design

### Short-Term Memory

Store:

- Recent finalized conversation turns
- Recent assistant responses
- Any active overlap group still being resolved

Retention:

- Time-based window plus capped turn count
- Preserve enough recency for live back-and-forth continuity

### Long-Term Memory

Store:

- Rolling epoch summaries generated from older finalized turns
- Meeting-level RAG index for deeper recall

Trigger:

- Keep the existing compaction pattern as the base
- Move compaction input from raw transcript segments toward assembled turns

Reconstruction order:

1. Active exchange
2. Recent turns
3. Relevant epoch summaries
4. Explicitly retrieved older material when needed

### Why This Matters

This keeps the system reconstructable without feeding the model an ever-growing raw transcript, and it matches the repo's current direction instead of replacing it.

---

## Overlap Handling Policy

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 4):**
- **DUAL TRIGGER MODEL** with priority system (interviewer-gated + conversation-state)
- Phase 1A: Both implemented, conversation-state disabled by default
- Interviewer-gated trigger has highest priority (100), proven stable
- Conversation-state trigger medium priority (50), behind feature flag
- Can enable conversation-state for gradual rollout without breaking existing behavior

V1 policy:

- Keep source attribution as primary truth
- If user and interviewer speak at the same time, preserve both turns with timestamps
- Do not force a single merged text blob
- **Primary trigger:** Interviewer's latest finalized question (existing, stable)
- **Secondary trigger:** Conversation state changed (new, experimental)
- Keep the user's overlapping response in the context bundle

V2 extension:

- Add simple conflict resolution rules for interrupted turns
- Optionally annotate interrupted or partial turns for the prompt layer
- **Proactive insights trigger** (priority 25) for future experimentation

Explicit non-goal for v1:

- No diarization model for remote-side speaker splitting

---

## Failure Modes And Safeguards

### Audio Safety

Failure modes:

- User cannot hear the meeting
- Remote participant cannot hear the user
- Audio quality drops when capture starts
- System-audio backend conflicts with meeting-app routing

Safeguards:

- Treat live-call validation as mandatory before default rollout
- Prefer the safer validated backend for live meetings
- Avoid eager native monitor creation during startup
- Add backend-specific telemetry around startup, recovery, and device switches

### STT Quality

Failure modes:

- Duplicate finals
- Fragmented utterances
- Overlap confusion
- Mid-session reconnect churn

Safeguards:

- Segment normalizer
- Turn assembler
- Confidence-aware de-duplication
- Better reconnect-state handling at the turn layer

### Context Quality

Failure modes:

- Over-recency bias
- Loss of earlier commitments
- Repetitive answers
- Conscious thread drift

Safeguards:

- Turn-based context builder
- Assistant response history checks
- Epoch summaries plus retrieval
- Thread resets on topic shift

### Output Quality

Failure modes:

- Wall of text
- Structured section dumps
- Answering the wrong turn

Safeguards:

- Strict spoken-response contract
- Formatter only renders the spoken answer by default
- Prompt-level and parser-level sentence-budget enforcement

---

## Trade-Off Analysis

### Dual Source vs Mixed Stream + Diarization

Dual source:

- Lower latency
- Uses existing architecture
- Better attribution in one-on-one meetings
- Weaker for multi-remote-speaker separation

Mixed stream + diarization:

- More general
- More latency
- More complexity
- Not necessary for the current primary use case

Decision:

- Use dual source in v1

### CoreAudio vs ScreenCaptureKit On macOS

CoreAudio:

- Lower-level and already default
- Has a current interference concern in this repo

SCK:

- More aligned with Apple-supported capture APIs
- Broader "all system audio" scope
- Likely safer for live-call coexistence if validation confirms it

Decision:

- Keep both backends available
- Gate the default choice on live-call validation

### Rich Structured Output vs Short Spoken Output

Rich structured output:

- Useful internally
- Too verbose for live candidate assistance

Short spoken output:

- Better fit for the user experience
- Requires stronger prompt and parser discipline

Decision:

- Keep structured reasoning internal if needed, but render only short spoken output

---

## Phased Implementation Plan

### Phase 0 — Spec Approval

Deliverables:

- Review this document
- Confirm whether the first priority is audio safety or Conscious Mode response cleanup

Exit criteria:

- Approved design direction

### Phase 1 — macOS Audio Safety Hardening

Scope:

- Remove early system-audio monitor creation during startup sample-rate probing
- Add explicit backend selection policy for live meetings
- Add logging and telemetry around backend choice and startup behavior

Validation:

- Manual matrix across Google Meet, Zoom, and Teams
- Test built-in audio, AirPods, and USB headset
- Verify assistant start, stop, mute, unmute, and device switching mid-call

Exit criteria:

- Can state with evidence which backend is safe enough for live-call use on macOS

### Phase 1A — Exact Code Change Map

This is the first implementation package that should be executed after review.

#### 1. Stop creating the native system-audio monitor during sample-rate probe

Files:

- `electron/audio/SystemAudioCapture.ts`
- `electron/main.ts`
- `electron/tests/systemAudioCapture.test.ts`

Current problem:

- `SystemAudioCapture.getSampleRate()` creates the native monitor when called before `start()`
- `setupSystemAudioPipeline()` and `reconfigureAudio()` call `getSampleRate()` before capture start

Required changes:

- Change `SystemAudioCapture.getSampleRate()` so it returns only the cached detected rate when the monitor has not started yet
- Do not call `ensureMonitor('probe')` from `getSampleRate()`
- Add an explicit `getCachedSampleRate()` or preserve `getSampleRate()` as a non-instantiating accessor
- If needed, add a dedicated method for post-start sample-rate refresh that is only called after the monitor exists

Test changes:

- Replace the current probe-before-start expectation in `systemAudioCapture.test.ts`
- New expected behavior: pre-start sample-rate reads must not instantiate the native monitor

#### 2. Reorder audio startup so interviewer STT does not need a pre-start probe

Files:

- `electron/main.ts`

Current problem:

- `startMeeting()` currently does this in the wrong order:
  - setup pipeline
  - start STT
  - start capture
- This order exists because STT configuration currently depends on the pre-start sample-rate probe

Required changes:

- In `setupSystemAudioPipeline()`:
  - stop probing system-audio sample rate before capture start
  - use a provisional interviewer STT rate such as `48000` before system capture starts
  - keep microphone rate initialization as-is unless a separate issue is found
- In `startMeeting()`:
  - initialize capture objects and listeners
  - start `systemAudioCapture`
  - start `microphoneCapture`
  - read actual sample rates after capture startup
  - set STT sample rates and channel counts
  - start STT streams after rates are configured

Reason:

- `GoogleSTT.setSampleRate()` restarts the stream if the stream is already active
- Avoiding a live STT reconfigure prevents an unnecessary reconnect right after startup

#### 3. Make backend policy explicit instead of hiding SCK behind an experimental boolean

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 2):**
- **NO IPC CHANGES** required for Phase 1
- Backend policy is **INTERNAL RUNTIME METADATA**, not user-facing
- Derive policy from `outputDeviceId` pattern in Phase 1A
- Document policy mapping, add logging for telemetry
- Defer IPC schema + UI controls to Phase 2 (only if user demand proven)

Files:

- `electron/audio/SystemAudioCapture.ts` (internal policy selection)
- Documentation: audio backend selection behavior

Current problem:

- Renderer state currently uses `useExperimentalSckBackend`
- That is a temporary feature flag, not a real backend policy

**Phase 1A Changes (Documentation + Logging Only):**

```typescript
// electron/audio/SystemAudioCapture.ts - Internal policy derivation
type AudioBackendPolicy = 'auto' | 'coreaudio' | 'sck';

class SystemAudioCapture {
  private selectBackend(deviceId: string | null): AudioBackendPolicy {
    // Device ID pattern determines policy
    if (deviceId === 'sck' || deviceId === null) {
      return 'auto'; // Let Rust select (CoreAudio → SCK fallback)
    }
    return 'coreaudio'; // Explicit device selection
  }
}
```

**Phase 2 Changes (If User Demand Exists):**

- Extend IPC schema: `audio: { outputDeviceId, outputBackend?: 'auto'|'coreaudio'|'sck' }`
- Add UI control in `AudioConfigSection.tsx`
- Pass through to `SystemAudioCapture` constructor

**Documentation Requirements:**

```markdown
## Audio Backend Selection Behavior (Phase 1)

### Policy Derivation
- `deviceId = 'sck'` → auto-selection (CoreAudio with SCK fallback)
- `deviceId = specific_device` → force CoreAudio with that device
- `deviceId = null` → auto-selection (safe default)

### ScreenCaptureKit Behavior
- SCK ignores `outputDeviceId` (native-module/src/speaker/sck.rs:97-102)
- `preferredOutputDeviceId` is informational only when SCK active
- Used for: UI display, fallback hint if SCK fails
```

Design note:

- `auto` should not silently mean "CoreAudio forever"
- It should mean "pick the validated safest backend for this environment"

#### 4. Add backend and startup telemetry needed for real validation

Files:

- `electron/main.ts`
- `electron/audio/SystemAudioCapture.ts`
- `native-module/src/speaker/macos.rs`

Required changes:

- Log which backend was requested
- Log which backend actually initialized
- Log whether fallback occurred
- Log startup timestamps for:
  - capture object creation
  - native monitor creation
  - capture start
  - STT start
- Log device identifiers and sample rates at stable points only

Reason:

- Manual validation without backend telemetry will be ambiguous and slow

#### 5. Add explicit post-start sample-rate synchronization path

Files:

- `electron/audio/SystemAudioCapture.ts`
- `electron/main.ts`

Required changes:

- After `systemAudioCapture.start()`, refresh the actual detected sample rate
- Apply that rate to interviewer STT before interviewer STT begins streaming
- If the architecture needs it, emit a lightweight internal event such as `ready` or `sample_rate` after native startup

Preferred approach:

- Do this during startup sequencing
- Avoid mid-stream STT restarts unless recovery logic explicitly requires it

#### 6. Tighten audio recovery so it does not reintroduce the startup bug

Files:

- `electron/main.ts`
- `electron/tests/audioRecovery.test.ts`

Current problem:

- `reconfigureAudio()` also probes system-audio sample rate before capture start

Required changes:

- Apply the same no-probe-before-start rule inside `reconfigureAudio()`
- Reuse the same startup ordering as the initial `startMeeting()` path
- Add tests to ensure recovery does not instantiate the system-audio monitor early

### Phase 1B — Validation Matrix

This validation is required before declaring macOS live-call safety complete.

#### Environments

- Apple Silicon macOS current release
- If available, one Intel macOS device

#### Audio Devices

- Built-in microphone + built-in speakers
- AirPods or Bluetooth headset
- USB wired headset

#### Meeting Apps

- Google Meet in Chrome
- Zoom desktop app
- Microsoft Teams desktop app

#### Backend Modes

- `coreaudio`
- `sck`
- `auto` once implemented

#### Scenarios

1. Join live call, then start assistant
2. Start assistant before joining call
3. Mute and unmute within meeting app during assistant session
4. Change output device during call
5. Change input device during call
6. Stop assistant while staying in call
7. Trigger backend recovery path if possible

#### Pass Criteria For Every Scenario

- User continues hearing the remote participant
- Remote participant continues hearing the user
- No immediate audio mute when assistant starts
- No obvious feedback loop
- No material call-quality degradation
- Transcript still flows for both speakers

#### Evidence To Capture

- Backend chosen
- Whether fallback occurred
- Device combination
- Meeting app and version
- Manual notes on call quality
- Whether transcript remained bidirectional

### Phase 2 — Segment Normalizer And Turn Assembler

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decisions 1 & 3):**
- Turns are **transient**, segments remain persisted source of truth
- Use **arrival-time heuristic** for timestamps (Date.now() at receipt)
- Implement turn assembly with **caching + invalidation** pattern
- Add **instrumentation** to measure timing variance (P50/P95/P99)

Scope:

- Introduce normalized segment and conversation-turn types
- Assemble turns from transcript fragments
- Preserve overlap metadata
- **NEW:** Implement turn caching in SessionTracker
- **NEW:** Add timing variance logging for Phase 1B analysis

Implementation:

```typescript
// electron/SessionTracker.ts - Transient turn assembly
class SessionTracker {
  private segments: TranscriptSegment[] = []; // PERSISTED
  private turnCache: ConversationTurn[] | null = null; // TRANSIENT
  
  assembleTurns(): ConversationTurn[] {
    if (this.turnCache) return this.turnCache;
    this.turnCache = assembleTurnsFromSegments(this.segments);
    return this.turnCache;
  }
  
  addSegment(segment: TranscriptSegment) {
    this.segments.push(segment);
    this.turnCache = null; // Invalidate cache
    this.logTimingVariance(segment); // Phase 1B instrumentation
  }
}
```

Validation:

- Unit tests for merging, de-duplication, overlap, and interruption behavior
- **NEW:** Timing variance telemetry (target: P95 < 500ms)

Exit criteria:

- Downstream systems consume stable conversation turns instead of raw segment fragments where needed
- **NEW:** Timing variance measured and documented for Phase 2 decision

### Phase 3 — Bidirectional Conscious State

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 4):**
- **DUAL TRIGGER MODEL** with priority system
- Interviewer-gated trigger: priority 100 (existing, stable, default enabled)
- Conversation-state trigger: priority 50 (new, experimental, default **disabled**)
- Both implemented in Phase 3, conversation-state behind feature flag

Scope:

- Update Conscious Mode state transitions to account for both interviewer and user turns
- **Implement TWO trigger paths:** interviewer-only (existing) + conversation-state (new)
- Add priority-based trigger selection with suppression rules
- **Feature flag:** conversation-state trigger disabled by default

Implementation:

```typescript
// electron/ConsciousMode.ts - Dual trigger system
class ConsciousMode {
  async evaluateTriggers(context: SessionContext): Promise<TriggerDecision> {
    const triggers: TriggerResult[] = [];
    
    // Trigger 1: Interviewer asked question (existing, always enabled)
    if (this.interviewerAskedQuestion(context.lastTurn)) {
      triggers.push({
        type: 'interviewer_question',
        priority: 100,
        reason: 'Interviewer finalized question'
      });
    }
    
    // Trigger 2: Conversation state (new, feature-flagged)
    if (this.enableConversationStateTrigger && this.conversationStateChanged(context)) {
      triggers.push({
        type: 'conversation_state',
        priority: 50,
        reason: 'New information worth surfacing'
      });
    }
    
    const winner = triggers.sort((a, b) => b.priority - a.priority)[0];
    return winner?.priority > 40 ? winner : null;
  }
}
```

Validation:

- Regression tests for topic continuation, interruption, and user follow-through
- **NEW:** A/B test conversation-state trigger with internal users
- **NEW:** Monitor false-positive rate (target: <10%)

Exit criteria:

- Conscious Mode reasoning remains consistent across full bidirectional exchanges
- **NEW:** Both trigger modes validated, conversation-state ready for gradual rollout

### Phase 4 — Context Builder Upgrade

Scope:

- Build prompt context from recent turns, prior assistant responses, and epoch summaries
- Pull in older material only when relevant

Validation:

- Tests covering long sessions, early-topic recall, and anti-repetition behavior

Exit criteria:

- Long sessions remain coherent without prompt bloat

### Phase 5 — Response Contract Cleanup

**⚠️ IMPLEMENTATION NOTE (ADR-001, Decision 5):**
- **INCREMENTAL MIGRATION** - no breaking changes
- Keep existing structured parsing, add spokenResponse fallback
- Backend can experiment with simple generation while UI stays compatible
- Users get consistent experience during transition

Scope:

- Replace legacy structured visible output **gradually**
- Align prompts, parsers, formatter, and tests around short spoken responses
- **NEW:** Implement fallback rendering in UI (structured → simple → raw)
- **NEW:** A/B test simple responses vs structured (5% → 25% → 50%)

Implementation:

```typescript
// src/lib/consciousMode.tsx - Graceful degradation
export function parseConsciousResponse(response: ConsciousResponse): ParsedResponse {
  // Try structured first (existing behavior)
  try {
    const parsed = parseStructuredSections(response.content);
    if (parsed.sections.length > 0) {
      return { type: 'structured', sections: parsed.sections };
    }
  } catch (err) {
    console.warn('Structured parsing failed, using spokenResponse', err);
  }
  
  // Fallback to spokenResponse (new behavior)
  if (response.spokenResponse) {
    return { type: 'simple', text: response.spokenResponse };
  }
  
  return { type: 'raw', text: response.content };
}
```

Validation:

- Enforce 1-3 sentence outputs in formatter and parser tests
- Confirm no section-dump regressions
- **NEW:** Monitor user satisfaction for simple vs structured responses

Exit criteria:

- Conscious Mode outputs short conversational answers reliably
- **NEW:** UI can render both formats seamlessly
- **NEW:** Backend can switch generation strategies without breaking renderer

### Phase 6 — Rollout And Regression Coverage

Scope:

- End-to-end validation of live meeting flow
- Regression coverage across meeting start/end, persistence, RAG, and Conscious Mode

Exit criteria:

- Feature is safe enough to enable without regressing call stability or response quality

---

## Recommended Immediate Next Step

Start with Phase 1, not Phase 3.

Reason:

- There is no value in making Conscious Mode smarter if the live meeting audio path is not yet certified safe on macOS
- Audio safety is the release gate for every other improvement in this spec

The first concrete engineering task should be:

1. Remove early system-audio monitor creation during sample-rate probing
2. Add a backend policy for meeting-safe macOS capture
3. Run a real Meet/Zoom/Teams validation matrix

Only after that should the work move to turn assembly and Conscious Mode bidirectional reasoning.

---

## After Phase 1 — Exact Next Build Order

Once Phase 1 passes validation, the next implementation steps should proceed in this order:

1. Introduce `NormalizedTranscriptSegment` and `ConversationTurn`
2. Make `SessionTracker` consume turn-oriented state for live reasoning paths
3. Update Conscious Mode triggers to consider both interviewer and user turns
4. Align runtime Conscious Mode schema with the newer concise prompt contract
5. Render only `spokenResponse` by default
6. Add long-session tests using turn-level compaction and epoch summaries

This order matters.

- If turn assembly is skipped, Conscious Mode will still reason over noisy segment fragments
- If response-contract cleanup is done before bidirectional state cleanup, the product may become shorter but not smarter
- If audio safety is skipped, every later improvement sits on an unsafe meeting path

---

## Approval Checklist

**✅ ALL DECISIONS FINALIZED (2026-04-01)**

- [x] Repo-grounded audit looks accurate
- [x] Dual-source capture remains the v1 architecture
- [x] macOS audio safety is the first implementation milestone
- [x] Turn assembly is the next major architectural layer
- [x] Conscious Mode visible output should be short spoken response only
- [x] **Critical blockers resolved in ADR-001**
- [x] **Timestamp strategy finalized:** arrival-time heuristic + instrumentation
- [x] **Backend policy finalized:** runtime metadata, no IPC changes
- [x] **Turn persistence finalized:** transient runtime, segments remain source of truth
- [x] **Trigger model finalized:** dual-mode with priority system
- [x] **UI migration finalized:** incremental fallback, zero breaking changes

**🚀 IMPLEMENTATION APPROVED - PHASE 1A CAN BEGIN**

See ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md for detailed implementation decisions.
