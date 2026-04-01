# ADR-001: Two-Way Conversation Architecture - Implementation Decisions

**Status:** Accepted  
**Date:** 2026-04-01  
**Decision Maker:** Principal Engineer  
**Context:** Resolving 5 critical blockers identified during plan review for two-way conversation tracking implementation

---

## Executive Summary

This ADR finalizes architectural decisions to unblock Phase 1 implementation of two-way conversation tracking. We resolve timestamp propagation strategy, backend audio policy contracts, turn persistence boundaries, trigger model conflicts, and UI migration scope.

**Key Decisions:**
1. **Arrival-time heuristics acceptable for Phase 1** - defer true provider timestamps to Phase 2
2. **Backend policy as runtime-only metadata** - no IPC changes needed, document-first approach
3. **Turns are transient runtime constructs** - persistence stays segment-based
4. **Dual trigger model** - both interviewer-gated AND conversation-state work in parallel
5. **Incremental UI migration** - keep existing structured parsing, add spokenResponse fallback

---

## Decision 1: Timestamp Strategy - Arrival-Time Heuristic for Phase 1

### Problem
Plan assumes `startedAt`/`endedAt` timing from STT providers (lines 283-327, 453-457), but current implementation stamps everything with `Date.now()` at receipt time (`electron/main.ts:975-1009`). Turn assembly cannot work reliably with synthetic timestamps.

### Decision: **Accept Arrival-Time Heuristic + Document Limitations**

**Rationale:**
- True provider timestamps require Deepgram/AssemblyAI API contract changes (non-trivial)
- Current `isFinal=true` events already provide natural turn boundaries
- Arrival-time error margin (~50-200ms) is acceptable for turn-level analysis
- Overlap detection can use relative timing between mic/speaker streams
- Can instrument and measure actual timing variance before committing to provider API work

**Implementation:**
```typescript
// electron/SessionTracker.ts - Turn assembly with arrival-time
interface RawSegment {
  speaker: 'user' | 'interviewer';
  text: string;
  timestamp: number; // Date.now() at receipt - KNOWN LIMITATION
  isFinal: boolean;
  confidence?: number;
}

// Document variance in ADR-002 after Phase 1 instrumentation
// If measured error > 500ms, escalate provider timestamp work to Phase 2
```

**Trade-offs:**
- ✅ Unblocks Phase 1 immediately - no STT provider changes needed
- ✅ Can measure actual timing variance during Phase 1 to inform Phase 2
- ⚠️ Overlap detection will have ~50-200ms error margin
- ⚠️ Turn boundaries may shift slightly from true speech timing
- ❌ Cannot accurately attribute silence gaps vs processing delays

**Validation Criteria:**
- Instrument actual arrival-time variance in Phase 1A
- If P95 variance > 500ms in real meetings, prioritize provider timestamp work
- If P95 variance < 200ms, arrival-time is sufficient for v1

---

## Decision 2: Backend Audio Policy - Runtime Metadata, No IPC Changes

### Problem
Plan section 686-707 describes passing backend policy (`auto|coreaudio|sck`) through `startMeeting()` metadata, but IPC schema only validates device IDs. UI doesn't expose policy selection. Contract gap blocks implementation.

### Decision: **Backend Policy as Internal Metadata - Document-First Approach**

**Rationale:**
- Backend already implements CoreAudio → SCK fallback (`native-module/src/speaker/macos.rs:18-44`)
- UI already has SCK toggle but implements it as device selection hack
- `auto` policy is already the default behavior in production
- Adding IPC contract before user-facing value creates unnecessary coupling
- Can implement policy internally first, expose UI controls only when validated

**Implementation:**
```typescript
// electron/audio/SystemAudioCapture.ts - Internal policy selection
type AudioBackendPolicy = 'auto' | 'coreaudio' | 'sck';

class SystemAudioCapture {
  private selectBackend(deviceId: string | null): AudioBackendPolicy {
    // Phase 1: Derive policy from deviceId pattern
    if (deviceId === 'sck' || deviceId === null) return 'auto'; // Let Rust decide
    return 'coreaudio'; // Explicit device selection
  }
  
  // Phase 2 (if needed): Add explicit policy to IPC schema
  // Only after validating user demand for manual override
}
```

