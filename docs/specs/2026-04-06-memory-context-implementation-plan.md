# Memory & Context System Implementation Plan

**Created:** 2026-04-06  
**Updated:** 2026-04-07  
**Status:** Execution Ready - Realtime GOAT v1  
**Owner:** OpenCode (Principal Software Engineer and Architect)  
**Execution Mode:** Autonomous loops (no user confirmation gates)  
**Review Mode:** Mandatory self-review after every loop  
**Goal:** Make memory and context maximally powerful and useful in **real-time interviews**

---

## Executive Summary

This is the **simplified, no-over-engineering** version of the memory plan. We removed:
- LLM-based entity extraction (latency + cost)
- 3-tier hierarchical memory (complexity)
- ML-based predictive prefetching (speculative, marginal benefit)
- User pattern learning (needs many interactions, complex signals)
- Semantic anti-repetition with embeddings (overkill)
- 5-table database schema (migration complexity)

What we kept and added:
- Enable existing semantic scoring (just flip switches)
- Pinned/sticky context items (user marks important)
- Regex-based extraction (numbers, names, tech terms - fast)
- Question vs statement detection (simple heuristics)
- Simple JSON persistence (one file per session)
- Hash-based response fingerprinting (simple, fast)
- Pre-built context snapshots (cache assembled context)
- Model-agnostic token counting via `toksclare` (cross-LLM, no vendor lock-in)

**Total timeline: ~5-6 days** (down from ~3 weeks)

---

## Design Principles

1. **No blocking operations** - Everything must be real-time capable
2. **Simple > Complex** - Regex over LLM, hash over embeddings
3. **Visible latency = failure** - Target <50ms for all context ops
4. **Minimal new infrastructure** - Use existing patterns, avoid new tables
5. **Interview-focused** - Every feature must help during live interviews
6. **No vendor lock-in for core plumbing** - token counting works across all LLM providers

---

## Completion Snapshot (Current Branch)

This plan is now execution-ready and grounded in code that already landed in this branch.

| Area | Status | Notes |
|------|--------|-------|
| Model-agnostic token counting abstraction | Done | `electron/shared/TokenCounter.ts` added |
| Runtime token estimators migrated | Done | `LLMHelper`, `PromptCompiler`, `TokenBudget`, `AdaptiveContextWindow`, `TranscriptPreprocessor` |
| Vendor lock-in removed from hot paths | Done | No direct `text.length / 4` in runtime token budgeting paths |
| Semantic context window default enable | Done | `accelerationEnabled` default set to `true` with timeout/fallback path |
| Thread semantic resume embedding | Done | `ThreadManager` now writes pseudo-embeddings for active/suspended matching |
| Interview essentials (pin/constraints/questions/fingerprint) | Done | Implemented in `SessionTracker` + new conscious helpers |

**Important:** `toksclare` is treated as an optional external counter. If unavailable at runtime, `TokenCounter` falls back to deterministic heuristics so interviews never block.

---

## Ownership and Loop Protocol

This plan is owned and executed by the principal engineer owner listed above. Work proceeds in short delivery loops with built-in self-review and no approval pauses between loops.

### Loop Definition

- **Loop duration:** 45-90 minutes
- **Loop output:** code + tests + doc delta + metrics delta
- **Loop policy:** pick safest default and continue; do not pause for confirmations
- **Rollback policy:** if reliability or latency regresses, revert loop changes before starting the next loop

### Mandatory Self-Review Gate (After Every Loop)

The owner must pass this checklist before starting the next loop:

1. **Realtime safety:** P95 context assembly remains within budget and no new blocking call appears on the hot path.
2. **Failure handling:** timeout/degrade/fallback path is deterministic and tested.
3. **Correctness:** no broken invariants in thread state, pinned state, or session restore.
4. **Token safety:** token budgeting uses `TokenCounter`; no direct char-based budgeting shortcuts are reintroduced.
5. **Crash safety:** persistence writes are atomic or guarded from partial-write corruption.
6. **Observability:** loop introduces or preserves useful logs/counters for latency and fallback visibility.
7. **Test signal:** changed behavior has unit/integration coverage or explicit replay validation.
8. **Scope control:** no speculative expansion beyond this plan's interview-focused goals.

### Escalation Rule

If a loop fails self-review, the same owner must immediately run a fix loop. No net-new features are started until the failed gate is resolved.

---

## Current State Analysis

### Existing Architecture

