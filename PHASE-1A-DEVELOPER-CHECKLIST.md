# Phase 1A Developer Checklist

**Quick reference for implementation tasks. See PHASE-1A-IMPLEMENTATION-SUMMARY.md for details.**

---

## ✅ Pre-Implementation

- [x] All blockers resolved in ADR-001
- [x] Plan finalized in two-way-conscious-plan.md
- [x] Feature flags defined
- [x] Rollback strategy documented

---

## 📝 Implementation Tasks

### Task 1: Turn Assembly Infrastructure

**Estimate:** 1-2 days  
**Priority:** High  
**Risk:** Low (transient only, no storage changes)

- [ ] Add `ConversationTurn` interface to `electron/types/transcript.ts`
- [ ] Implement `assembleTurnsFromSegments()` in `electron/SessionTracker.ts`
- [ ] Add turn cache with invalidation logic
- [ ] Write unit tests for turn merging
- [ ] Write unit tests for overlap detection
- [ ] Write integration tests for segment → turn flow
- [ ] Validate existing segment-based code still works

**Acceptance:**
- Turn assembly produces stable output from segments
- Cache invalidates correctly on new segments
- Existing transcript functionality unchanged

---

### Task 2: Dual Trigger System

**Estimate:** 1-2 days  
**Priority:** High  
**Risk:** Low (conversation-state disabled by default)

- [ ] Add `TriggerDecision` types to `electron/conscious/types.ts`
- [ ] Implement `evaluateTriggers()` in `electron/ConsciousMode.ts`
- [ ] Add priority-based trigger selection
- [ ] Implement `conversationStateChanged()` heuristic
- [ ] Add `enableConversationStateTrigger` feature flag (default: false)
- [ ] Write unit tests for priority sorting
- [ ] Write unit tests for trigger suppression
- [ ] Write integration tests for interviewer-only mode
- [ ] Validate existing interviewer-gated behavior preserved

**Acceptance:**
- Both triggers implemented
- Conversation-state trigger disabled by default
- Interviewer-gated trigger works identically to before
- Priority system selects correct trigger

---

### Task 3: UI Response Fallback

**Estimate:** 1 day  
**Priority:** Medium  
**Risk:** Low (fallback only, existing parser primary)

- [ ] Add `parseConsciousResponse()` fallback logic to `src/lib/consciousMode.tsx`
- [ ] Add `SimpleTextView` component to `src/components/NativelyInterface.tsx`
- [ ] Add render path selection (structured → simple → raw)
- [ ] Write unit tests for fallback chain
- [ ] Write visual tests for both render paths
- [ ] Validate existing structured rendering unchanged

**Acceptance:**
- UI can render both structured and simple responses
- Fallback only triggers when structured parsing fails
- Existing structured responses render identically

---

### Task 4: Timing Instrumentation

**Estimate:** 0.5 days  
**Priority:** Low  
**Risk:** None (logging only)

- [ ] Add timing stats tracking to `electron/SessionTracker.ts`
- [ ] Implement `logTimingVariance()` method
- [ ] Implement `reportTimingStats()` method
- [ ] Add percentile calculation utilities
- [ ] Create `electron/telemetry/TimingMetrics.ts` for reporting
- [ ] Add logging at every 100 segments
- [ ] Validate no performance impact

**Acceptance:**
- Timing variance logged periodically
- P50/P95/P99 stats reported
- No observable performance impact

---

### Task 5: Backend Policy Documentation

**Estimate:** 0.5 days  
**Priority:** Low  
**Risk:** None (documentation only)

- [ ] Create `docs/audio-backend-policy.md`
- [ ] Document policy derivation from deviceId
- [ ] Document SCK behavior and limitations
- [ ] Document logging strategy
- [ ] Add internal code comments for policy selection logic
- [ ] Update README with audio backend section

**Acceptance:**
- Policy behavior fully documented
- Team understands how backend selection works

---

## 🧪 Testing Checklist

### Unit Tests

- [ ] Turn assembly: merging same-speaker segments
- [ ] Turn assembly: preserving overlapping turns
- [ ] Turn assembly: cache invalidation
- [ ] Turn assembly: confidence calculation
- [ ] Trigger system: priority sorting
- [ ] Trigger system: interviewer-gated (existing behavior)
- [ ] Trigger system: conversation-state (disabled)
- [ ] UI fallback: structured → simple → raw chain
- [ ] UI fallback: spokenResponse extraction