**Documentation Requirements:**
```markdown
## Audio Backend Selection (Two-Way Conscious Plan, Section 686-707)

### Current Behavior (Phase 1)
- `deviceId = 'sck'` → triggers auto-selection (CoreAudio with SCK fallback)
- `deviceId = specific_device` → forces CoreAudio with that device
- `deviceId = null` → auto-selection (safe default)

### Future Enhancement (Phase 2+)
If user-facing need emerges for manual backend override:
1. Extend IPC schema: `audio: { outputDeviceId, outputBackend?: 'auto'|'coreaudio'|'sck' }`
2. Add UI control in AudioConfigSection.tsx
3. Pass through to SystemAudioCapture constructor

### SCK Behavior (Documented)
- ScreenCaptureKit ignores `outputDeviceId` entirely (native-module/src/speaker/sck.rs:97-102)
- When SCK is active, `preferredOutputDeviceId` is informational only
- Used for: display in UI, fallback hint if SCK fails
```

**Trade-offs:**
- ✅ Unblocks Phase 1 - no IPC changes, no UI work, no migration
- ✅ Backend can log policy decisions for telemetry/debugging
- ✅ Defers UI complexity until proven user need
- ⚠️ Policy decisions are implicit in device ID patterns (magic behavior)
- ❌ Cannot A/B test policies without code changes in Phase 1

**Migration Path:**
- Phase 1: Document policy derivation logic, add logging
- Phase 1B: Add telemetry for policy selection frequency
- Phase 2: If >10% users want manual override, add IPC + UI controls

---

## Decision 3: Turn Persistence - Transient Runtime, Segment-Based Storage

### Problem
Plan moves toward turn-oriented memory (lines 51-52, 433-435, 829-843) but never specifies whether turns are persisted. Current snapshots use `TranscriptSegment[]`, RAG consumes segments. Storage layer impact is unspecified.

### Decision: **Turns Are Transient Runtime Constructs - Segments Remain Source of Truth**

**Rationale:**
- Segments are already the atomic persistence unit (tested, stable, RAG-indexed)
- Turn boundaries are derived, not canonical - multiple turn assembly strategies possible
- Changing storage schema risks breaking existing meetings, snapshots, RAG indices
- Turn assembly is fast (<1ms for typical meeting) - recompute on load is acceptable
- Avoids schema migration during Phase 1 (high risk, low value)

**Implementation:**
```typescript
// electron/SessionTracker.ts - Turn assembly on-demand
class SessionTracker {
  private segments: TranscriptSegment[] = []; // SOURCE OF TRUTH (persisted)
  private turnCache: ConversationTurn[] | null = null; // DERIVED (transient)
  
  assembleTurns(): ConversationTurn[] {
    if (this.turnCache) return this.turnCache;
    this.turnCache = assembleTurnsFromSegments(this.segments);
    return this.turnCache;
  }
  
  addSegment(segment: TranscriptSegment) {
    this.segments.push(segment);
    this.turnCache = null; // Invalidate cache
  }
}

// Persistence layer unchanged
interface MeetingSnapshot {
  fullTranscript: TranscriptSegment[]; // NOT ConversationTurn[]
  // ... existing fields
}
```

**Turn Definition (Transient):**
```typescript
interface ConversationTurn {
  speaker: 'user' | 'interviewer';
  segments: TranscriptSegment[]; // References to persisted data
  startTime: number; // Derived from first segment
  endTime: number; // Derived from last segment
  text: string; // Concatenated from segments
  confidence: number; // Average or min of segment confidences
}
```

**Trade-offs:**
- ✅ Zero storage migration risk - segments remain authoritative
- ✅ Turn assembly strategy can evolve without schema changes
- ✅ Existing RAG, snapshots, DB queries work unchanged
- ⚠️ Turn assembly cost on every meeting load (~1ms per 1000 segments, acceptable)
- ⚠️ Cannot query turns directly in DB (must load and assemble)
- ❌ Turn-level analytics require materialized view (future optimization)

**Future Optimization (Phase 3+):**
If analytics require frequent turn queries:
1. Add `derived_turns` table with foreign keys to segments
2. Populate async after segment writes (eventual consistency OK)
3. Mark as derived data, segments remain source of truth

---

## Decision 4: Trigger Model - Dual-Mode Coexistence

### Problem
Plan sections 342-345 and 453-457 conflict - one wants "conversation state changed" trigger, other says "prefer interviewer's latest question." Current code is interviewer-gated (`electron/ConsciousMode.ts:300-302`).