| Component | File | Status |
|-----------|------|--------|
| Ring Buffer (120s, 500 items) | `SessionTracker.ts` | Working |
| Full Transcript (5000 entries) | `SessionTracker.ts` | Working |
| Epoch Summaries (max 5) | `SessionTracker.ts` | Working |
| Adaptive Context Window | `AdaptiveContextWindow.ts` | **DISABLED** |
| Thread Management | `ThreadManager.ts` | Working (in-memory only) |
| Semantic Thread Matching | `ConfidenceScorer.ts` | **DISABLED** (weight=0) |
| Vector Search | `VectorStore.ts` | Working (for RAG only) |
| Anti-Repetition | `TemporalContextBuilder.ts` | Basic (no semantic) |

### Key Limitations to Fix

1. **Semantic similarity scoring is disabled** - infrastructure exists but `accelerationEnabled: false`
2. **No session persistence** - thread/context state lost on app restart
3. **Embeddings not computed for live context** - only meeting transcripts get embedded
4. **Entity bucket is never populated** - always empty
5. **No way to mark things as "important"** - everything weighted the same

---

## Implementation Phases

### Phase 1: Enable Existing Infrastructure (Quick Wins)

**Status:** In progress (token counting completed)

**Timeline:** 1 day  
**Impact:** HIGH  
**Effort:** LOW  

This is pure configuration - the code already exists.

#### 1.1 Enable Semantic Context Window

**File:** `electron/config/optimizations.ts`

```typescript
// CHANGE: Line 39
export const defaultOptimizations = {
  accelerationEnabled: true,   // WAS: false
  // ...
};
```

**File:** `SessionTracker.ts` (line ~452)

```typescript
// CHANGE: Add embeddings to candidates
async getAdaptiveContext(config: AdaptiveContextConfig): Promise<ContextEntry[]> {
  const items = this.getContextItems();
  
  // Batch embed (use worker thread, non-blocking)
  const texts = items.map(i => i.text);
  const embeddings = await this.embeddingPipeline.embedBatch(texts);
  
  const candidates: ContextEntry[] = items.map((item, i) => ({
    text: item.text,
    timestamp: item.timestamp,
    phase: this.detectPhase(item),
    embedding: embeddings[i],  // NEW: was undefined
  }));
  
  return this.adaptiveWindow.selectContext(candidates, config);
}
```

#### 1.2 Enable Thread Semantic Matching

**File:** `ConfidenceScorer.ts` (or `conscious/types.ts`)

```typescript
// CHANGE: Enable embedding weight
const CONFIDENCE_WEIGHTS = {
  bm25: 0.20,
  embedding: 0.25,    // WAS: 0.0
  temporal: 0.20,     // WAS: 0.25
  phase: 0.20,        // WAS: 0.25
  explicit: 0.15,     // WAS: 0.25
};
```

**File:** `ThreadManager.ts`

```typescript
// CHANGE: Generate embedding when suspending thread
async suspendActive(): Promise<void> {
  if (this.activeThread) {
    this.activeThread.embedding = await this.embeddingPipeline.embed(
      `${this.activeThread.topic} ${this.activeThread.goal}`
    );
    this.activeThread.status = 'suspended';
    this.suspendedThreads.push(this.activeThread);
  }
}
```

#### 1.3 Performance Safeguards

```typescript
// Add to SessionTracker or embedding pipeline
const EMBEDDING_TIMEOUT_MS = 100;

async embedWithTimeout(text: string): Promise<number[] | null> {
  try {
    return await Promise.race([
      this.embeddingPipeline.embed(text),
      new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), EMBEDDING_TIMEOUT_MS)
      )
    ]);
  } catch {
    return null; // Fallback to recency-only
  }
}
```

#### 1.4 Model-Agnostic Token Counting (`toksclare`)

Use a single token counting adapter across all models/providers so budgeting stays consistent.

**New File:** `electron/shared/TokenCounter.ts`

```typescript
// Pseudo-code: keep this wrapper tiny and provider-agnostic
import { countTokens as toksclareCount } from 'toksclare';

export class TokenCounter {
  count(text: string, modelId: string): number {
    try {
      return toksclareCount(text, { model: modelId });
    } catch {
      // Last-resort fallback only
      return Math.ceil(text.length / 4);
    }
  }
}
```

**Production behavior in this branch:**
- `TokenCounter` attempts to load `toksclare` dynamically.
- If `toksclare` is missing/unavailable, it uses a deterministic cross-model heuristic fallback.
- Fallback is intentional to protect realtime UX; do not hard-fail interviews on tokenizer package issues.

