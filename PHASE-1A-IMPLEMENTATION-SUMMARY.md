# Phase 1A Implementation Summary

**Status:** ✅ READY TO IMPLEMENT  
**Date:** 2026-04-01  
**Estimated Duration:** Week 1 (5-7 days)

---

## What Changed

We reviewed the two-way conscious plan and identified **5 critical implementation blockers**:

1. ❌ Timestamp propagation undefined
2. ❌ Backend audio policy contract missing
3. ❌ Turn persistence boundary unclear
4. ❌ Trigger model conflicting
5. ❌ UI migration scope ambiguous

**All blockers now resolved.** See `ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md` for detailed decisions.

---

## Key Decisions (TL;DR)

| Area | Decision | Impact |
|------|----------|--------|
| **Timestamps** | Arrival-time heuristic (Date.now()) for Phase 1 | Zero STT provider changes, ~50-200ms error acceptable |
| **Backend Policy** | Internal runtime metadata, derive from deviceId | Zero IPC changes, documentation-only |
| **Turn Persistence** | Transient runtime, segments remain source of truth | Zero storage migration, can evolve strategy |
| **Triggers** | Dual-mode (interviewer + conversation-state) | Both implemented, conversation-state disabled by default |
| **UI Migration** | Incremental fallback (structured → simple → raw) | Zero breaking changes, gradual A/B test rollout |

---

## Phase 1A Scope (Week 1)

### 1. Turn Assembly (`electron/SessionTracker.ts`)

```typescript
class SessionTracker {
  private segments: TranscriptSegment[] = []; // Persisted (unchanged)
  private turnCache: ConversationTurn[] | null = null; // Transient (new)
  
  assembleTurns(): ConversationTurn[] {
    if (this.turnCache) return this.turnCache;
    this.turnCache = assembleTurnsFromSegments(this.segments);
    return this.turnCache;
  }
  
  addSegment(segment: TranscriptSegment) {
    this.segments.push(segment);
    this.turnCache = null; // Invalidate cache
    this.logTimingVariance(segment); // Instrumentation
  }
}

interface ConversationTurn {
  id: string;
  speaker: 'user' | 'interviewer' | 'assistant';
  text: string;
  startedAt: number; // Derived from first segment
  endedAt: number;   // Derived from last segment
  mergedSegmentIds: string[]; // References to persisted segments
  confidence?: number;
  overlapGroupId?: string;
}
```

**Files to modify:**
- `electron/SessionTracker.ts` - Add turn assembly + caching
- `electron/types/transcript.ts` - Add ConversationTurn interface

**Tests:**
- Unit tests: turn merging, overlap detection, cache invalidation
- Integration tests: segment → turn flow

---

### 2. Dual Trigger System (`electron/ConsciousMode.ts`)

```typescript
class ConsciousMode {
  private enableConversationStateTrigger = false; // Feature flag
  
  async evaluateTriggers(context: SessionContext): Promise<TriggerDecision | null> {
    const triggers: TriggerResult[] = [];
    
    // Trigger 1: Interviewer question (existing, always enabled)
    if (this.interviewerAskedQuestion(context.lastTurn)) {
      triggers.push({
        type: 'interviewer_question',
        priority: 100, // Highest
        reason: 'Interviewer finalized question'
      });
    }
    
    // Trigger 2: Conversation state (new, disabled by default)
    if (this.enableConversationStateTrigger && this.conversationStateChanged(context)) {
      triggers.push({
        type: 'conversation_state',
        priority: 50, // Lower
        reason: 'New information worth surfacing'
      });
    }
    
    const winner = triggers.sort((a, b) => b.priority - a.priority)[0];
    return winner?.priority > 40 ? winner : null;
  }
  
  private conversationStateChanged(context: SessionContext): boolean {
    const recentTurns = context.turns.slice(-5);
    const speakerSwitches = countSpeakerSwitches(recentTurns);
    return speakerSwitches >= 2; // Simple heuristic for Phase 1
  }
}
```

**Files to modify:**
- `electron/ConsciousMode.ts` - Add dual trigger logic
- `electron/conscious/types.ts` - Add TriggerDecision types

**Tests:**
- Unit tests: priority sorting, trigger suppression
- Integration tests: interviewer-only mode (existing behavior preserved)

---

### 3. UI Response Fallback (`src/lib/consciousMode.tsx`)

```typescript
export function parseConsciousResponse(response: ConsciousResponse): ParsedResponse {
  // 1. Try structured (existing behavior)
  try {
    const parsed = parseStructuredSections(response.content);
    if (parsed.sections.length > 0) {
      return { type: 'structured', sections: parsed.sections };
    }
  } catch (err) {
    console.warn('Structured parsing failed, using spokenResponse', err);
  }
  
  // 2. Fallback to spokenResponse (new behavior)
  if (response.spokenResponse) {
    return { type: 'simple', text: response.spokenResponse };
  }
  
  // 3. Last resort: raw content
  return { type: 'raw', text: response.content };
}
```

**Files to modify:**
- `src/lib/consciousMode.tsx` - Add fallback parsing
- `src/components/NativelyInterface.tsx` - Add SimpleTextView component

**Tests:**
- Unit tests: parsing fallback chain
- Visual tests: both render paths

---

### 4. Timing Instrumentation (`electron/SessionTracker.ts`)