### Decision: **Dual Trigger Model - Both Interviewer-Gated AND Conversation-State Active**

**Rationale:**
- Interviewer-gated is proven, stable, user-tested (low risk, high value)
- Conversation-state enables proactive responses (high value, medium risk)
- They're not mutually exclusive - can run in parallel with priority rules
- Allows gradual rollout: start with interviewer-only, add conversation-state behind flag
- Real usage data will inform which trigger is more valuable

**Implementation:**
```typescript
// electron/ConsciousMode.ts - Dual trigger with priority
class ConsciousMode {
  async evaluateTriggers(context: SessionContext): Promise<TriggerDecision> {
    const triggers: TriggerResult[] = [];
    
    // Trigger 1: Interviewer asked a question (existing behavior)
    if (this.interviewerAskedQuestion(context.lastTurn)) {
      triggers.push({
        type: 'interviewer_question',
        priority: 100, // Highest priority
        reason: 'Interviewer finalized question',
        turn: context.lastTurn
      });
    }
    
    // Trigger 2: Conversation state changed significantly
    if (this.conversationStateChanged(context)) {
      triggers.push({
        type: 'conversation_state',
        priority: 50, // Lower priority
        reason: 'New information worth surfacing',
        turn: context.lastTurn
      });
    }
    
    // Trigger 3: Proactive insight (future)
    // triggers.push({ type: 'proactive_insight', priority: 25, ... });
    
    // Execute highest-priority trigger above threshold
    const winner = triggers.sort((a, b) => b.priority - a.priority)[0];
    return winner?.priority > 40 ? winner : null;
  }
  
  private conversationStateChanged(context: SessionContext): boolean {
    // Phase 1: Simple heuristics
    const recentTurns = context.turns.slice(-5);
    const speakerSwitches = countSpeakerSwitches(recentTurns);
    const hasNewKeywords = detectNewKeywords(recentTurns, context.priorKeywords);
    return speakerSwitches >= 2 || hasNewKeywords;
  }
}
```

**Overlap Handling:**
```typescript
// When both triggers fire simultaneously
interface TriggerDecision {
  type: 'interviewer_question' | 'conversation_state' | 'proactive_insight';
  priority: number;
  suppressOthers: boolean; // interviewer_question suppresses others
}
```

**Trade-offs:**
- ✅ Preserves existing interviewer-gated behavior (zero regression risk)
- ✅ Enables experimentation with conversation-state triggers
- ✅ Clear priority system prevents trigger conflicts
- ⚠️ More complex trigger logic (but isolated, testable)
- ⚠️ Requires tuning priority thresholds with real data
- ❌ Potential for over-triggering if thresholds wrong (mitigated by priority)

**Rollout Plan:**
1. Phase 1A: Implement both triggers, conversation-state disabled by default
2. Phase 1B: Enable conversation-state for internal testing (5% of meetings)
3. Phase 1C: Gradual rollout based on user feedback and false-positive rate

---

## Decision 5: UI Migration - Incremental with Fallback

### Problem
Plan calls out backend cleanup (lines 875-885) but renderer still depends on structured sections (`src/lib/consciousMode.tsx:15-219`, `src/components/NativelyInterface.tsx:567-580`). If target is "render only spokenResponse," migration scope is unclear.

### Decision: **Keep Structured Parsing, Add spokenResponse Fallback - No Breaking Changes**

**Rationale:**
- Existing UI components work, are tested, users expect structured display
- Backend already generates `spokenResponse` field (`electron/conscious/types.ts:168`)
- Renderer can gracefully degrade: use structured if available, fallback to spokenResponse
- Allows backend to simplify generation while maintaining UI compatibility
- Enables A/B testing: some users get simple responses, others get structured

**Implementation:**
```typescript
// src/lib/consciousMode.tsx - Graceful degradation
export function parseConsciousResponse(response: ConsciousResponse): ParsedResponse {
  // Attempt structured parsing (existing behavior)
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
    return { 
      type: 'simple', 
      text: response.spokenResponse,
      shouldSpeak: true 
    };
  }
  
  // Last resort: raw content
  return { type: 'raw', text: response.content };
}

// src/components/NativelyInterface.tsx - Render both types
function ConsciousMessageDisplay({ message }: { message: ParsedResponse }) {
  if (message.type === 'structured') {
    return <StructuredSectionsView sections={message.sections} />;
  }
  if (message.type === 'simple') {
    return <SimpleTextView text={message.text} />;
  }
  return <RawContentView text={message.text} />;
}
```