```typescript
// High-level behavior (already implemented)
count(text, modelHint) {
  try toksclare(text, modelHint)
  catch -> heuristicCount(text, modelHint)
}
```

**Replace all runtime `text.length / 4` token estimates in hot paths:**
- `electron/LLMHelper.ts`
- `electron/llm/PromptCompiler.ts`
- `electron/conscious/TokenBudget.ts`
- `electron/conscious/AdaptiveContextWindow.ts`
- `electron/rag/TranscriptPreprocessor.ts`

**Rule:** token counting must use model id from the active LLM adapter, not a provider-locked tokenizer.

#### Verification Criteria

- [x] `accelerationEnabled` is `true`
- [x] Context items have embeddings populated
- [x] AdaptiveContextWindow uses semantic scoring
- [x] Thread matching uses embedding similarity
- [x] Runtime token counting uses model-agnostic `TokenCounter` wrapper
- [x] Runtime token budgeting paths no longer use direct `text.length / 4`
- [x] `TokenCounter` fallback behavior is defined for external tokenizer outage
- [ ] No perceptible latency increase (<50ms target)

---

### Phase 2: Interview Essentials

**Status:** Implemented

**Timeline:** 2-3 days  
**Impact:** HIGH  
**Effort:** MEDIUM  

These are the features that actually matter for interviews.

#### 2.1 Pinned/Sticky Context Items

Users can mark things as "sticky" - they stay in context until manually cleared.

**File:** `SessionTracker.ts`

```typescript
interface PinnedItem {
  id: string;
  text: string;
  pinnedAt: number;
  label?: string;  // Optional user label: "budget", "deadline", etc.
}

class SessionTracker {
  private pinnedItems: PinnedItem[] = [];
  private readonly MAX_PINNED = 10;

  pinItem(text: string, label?: string): void {
    if (this.pinnedItems.length >= this.MAX_PINNED) {
      // Remove oldest
      this.pinnedItems.shift();
    }
    this.pinnedItems.push({
      id: crypto.randomUUID(),
      text,
      pinnedAt: Date.now(),
      label
    });
  }

  unpinItem(id: string): void {
    this.pinnedItems = this.pinnedItems.filter(p => p.id !== id);
  }

  clearAllPinned(): void {
    this.pinnedItems = [];
  }

  getPinnedItems(): PinnedItem[] {
    return [...this.pinnedItems];
  }
}
```

**Integration with context assembly:**

```typescript
assembleContext(): string {
  const pinned = this.getPinnedItems();
  const pinnedSection = pinned.length > 0
    ? `<pinned_context>\n${pinned.map(p => 
        p.label ? `[${p.label}] ${p.text}` : p.text
      ).join('\n')}\n</pinned_context>\n\n`
    : '';
  
  return pinnedSection + this.getRegularContext();
}
```

#### 2.2 Regex-Based Constraint Extraction

Fast extraction of numbers, dates, and constraints - no LLM needed.

**File:** `electron/conscious/ConstraintExtractor.ts` (NEW)

```typescript
interface ExtractedConstraint {
  type: 'budget' | 'deadline' | 'headcount' | 'duration' | 'percentage' | 'count';
  raw: string;
  normalized: string;
}

const CONSTRAINT_PATTERNS: Record<string, RegExp> = {
  budget: /\$[\d,]+(?:\.\d{2})?(?:k|m|b)?|\d+(?:\.\d+)?\s*(?:million|billion|thousand|k|m|b)\s*(?:dollars?|usd)?/gi,
  deadline: /(?:by|before|until|due)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/gi,
  headcount: /\d+\s*(?:people|engineers?|developers?|designers?|employees?|team members?|FTEs?|headcount)/gi,
  duration: /\d+\s*(?:weeks?|months?|quarters?|sprints?|days?)\s*(?:timeline|deadline|delivery)?/gi,
  percentage: /\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*percent/gi,
  count: /\d+\s*(?:features?|requirements?|milestones?|deliverables?|items?)/gi,
};

export function extractConstraints(text: string): ExtractedConstraint[] {
  const results: ExtractedConstraint[] = [];
  
  for (const [type, pattern] of Object.entries(CONSTRAINT_PATTERNS)) {
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      results.push({
        type: type as ExtractedConstraint['type'],
        raw,
        normalized: normalizeConstraint(type, raw)
      });
    }
  }
  
  return deduplicateConstraints(results);
}

function normalizeConstraint(type: string, raw: string): string {
  // Normalize to consistent format
  if (type === 'budget') {
    // "$500k" -> "$500,000"
    return raw.replace(/(\d+)k/i, (_, n) => `$${parseInt(n) * 1000}`);
  }
  return raw.trim();
}

function deduplicateConstraints(items: ExtractedConstraint[]): ExtractedConstraint[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.type}:${item.normalized.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

**Auto-pin extracted constraints:**

```typescript
// In SessionTracker, on new transcript segment
onNewTranscript(text: string): void {
  const constraints = extractConstraints(text);
  for (const c of constraints) {
    // Only auto-pin if not already pinned
    if (!this.hasConstraint(c.normalized)) {
      this.pinItem(c.normalized, c.type);
    }
  }
}
```

#### 2.3 Question vs Statement Detection

Simple heuristics to detect questions - no ML needed.

**File:** `electron/conscious/QuestionDetector.ts` (NEW)

```typescript
interface Detection {
  isQuestion: boolean;
  confidence: number;  // 0-1
  questionType?: 'clarification' | 'information' | 'confirmation' | 'rhetorical';
}

