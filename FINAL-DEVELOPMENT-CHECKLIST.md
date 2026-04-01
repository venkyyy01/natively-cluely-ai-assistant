# Final Development Checklist

## Status

Canonical implementation checklist derived from:

- `ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md`
- `two-way-concious-plan.md`
- `PHASE-1A-DEVELOPER-CHECKLIST.md`
- `PHASE-1A-IMPLEMENTATION-SUMMARY.md`

This file is the execution order to follow.

## Final Sequencing Decision

macOS audio safety is the release gate.

That means:

1. Do the audio-safety work first
2. Validate live Meet/Zoom/Teams coexistence
3. Only then proceed with broader two-way Conscious Mode changes

The ADR remains valid for architecture decisions, but its original Phase 1A ordering is adjusted here to reflect the repo-grounded risk assessment.

---

## Locked Decisions

- [ ] Keep `TranscriptSegment` as the persisted source of truth
- [ ] Keep `ConversationTurn` as a transient runtime construct
- [ ] Use arrival-time timestamps for Phase 1 and instrument variance
- [ ] Keep backend policy internal in Phase 1
- [ ] Keep interviewer-gated triggering intact
- [ ] Add conversation-state triggering behind a disabled-by-default flag
- [ ] Keep structured UI rendering compatible during migration
- [ ] Do not add storage migrations in Phase 1
- [ ] Do not add diarization in Phase 1
- [ ] Do not add provider timestamps in Phase 1 unless timing validation forces it

---

## Phase 0: Prep

- [ ] Confirm this file is the single implementation checklist for the team
- [ ] Treat the four planning docs as supporting references, not parallel execution plans
- [ ] Keep feature-flag strategy for any new behavior that could affect runtime output
- [ ] Keep rollback paths lightweight and local to each subsystem

Exit criteria:

- [ ] Team aligns on this execution order

---

## Phase 1: macOS Audio Safety Gate

### 1.1 Remove early system-audio monitor creation

- [x] Update `electron/audio/SystemAudioCapture.ts` so pre-start sample-rate reads do not instantiate the native monitor
- [x] Remove `ensureMonitor('probe')` behavior from the pre-start path
- [x] Preserve a cached/default sample rate for pre-start configuration
- [x] Add a post-start sample-rate refresh path instead

### 1.2 Fix startup ordering

- [x] Update `electron/main.ts` startup flow so system and microphone capture start before interviewer STT depends on the real system-audio sample rate
- [x] Avoid starting interviewer STT with a config that immediately forces a restart
- [x] Apply stable sample rate and channel count after capture startup and before final STT start where possible

### 1.3 Fix recovery ordering

- [x] Update `reconfigureAudio()` in `electron/main.ts` to follow the same safe startup rules
- [x] Ensure recovery does not reintroduce pre-start monitor creation
- [x] Re-check recovery behavior for both system and microphone failure paths

### 1.4 Add backend telemetry

- [x] Log requested backend behavior
- [x] Log actual backend initialized
- [x] Log fallback events between CoreAudio and SCK
- [x] Log stable startup milestones:
- [x] capture object created
- [x] native monitor created
- [x] capture started
- [x] STT started
- [x] stable sample rate detected

### 1.5 Tighten tests for audio startup behavior

- [x] Update `electron/tests/systemAudioCapture.test.ts` to assert that pre-start sample-rate access does not create the native monitor
- [x] Update `electron/tests/audioRecovery.test.ts` for the revised recovery ordering
- [x] Add regression coverage for safe startup and reconfigure behavior

### 1.6 Run manual validation matrix

- [ ] Test Google Meet on macOS
- [ ] Test Zoom on macOS
- [ ] Test Microsoft Teams on macOS
- [ ] Test built-in speakers and microphone
- [ ] Test Bluetooth headset
- [ ] Test USB headset
- [ ] Test assistant start after joining call
- [ ] Test assistant start before joining call
- [ ] Test mute and unmute during call
- [ ] Test input-device switch during call
- [ ] Test output-device switch during call
- [ ] Test assistant stop while staying in call

### 1.7 Decide backend policy after validation

- [ ] Decide whether the validated live-call default should remain CoreAudio-first or become SCK-first
- [ ] Document the real backend policy only after validation evidence exists

Exit criteria:

- [ ] User can hear remote participants reliably
- [ ] Remote participants can hear user reliably
- [ ] No assistant-induced audio mute or severe quality drop at startup
- [ ] No obvious feedback loop
- [ ] Bidirectional transcripts still flow
- [ ] Team can state the meeting-safe backend behavior with evidence

---

## Phase 2: Turn Assembly Foundation

### 2.1 Add transient turn model

- [x] Add `ConversationTurn` type
- [x] Include speaker, text, start/end times, confidence, overlap metadata, and segment references

### 2.2 Implement turn assembly