### Integration Tests

- [ ] Segment → turn → context flow
- [ ] Interviewer question triggers conscious mode
- [ ] Conversation-state trigger respects feature flag
- [ ] UI renders both response formats
- [ ] Timing instrumentation collects data

### Regression Tests

- [ ] Existing meeting start/stop flow unchanged
- [ ] Existing transcript display unchanged
- [ ] Existing conscious mode responses unchanged
- [ ] Existing RAG indexing unchanged
- [ ] Existing persistence layer unchanged

---

## 🚀 Deployment Checklist

### Pre-Deployment

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] All regression tests passing
- [ ] Feature flags configured correctly
- [ ] Rollback plan tested
- [ ] Documentation updated

### Deployment

- [ ] Deploy to staging environment
- [ ] Run smoke tests on staging
- [ ] Monitor staging metrics (24 hours)
- [ ] Deploy to production (gradual rollout)
- [ ] Monitor production metrics

### Post-Deployment

- [ ] Verify zero user-visible changes (conversation-state disabled)
- [ ] Verify timing instrumentation collecting data
- [ ] Verify turn assembly working correctly
- [ ] Monitor error rates and performance

---

## 📊 Phase 1B Preparation

### Metrics to Collect

- [ ] Timing variance (P50/P95/P99)
- [ ] Turn assembly performance (avg/p95)
- [ ] Cache hit rate
- [ ] Conversation-state trigger false positives (when enabled)
- [ ] Simple response user satisfaction (when A/B enabled)

### Analysis Required

- [ ] Is P95 timing variance < 500ms? → Acceptable for Phase 1
- [ ] Is conversation-state false positive rate < 10%? → Safe to enable
- [ ] Is simple response satisfaction ≥ structured? → Safe to increase rollout

---

## 🐛 Known Limitations (Phase 1A)

1. **Timestamps:** Arrival-time heuristic (~50-200ms error margin)
   - **Mitigation:** Instrumented, will validate in Phase 1B
   - **Escalation:** If P95 > 500ms, prioritize provider timestamps in Phase 2

2. **Backend Policy:** Derived from deviceId, not explicit
   - **Mitigation:** Documented behavior, logging for telemetry
   - **Escalation:** Add IPC + UI controls if user demand exists

3. **Turns:** Not persisted, recomputed on load
   - **Mitigation:** Fast assembly (~1ms per 1000 segments)
   - **Escalation:** Add derived table if analytics need direct queries

4. **Conversation-State Trigger:** Disabled by default
   - **Mitigation:** Tested internally before gradual rollout
   - **Escalation:** Tune thresholds based on false-positive rate

---

## 🆘 Rollback Procedures

### If Turn Assembly Has Issues

```typescript
// electron/SessionTracker.ts
assembleTurns(): ConversationTurn[] {
  // ROLLBACK: Comment out caching
  // if (this.turnCache) return this.turnCache;
  
  const turns = assembleTurnsFromSegments(this.segments);
  // this.turnCache = turns; // ROLLBACK: Don't cache
  return turns;
}
```

### If Dual Triggers Cause Problems

```typescript
// electron/ConsciousMode.ts
class ConsciousMode {
  // ROLLBACK: Set to false
  private enableConversationStateTrigger = false;
}
```

### If UI Fallback Breaks

```typescript
// src/lib/consciousMode.tsx
export function parseConsciousResponse(response: ConsciousResponse): ParsedResponse {
  // ROLLBACK: Remove fallback logic, use structured only
  return parseStructuredSections(response.content);
}
```

---

## 📞 Support

**For Questions:**
- Review: ADR-001-TWO-WAY-CONVERSATION-ARCHITECTURE.md
- Details: PHASE-1A-IMPLEMENTATION-SUMMARY.md
- Plan: two-way-concious-plan.md

**Escalation:**
- Implementation blocker → Tag principal engineer
- Design question → Review ADR-001 first
- Unforeseen issue → Document + propose solution

---

**Last Updated:** 2026-04-01  
**Phase:** 1A (Week 1)  
**Status:** Ready for Implementation