**Backend Simplification (Optional):**
```typescript
// electron/llm/prompts.ts - Simplified prompt (opt-in)
const SIMPLE_CONSCIOUS_PROMPT = `
You are answering on behalf of the user in a live conversation.

Context: {context}
Question: {question}

Provide a concise, natural response (2-3 sentences) that:
- Directly answers the question
- References relevant context
- Sounds conversational, not formal

Response:
`;

// electron/conscious/types.ts - Response generation
interface ConsciousResponse {
  content: string; // May be structured JSON or simple text
  spokenResponse: string; // ALWAYS generated, safe fallback
  metadata: { generationStrategy: 'structured' | 'simple' };
}
```

**Trade-offs:**
- ✅ Zero breaking changes - existing UI works unchanged
- ✅ Backend can experiment with simpler generation strategies
- ✅ Users get consistent experience during transition
- ⚠️ Maintains complex parsing logic during Phase 1
- ⚠️ Two rendering paths to test and maintain
- ❌ Cannot fully remove structured parsing until usage drops to 0%

**Migration Timeline:**
1. Phase 1A: Implement fallback logic, monitor structured vs simple usage
2. Phase 1B: Experiment with simple generation for 10% of responses
3. Phase 2: If simple responses have equal/better user satisfaction, increase to 50%
4. Phase 3: Deprecate structured format when usage <5%

---

## Implementation Sequence

### Phase 1A: Foundation (Week 1)
1. ✅ **Timestamp instrumentation** - Add logging for arrival-time variance
2. ✅ **Turn assembly** - Implement `assembleTurnsFromSegments()` with heuristics
3. ✅ **Backend policy docs** - Document device-to-policy mapping
4. ✅ **Dual triggers** - Implement both triggers, conversation-state disabled
5. ✅ **UI fallback** - Add spokenResponse parsing to renderer

**Risk Mitigation:**
- All changes behind feature flags
- Existing behavior unchanged by default
- Can ship Phase 1A with zero user-visible changes

### Phase 1B: Validation (Week 2)
1. 📊 **Measure timing variance** - Analyze P50/P95/P99 arrival-time error
2. 🧪 **Test conversation-state trigger** - Enable for internal meetings
3. 📊 **Monitor trigger frequency** - Track interviewer vs conversation-state fires
4. 🧪 **A/B test simple responses** - 5% users get spokenResponse-only

**Success Criteria:**
- Arrival-time P95 < 500ms (acceptable for Phase 1)
- Conversation-state false positive rate < 10%
- Simple response user satisfaction ≥ structured responses

### Phase 1C: Rollout (Week 3)
1. 🚀 **Enable conversation-state** - Gradual rollout to 50% users
2. 🚀 **Increase simple responses** - 25% users if A/B test positive
3. 📊 **Monitor production metrics** - Turn assembly performance, trigger accuracy
4. 🐛 **Fix issues** - Tune thresholds based on real usage

### Phase 2: Optimization (Future)
- Provider timestamp integration (if variance >500ms)
- Turn-level analytics (if query performance issues)
- Full simple response migration (if user satisfaction proven)
- Backend policy UI controls (if user demand exists)

---

## Rollback Plan

Each decision is independently reversible:

1. **Timestamps:** Instrumentation-only in Phase 1, no behavior change
2. **Backend Policy:** No code changes, documentation-only
3. **Turns:** Cached on read, no schema changes - can disable cache
4. **Triggers:** Feature-flagged, can disable conversation-state instantly
5. **UI Migration:** Fallback logic, structured parsing remains primary

---

## Open Questions for Phase 2

1. **Timestamp Accuracy:** After measuring variance, do we need provider timestamps?
2. **Turn Analytics:** Do we need queryable turn tables, or is on-demand assembly sufficient?
3. **Trigger Strategy:** Should we consolidate to single best trigger, or keep dual-mode?
4. **Response Format:** Can we fully deprecate structured responses?

---

## Signatures

**Approved By:** Principal Engineer (2026-04-01)  
**Review Required:** After Phase 1B validation metrics available  
**Next Review:** 2026-04-15 (2 weeks post-Phase 1A deployment)