- [x] Implement turn assembly in `electron/SessionTracker.ts`
- [x] Merge adjacent same-speaker final segments using arrival-time heuristics
- [x] Preserve overlapping turns rather than flattening them into one blob
- [x] Invalidate turn cache on new segment arrival

### 2.3 Keep persistence unchanged

- [x] Keep snapshots segment-based
- [x] Keep DB schema unchanged
- [x] Keep RAG ingestion segment-based

### 2.4 Add timing instrumentation

- [x] Record arrival-time timing stats in `SessionTracker`
- [x] Report P50, P95, and P99 timing metrics
- [x] Use this data to decide whether provider timestamps are necessary later

### 2.5 Add tests

- [x] Unit tests for same-speaker merging
- [x] Unit tests for overlap preservation
- [x] Unit tests for cache invalidation
- [x] Integration tests for segment -> turn flow

Exit criteria:

- [x] Turn assembly is stable and deterministic enough for runtime use
- [x] Existing segment-based persistence and RAG paths remain unchanged
- [x] Timing metrics are available for review

---

## Phase 3: Trigger System

### 3.1 Preserve interviewer-gated path

- [x] Keep current interviewer-question trigger behavior as the primary default
- [x] Verify no regression in existing Conscious Mode activation

### 3.2 Add conversation-state trigger

- [x] Add trigger decision types
- [x] Implement dual-trigger evaluation in `electron/ConsciousMode.ts`
- [x] Add priority ordering so interviewer-question trigger suppresses lower-priority triggers when needed
- [x] Keep conversation-state trigger disabled by default

### 3.3 Add tests

- [x] Unit tests for priority sorting
- [x] Unit tests for trigger suppression
- [x] Integration tests for interviewer-only mode
- [x] Integration tests for conversation-state flag-off behavior

Exit criteria:

- [x] Existing trigger path behaves the same by default
- [x] Conversation-state logic exists but is safely gated

---

## Phase 4: UI Compatibility Layer

### 4.1 Add fallback parsing

- [x] In `src/lib/consciousMode.tsx`, implement render fallback:
- [x] structured
- [x] simple spoken response
- [x] raw text

### 4.2 Add simple renderer

- [x] Add a simple text render path in `src/components/NativelyInterface.tsx`
- [x] Keep structured rendering intact

### 4.3 Add tests

- [x] Unit tests for fallback chain
- [x] Tests for spoken-response extraction
- [x] UI verification for both structured and simple rendering

Exit criteria:

- [x] UI can render both old structured and newer simple responses
- [x] Existing structured rendering remains intact

---

## Phase 5: Internal Validation

- [ ] Review timing metrics from Phase 2
- [ ] If timing P95 is greater than 500ms, escalate provider timestamp work
- [x] Enable conversation-state trigger for internal-only testing
- [ ] Measure false positives for the conversation-state trigger
- [ ] Validate turn quality on real meeting transcripts
- [ ] Compare structured and simple spoken-response quality

Exit criteria:

- [ ] Timing approach is validated or escalated
- [ ] Conversation-state trigger is either approved for rollout or held back
- [ ] Simple spoken fallback is either approved for broader use or kept as compatibility only

---

## Phase 6: Bidirectional Context Upgrade

- [ ] Move context selection from segment-heavy logic toward turn-oriented context assembly
- [ ] Feed recent turns, prior assistant responses, and epoch summaries into the live reasoning path
- [ ] Make Conscious Mode state updates truly bidirectional rather than interviewer-centric
- [ ] Ensure overlap context is preserved where it materially affects the response

Exit criteria:

- [ ] Conscious Mode reasons over both sides of the conversation coherently
- [ ] Long-session context remains stable without prompt bloat

---

## Phase 7: Response Contract Cleanup

- [ ] Align runtime response schema with the newer concise prompt contract
- [ ] Reduce dependence on legacy section-heavy response fields
- [ ] Keep hidden reasoning structured if useful, but render short spoken output by default
- [ ] Maintain compatibility until the old structured path is no longer needed

Exit criteria:

- [ ] Visible output is short, conversational, and context-grounded
- [ ] Structured wall-of-text output is no longer the default experience

---

## Deferred Work

- [ ] Provider-native timestamps
- [ ] Persisted turn storage
- [ ] Diarization / multi-remote-speaker separation
- [ ] Explicit backend policy IPC and UI controls
- [ ] Full removal of structured response rendering

These should remain deferred unless Phase 1-5 evidence justifies promoting them.

---

## Success Conditions

- [ ] macOS live-call audio is validated as safe enough for the assistant to coexist with Meet, Zoom, and Teams
- [ ] Two-way conversational state is assembled reliably from persisted segments
- [ ] Conscious Mode can reason over bidirectional context without regressing the existing interviewer trigger path
- [ ] UI can handle both current structured output and future concise spoken output
- [ ] The team has one execution order and one checklist