```typescript
class SessionTracker {
  private timingStats = {
    arrivalTimes: [] as number[],
    variances: [] as number[]
  };
  
  private logTimingVariance(segment: TranscriptSegment) {
    const now = Date.now();
    const arrivalTime = segment.timestamp; // Already Date.now() from main.ts
    
    // Log for Phase 1B analysis
    this.timingStats.arrivalTimes.push(arrivalTime);
    
    // Calculate P50/P95/P99 periodically
    if (this.timingStats.arrivalTimes.length % 100 === 0) {
      this.reportTimingStats();
    }
  }
  
  private reportTimingStats() {
    // Telemetry: send to backend/logs for analysis
    const stats = {
      p50: percentile(this.timingStats.arrivalTimes, 50),
      p95: percentile(this.timingStats.arrivalTimes, 95),
      p99: percentile(this.timingStats.arrivalTimes, 99)
    };
    console.log('[Timing] Arrival-time variance:', stats);
  }
}
```

**Files to modify:**
- `electron/SessionTracker.ts` - Add timing instrumentation
- `electron/telemetry/TimingMetrics.ts` (new) - Telemetry reporting

---

### 5. Backend Policy Documentation

**No code changes.** Create documentation:

```markdown
## Audio Backend Selection (Phase 1)

### Policy Derivation
- `deviceId = 'sck'` → auto-selection (CoreAudio → SCK fallback)
- `deviceId = specific_device` → force CoreAudio with that device
- `deviceId = null` → auto-selection (safe default)

### ScreenCaptureKit Behavior
- SCK ignores `outputDeviceId` entirely (native-module/src/speaker/sck.rs:97-102)
- `preferredOutputDeviceId` is informational only when SCK active
- Used for: UI display, fallback hint if SCK fails

### Logging
- Backend policy decisions logged at startup
- Used for telemetry and debugging
```

**Files to create:**
- `docs/audio-backend-policy.md` (new)

---

## Risk Mitigation

### Feature Flags

```typescript
// electron/config/features.ts
export const FEATURES = {
  TURN_ASSEMBLY: true, // Safe: transient only, zero storage changes
  DUAL_TRIGGERS: true, // Safe: conversation-state disabled by default
  CONVERSATION_STATE_TRIGGER: false, // DISABLED until Phase 1B validation
  UI_SIMPLE_FALLBACK: true, // Safe: fallback only, structured primary
  TIMING_INSTRUMENTATION: true // Safe: logging only
};
```

### Rollback Plan

All changes independently reversible:

1. **Turn Assembly:** Disable cache, use segments directly (1 line change)
2. **Dual Triggers:** Set `enableConversationStateTrigger = false` (already default)
3. **UI Fallback:** Remove fallback block, keep structured parser (5 lines)
4. **Timing Instrumentation:** Comment out logging calls (no behavior impact)

---

## Success Criteria

### Phase 1A (Week 1)

- ✅ Turn assembly tested with unit + integration tests
- ✅ Dual trigger logic implemented, conversation-state disabled
- ✅ UI fallback rendering works for both formats
- ✅ Timing instrumentation collecting data
- ✅ Backend policy documented
- ✅ **Zero user-visible changes unless explicitly enabled**
- ✅ All existing tests passing

### Phase 1B (Week 2)

- 📊 Timing variance measured: P95 < 500ms acceptable
- 🧪 Conversation-state trigger tested internally (false positive rate <10%)
- 📊 Simple response A/B test: user satisfaction ≥ structured

### Phase 1C (Week 3)

- 🚀 Gradual rollout: conversation-state to 50% users
- 🚀 Simple responses to 25% users (if A/B positive)
- 📊 Production metrics stable

---

## Files Modified (Summary)

### Core Implementation
- `electron/SessionTracker.ts` - Turn assembly + caching + instrumentation
- `electron/ConsciousMode.ts` - Dual trigger system
- `src/lib/consciousMode.tsx` - UI response fallback
- `src/components/NativelyInterface.tsx` - Simple text rendering

### Types
- `electron/types/transcript.ts` - ConversationTurn interface
- `electron/conscious/types.ts` - TriggerDecision types

### Tests
- `electron/tests/turnAssembly.test.ts` (new)
- `electron/tests/dualTriggers.test.ts` (new)
- `src/tests/responseFallback.test.tsx` (new)

### Documentation
- `docs/audio-backend-policy.md` (new)
- `ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md` (new)
- `two-way-concious-plan.md` (updated)

### Configuration
- `electron/config/features.ts` - Feature flags

---

## Next Steps (After Phase 1A)

### Phase 1B: Validation (Week 2)
1. Analyze timing variance metrics
2. Enable conversation-state trigger for internal testing
3. Run A/B test for simple responses (5% users)
4. Monitor false-positive rates and user satisfaction

### Phase 1C: Rollout (Week 3)
1. Gradual rollout based on Phase 1B metrics
2. Tune trigger thresholds based on real usage
3. Fix issues, monitor production stability

### Phase 2: Optimization (Future)
- Provider timestamp integration (if variance >500ms)
- Turn-level analytics (if query performance issues)
- Full simple response migration (if user satisfaction proven)
- Backend policy UI controls (if user demand exists)

---

## Open Questions for Phase 2

1. **Timestamp Accuracy:** Do we need provider timestamps, or is arrival-time sufficient?
2. **Turn Analytics:** Do we need queryable turn tables in DB?
3. **Trigger Strategy:** Should we consolidate to single best trigger?
4. **Response Format:** Can we fully deprecate structured responses?

**Decision Point:** Review after Phase 1B metrics available (Week 2)

---

## Contact

**Principal Engineer Decision Record:** ADR-001  
**Plan Document:** two-way-concious-plan.md  
**Questions:** Raise in implementation review or team sync