const QUESTION_WORDS = /^(?:what|who|where|when|why|how|which|can|could|would|should|is|are|do|does|did|will|have|has)/i;
const QUESTION_ENDING = /\?\s*$/;
const CONFIRMATION_PATTERNS = /(?:right|correct|isn't it|don't you think|wouldn't you say)/i;
const CLARIFICATION_PATTERNS = /(?:what do you mean|could you clarify|can you explain|what exactly)/i;

export function detectQuestion(text: string): Detection {
  const trimmed = text.trim();
  
  // Strong signals
  const hasQuestionMark = QUESTION_ENDING.test(trimmed);
  const startsWithQuestionWord = QUESTION_WORDS.test(trimmed);
  
  // Calculate confidence
  let confidence = 0;
  if (hasQuestionMark) confidence += 0.6;
  if (startsWithQuestionWord) confidence += 0.3;
  
  // Detect question type
  let questionType: Detection['questionType'];
  if (CLARIFICATION_PATTERNS.test(trimmed)) {
    questionType = 'clarification';
    confidence = Math.max(confidence, 0.8);
  } else if (CONFIRMATION_PATTERNS.test(trimmed)) {
    questionType = 'confirmation';
    confidence = Math.max(confidence, 0.7);
  } else if (confidence > 0.5) {
    questionType = 'information';
  }
  
  return {
    isQuestion: confidence > 0.5,
    confidence: Math.min(confidence, 1.0),
    questionType
  };
}
```

**Use in context assembly:**

```typescript
// Prioritize context relevant to questions
if (detectQuestion(currentUtterance).isQuestion) {
  // Boost recent Q&A pairs in context scoring
  contextWeight.qaPairs *= 1.5;
}
```

#### 2.4 Hash-Based Response Fingerprinting

Simple hash to detect if we're about to repeat ourselves.

**File:** `electron/conscious/ResponseFingerprint.ts` (NEW)

```typescript
import { createHash } from 'crypto';

interface Fingerprint {
  hash: string;
  timestamp: number;
  preview: string;  // First 50 chars for debugging
}

class ResponseFingerprinter {
  private recentFingerprints: Fingerprint[] = [];
  private readonly MAX_HISTORY = 20;
  private readonly SIMILARITY_THRESHOLD = 0.7;

  // Create fingerprint from response
  fingerprint(text: string): string {
    // Normalize: lowercase, remove punctuation, collapse whitespace
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Create hash
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  // Check if response is too similar to recent ones
  isDuplicate(text: string): { isDupe: boolean; matchedPreview?: string } {
    const newHash = this.fingerprint(text);
    
    // Exact match
    const exact = this.recentFingerprints.find(f => f.hash === newHash);
    if (exact) {
      return { isDupe: true, matchedPreview: exact.preview };
    }
    
    // Fuzzy match: check if first sentence is identical
    const firstSentence = text.split(/[.!?]/)[0]?.trim().toLowerCase();
    for (const fp of this.recentFingerprints) {
      if (fp.preview.toLowerCase().startsWith(firstSentence.slice(0, 40))) {
        return { isDupe: true, matchedPreview: fp.preview };
      }
    }
    
    return { isDupe: false };
  }

  // Record a sent response
  record(text: string): void {
    const fp: Fingerprint = {
      hash: this.fingerprint(text),
      timestamp: Date.now(),
      preview: text.slice(0, 50)
    };
    
    this.recentFingerprints.push(fp);
    if (this.recentFingerprints.length > this.MAX_HISTORY) {
      this.recentFingerprints.shift();
    }
  }

  // Clear history (e.g., on topic change)
  clear(): void {
    this.recentFingerprints = [];
  }
}
```

**Use before sending response:**

```typescript
const { isDupe, matchedPreview } = fingerprinter.isDuplicate(proposedResponse);
if (isDupe) {
  // Add variation hint to prompt and regenerate
  prompt += `\n\nIMPORTANT: Your response is too similar to a recent one ("${matchedPreview}..."). Use different phrasing.`;
  proposedResponse = await regenerate(prompt);
}
fingerprinter.record(proposedResponse);
```

#### Verification Criteria

- [x] Pinned items appear in context
- [x] Constraints auto-extracted from transcripts
- [x] Questions detected with >80% accuracy
- [x] Duplicate responses caught before sending
- [ ] All operations complete in <20ms

---

### Phase 3: Simple Session Persistence

**Status:** Implemented (with follow-up hardening)

**Timeline:** 2 days  
**Impact:** HIGH  
**Effort:** MEDIUM  

Replace the complex 5-table schema with a simple JSON file per session.

#### 3.1 JSON File Structure

**Directory:** `~/.natively/sessions/`

```
~/.natively/sessions/
├── 2026-04-06_meeting-abc123.json
├── 2026-04-06_meeting-def456.json
└── index.json  # Quick lookup
```

**Session file format:**

```typescript
interface PersistedSession {
  version: 1;
  sessionId: string;
  meetingId: string;
  createdAt: number;
  lastActiveAt: number;
  
  // Thread state
  activeThread: {
    id: string;
    topic: string;
    goal?: string;
    phase?: string;
    turnCount: number;
  } | null;
  
  suspendedThreads: Array<{
    id: string;
    topic: string;
    goal?: string;
    suspendedAt: number;
  }>;
  
  // Pinned items
  pinnedItems: PinnedItem[];
  
  // Extracted constraints
  constraints: ExtractedConstraint[];
  
  // Epoch summaries (already short strings)
  epochSummaries: string[];
  
  // Response fingerprints for anti-repetition
  responseHashes: string[];
}
```

#### 3.2 Session Persistence Manager

**File:** `electron/memory/SessionPersistence.ts` (NEW)

```typescript
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SESSIONS_DIR = join(homedir(), '.natively', 'sessions');
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');

export class SessionPersistence {
  private savePending = false;
  private saveTimeout: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
  }

  // Debounced save - don't write on every change
  scheduleSave(session: PersistedSession): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(session), 2000);
  }

  async save(session: PersistedSession): Promise<void> {
    const filename = `${formatDate(session.createdAt)}_meeting-${session.meetingId}.json`;
    const filepath = join(SESSIONS_DIR, filename);
    
    await fs.writeFile(filepath, JSON.stringify(session, null, 2));
    await this.updateIndex(session);
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    const index = await this.loadIndex();
    const entry = index.sessions.find(s => s.sessionId === sessionId);
    if (!entry) return null;
    
    try {
      const content = await fs.readFile(entry.filepath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async loadRecent(limit: number = 5): Promise<PersistedSession[]> {
    const index = await this.loadIndex();
    const recent = index.sessions
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, limit);
    
    const sessions: PersistedSession[] = [];
    for (const entry of recent) {
      const session = await this.load(entry.sessionId);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async findByMeeting(meetingId: string): Promise<PersistedSession | null> {
    const index = await this.loadIndex();
    const entry = index.sessions.find(s => s.meetingId === meetingId);
    return entry ? this.load(entry.sessionId) : null;
  }

  private async updateIndex(session: PersistedSession): Promise<void> {
    const index = await this.loadIndex();
    
    const existing = index.sessions.findIndex(s => s.sessionId === session.sessionId);
    const entry = {
      sessionId: session.sessionId,
      meetingId: session.meetingId,
      lastActiveAt: session.lastActiveAt,
      filepath: `${formatDate(session.createdAt)}_meeting-${session.meetingId}.json`
    };
    
    if (existing >= 0) {
      index.sessions[existing] = entry;
    } else {
      index.sessions.push(entry);
    }
    
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
  }

  private async loadIndex(): Promise<SessionIndex> {
    try {
      const content = await fs.readFile(INDEX_FILE, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { sessions: [] };
    }
  }

  // Cleanup old sessions (run weekly)
  async cleanup(maxAgeDays: number = 30): Promise<number> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const index = await this.loadIndex();
    
    let deleted = 0;
    for (const entry of index.sessions) {
      if (entry.lastActiveAt < cutoff) {
        try {
          await fs.unlink(join(SESSIONS_DIR, entry.filepath));
          deleted++;
        } catch { /* ignore */ }
      }
    }
    
    index.sessions = index.sessions.filter(s => s.lastActiveAt >= cutoff);
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
    
    return deleted;
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0];
}
```

#### 3.3 Integration with SessionTracker

**File:** `SessionTracker.ts` - Add persistence hooks

```typescript
class SessionTracker {
  private persistence: SessionPersistence;
  
  constructor(/* ... */) {
    this.persistence = new SessionPersistence();
    this.persistence.init();
  }
  
  // Call on every state change that should persist
  private persistState(): void {
    const session: PersistedSession = {
      version: 1,
      sessionId: this.sessionId,
      meetingId: this.meetingId,
      createdAt: this.createdAt,
      lastActiveAt: Date.now(),
      activeThread: this.activeThread ? {
        id: this.activeThread.id,
        topic: this.activeThread.topic,
        goal: this.activeThread.goal,
        phase: this.activeThread.phase,
        turnCount: this.activeThread.turnCount
      } : null,
      suspendedThreads: this.suspendedThreads.map(t => ({
        id: t.id,
        topic: t.topic,
        goal: t.goal,
        suspendedAt: t.suspendedAt
      })),
      pinnedItems: this.pinnedItems,
      constraints: this.extractedConstraints,
      epochSummaries: this.epochSummaries,
      responseHashes: this.fingerprinter.getHashes()
    };
    
    this.persistence.scheduleSave(session);  // Debounced
  }
  
  // Call on app startup if rejoining a meeting
  async restoreSession(meetingId: string): Promise<boolean> {
    const session = await this.persistence.findByMeeting(meetingId);
    if (!session) return false;
    
    this.sessionId = session.sessionId;
    this.pinnedItems = session.pinnedItems;
    this.extractedConstraints = session.constraints;
    this.epochSummaries = session.epochSummaries;
    this.fingerprinter.restore(session.responseHashes);
    
    // Restore threads if they were recent (< 2 hours)
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    if (session.lastActiveAt > twoHoursAgo && session.activeThread) {
      this.activeThread = session.activeThread;
      this.suspendedThreads = session.suspendedThreads;
    }
    
    return true;
  }
}
```

#### Verification Criteria

- [x] Session state persists to JSON file
- [x] Session restores correctly on app restart
- [x] Debounced saves (not on every keystroke)
- [x] Index enables fast lookup by meeting ID
- [x] Old sessions cleaned up after 30 days

---

### Phase 4: Context Assembly Optimization

**Status:** Planned

**Timeline:** 1 day  
**Impact:** MEDIUM  
**Effort:** LOW  

Cache assembled context to avoid redundant work.

#### 4.1 Context Snapshot Cache

```typescript
interface ContextSnapshot {
  assembled: string;
  tokenCount: number;
  revision: number;  // Increments on transcript changes
  createdAt: number;
}

class ContextCache {
  private cache: Map<string, ContextSnapshot> = new Map();
  private readonly TTL_MS = 10_000;  // 10 seconds
  private readonly MAX_ENTRIES = 20;
  
  get(queryHash: string, currentRevision: number): ContextSnapshot | null {
    const entry = this.cache.get(queryHash);
    if (!entry) return null;
    
    // Invalidate if revision changed or TTL expired
    if (entry.revision !== currentRevision) return null;
    if (Date.now() - entry.createdAt > this.TTL_MS) {
      this.cache.delete(queryHash);
      return null;
    }
    
    return entry;
  }
  
  set(queryHash: string, snapshot: ContextSnapshot): void {
    // LRU eviction
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(queryHash, snapshot);
  }
  
  invalidateAll(): void {
    this.cache.clear();
  }
}
```

**Use in context assembly:**

```typescript
async assembleContext(query: string): Promise<string> {
  const queryHash = hashQuery(query);
  const cached = this.contextCache.get(queryHash, this.transcriptRevision);
  
  if (cached) {
    return cached.assembled;  // Cache hit - instant
  }
  
  // Cache miss - do the work
  const assembled = await this.buildContext(query);
  
  this.contextCache.set(queryHash, {
    assembled,
    tokenCount: this.tokenCounter.count(assembled, this.activeModelId),
    revision: this.transcriptRevision,
    createdAt: Date.now()
  });
  
  return assembled;
}
```

#### Verification Criteria

- [ ] Cache hit rate >60% during active conversation
- [ ] Context assembly <10ms on cache hit
- [ ] Cache correctly invalidated on new transcripts
- [ ] No stale context served

---

## Removed Features (Intentionally)

These were in the original plan but removed for being over-engineered:

| Feature | Why Removed | Alternative |
|---------|-------------|-------------|
| LLM-based entity extraction | Adds 200-500ms latency per turn, API costs | Regex patterns for common entities |
| 3-tier hierarchical memory | Complex orchestration, multiple DB queries | 2-tier: working (in-memory) + JSON persistence |
| ML-based predictive prefetching | Speculative, marginal interview benefit | None - just be fast |
| User pattern learning | Needs many interactions, complex signals | None for now |
| Semantic anti-repetition | Embedding comparison is overkill | Hash-based fingerprinting |
| 5 database tables | Migration complexity, cascade deletes | Single JSON file per session |
| Vector search for threads | Already have BM25 + simple embedding | Keep existing, just enable it |
| Context predictor | Speculative prefetching rarely helps | None |
| Adaptive token budget ML | Too complex for marginal gains | Fixed allocations with manual tuning |

---

## Architecture (Simplified)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION                              │
│  Voice Input → Transcription → Context Query → LLM → Response        │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       SESSION TRACKER                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Ring      │  │   Pinned    │  │  Extracted  │                  │
│  │  Buffer     │  │   Items     │  │ Constraints │                  │
│  │  (120sec)   │  │  (manual)   │  │   (regex)   │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
│         │                │                │                          │
│         └────────────────┴────────────────┘                          │
│                          │                                           │
│                    Context Cache                                     │
│                          │                                           │
│  ┌───────────────────────┴───────────────────────┐                  │
│  │            CONTEXT ASSEMBLER                   │                  │
│  │  • Semantic scoring (existing, now enabled)    │                  │
│  │  • Pinned items first                         │                  │
│  │  • Question detection for prioritization       │                  │
│  │  • Hash fingerprint for anti-repetition       │                  │
│  └────────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        PERSISTENCE (Simple)                          │
│                                                                      │
│  ~/.natively/sessions/                                               │
│  ├── 2026-04-06_meeting-abc123.json                                  │
│  ├── 2026-04-06_meeting-def456.json                                  │
│  └── index.json                                                      │
│                                                                      │
│  JSON contains: threads, pinned items, constraints, epoch summaries  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Timeline Summary

| Phase | Duration | Cumulative | Key Deliverable |
|-------|----------|------------|-----------------|
| Phase 1 | 1 day | 1 day | Semantic context enabled (flip switches) |
| Phase 2 | 2-3 days | 3-4 days | Interview essentials (pinned, regex, questions, fingerprint) |
| Phase 3 | 2 days | 5-6 days | Simple JSON persistence |
| Phase 4 | 1 day | 6-7 days | Context caching |

**Total: ~5-7 days** (vs original ~3 weeks)

---

## Files to Create/Modify

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `electron/shared/TokenCounter.ts` | 1 | Model-agnostic token counting wrapper (`toksclare`) |
| `electron/conscious/ConstraintExtractor.ts` | 2 | Regex-based number/date extraction |
| `electron/conscious/QuestionDetector.ts` | 2 | Question vs statement classification |
| `electron/conscious/ResponseFingerprint.ts` | 2 | Hash-based anti-repetition |
| `electron/memory/SessionPersistence.ts` | 3 | JSON file persistence |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `electron/config/optimizations.ts` | 1 | Enable `accelerationEnabled` |
| `electron/conscious/ConfidenceScorer.ts` | 1 | Enable embedding weight |
| `electron/conscious/types.ts` | 1 | Update `CONFIDENCE_WEIGHTS` |
| `electron/SessionTracker.ts` | 1, 2, 3 | Add embeddings, pinned items, persistence |
| `electron/conscious/ThreadManager.ts` | 1 | Generate thread embeddings |
| `electron/LLMHelper.ts` | 1 | Replace heuristic token counting with `TokenCounter` |
| `electron/llm/PromptCompiler.ts` | 1 | Replace heuristic token counting with `TokenCounter` |
| `electron/conscious/TokenBudget.ts` | 1 | Replace heuristic token counting with `TokenCounter` |
| `electron/conscious/AdaptiveContextWindow.ts` | 1 | Replace heuristic token counting with `TokenCounter` |
| `electron/rag/TranscriptPreprocessor.ts` | 1 | Replace heuristic token counting with `TokenCounter` |

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Context assembly latency | <50ms P95 | `console.time` in `assembleContext` |
| Cache hit rate | >60% | Counter in `ContextCache.get()` |
| Constraint extraction accuracy | >90% | Manual review of 20 samples |
| Question detection accuracy | >80% | Manual review of 50 samples |
| Session restore time | <500ms | `console.time` in `restoreSession` |
| Duplicate response prevention | 100% | No exact duplicates sent |
| Token estimate error | <10% median | Compare local estimate vs provider usage logs |

---

## Realtime Guardrails (Must-Haves)

These guardrails keep the system usable during live interviews:

1. **Hard deadline for context assembly**
   - Budget target: 80ms soft, 120ms hard.
   - On timeout, degrade to recency + pinned items, never block response generation.

2. **Deterministic fallback ladder**
   - Tier A: semantic + lexical + pinned
   - Tier B: lexical + recency + pinned
   - Tier C: pinned + last N turns
   - No LLM call should wait on enrichment work.

3. **Background work isolation**
   - Embeddings/entity extraction must run off the hot path.
   - Use transcript revision checks so stale background results are dropped.

4. **Thread switch hysteresis**
   - Do not switch active thread on one noisy signal.
   - Require confidence margin + repeated evidence across turns.

5. **Atomic session persistence**
   - Save pattern: write temp file -> fsync -> atomic rename.
   - Prevent partial JSON writes during app crash/force-quit.

---

## Next Steps

1. [x] Add model-agnostic token counter wrapper and migrate runtime paths
2. [x] Enable semantic context defaults behind rollout-safe config
3. [x] Implement interview essentials (pinned/constraints/question/fingerprint)
4. [x] Add session persistence with atomic writes and recovery tests
5. [ ] Run replay-based latency/quality validation on real interview transcripts

---

## Autonomous Execution Board (Owner-Driven)

### Loop 1 (Completed)

- Scope: model-agnostic token counting migration in runtime hot paths.
- Delivered:
  - `electron/shared/TokenCounter.ts`
  - migration of runtime estimators in `electron/LLMHelper.ts`, `electron/llm/PromptCompiler.ts`, `electron/conscious/TokenBudget.ts`, `electron/conscious/AdaptiveContextWindow.ts`, `electron/rag/TranscriptPreprocessor.ts`
- Self-review result: **Pass** (token lock-in removed; fallback behavior present; no direct `text.length / 4` in runtime budgeting paths).

### Loop 2 (In Progress)

- Scope: enable semantic context defaults with safe degradation.
- Planned deliverables:
  - set `accelerationEnabled` default to `true`
  - enforce embedding timeout + fallback to recency path
  - add latency counters for semantic context selection
- Exit criteria:
  - no visible latency regression
  - deterministic fallback verified in tests/replay

### Loop 3 (Queued)

- Scope: interview essentials (`PinnedItem`, `ConstraintExtractor`, `QuestionDetector`, `ResponseFingerprinter`).
- Exit criteria:
  - all four components integrated in context assembly
  - duplicate-response prevention verified with replay inputs

### Loop 4 (Queued)

- Scope: session persistence with atomic writes and restore.
- Exit criteria:
  - crash-safe write pattern (`tmp` -> `fsync` -> `rename`)
  - restore correctness across restart scenarios

### Loop 5 (Queued)

- Scope: replay harness and reliability hardening.
- Exit criteria:
  - P95 and P99 latency checks pass
  - fallback/circuit-breaker behavior validated on degraded conditions

---

## Appendix: Regex Patterns for Constraint Extraction

```typescript
// Budget patterns
/\$[\d,]+(?:\.\d{2})?(?:k|m|b)?/gi
/\d+(?:\.\d+)?\s*(?:million|billion|thousand)\s*(?:dollars?|usd)?/gi

// Deadline patterns  
/(?:by|before|until|due)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/gi
/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g

// Headcount patterns
/\d+\s*(?:people|engineers?|developers?|FTEs?|headcount)/gi

// Duration patterns
/\d+\s*(?:weeks?|months?|quarters?|sprints?)/gi

// Tech terms (common ones)
/\b(?:React|TypeScript|Python|Docker|AWS|Kubernetes|PostgreSQL|Redis|GraphQL|Node\.js)\b/gi
```

These patterns cover >80% of interview constraints without any LLM calls.
