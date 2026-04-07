# Memory & Context System Implementation Plan

**Created:** 2026-04-06  
**Status:** Draft - Pending Approval  
**Goal:** Make memory and context maximally powerful and useful in real-time

---

## Executive Summary

This document outlines a comprehensive plan to transform Natively from a session-bound assistant into an intelligent memory system that:

- Understands context semantically (not just by recency)
- Remembers across sessions
- Learns user patterns and preferences
- Retrieves the right information at the right time in real-time

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

### Key Limitations

1. **Semantic similarity scoring is disabled** - infrastructure exists but `accelerationEnabled: false`
2. **No cross-session persistence** - all thread/context state is in-memory
3. **No long-term memory** - user preferences and history don't persist
4. **Embeddings not computed for live context** - only meeting transcripts get embedded
5. **Entity bucket in token budget is never populated**

### Files to Modify

| Category | Files |
|----------|-------|
| Core Context | `SessionTracker.ts`, `AdaptiveContextWindow.ts` |
| Thread System | `ThreadManager.ts`, `ConfidenceScorer.ts` |
| Token Budget | `TokenBudget.ts` |
| Database | `DatabaseManager.ts` |
| Config | `electron/config/optimizations.ts` |
| Anti-Repetition | `TemporalContextBuilder.ts` |

---

## Implementation Phases

### Phase 1: Enable Existing Infrastructure (Quick Wins)

**Timeline:** 1-2 days  
**Impact:** HIGH  
**Effort:** LOW  
**Dependencies:** None

#### 1.1 Enable Semantic Context Window

**File:** `electron/config/optimizations.ts`

```typescript
// BEFORE
export const defaultOptimizations = {
  accelerationEnabled: false,  // Master toggle OFF
  // ...
};

// AFTER
export const defaultOptimizations = {
  accelerationEnabled: true,   // Enable by default
  // OR: Add runtime toggle in settings UI
};
```

**File:** `SessionTracker.ts` (line ~452)

```typescript
// BEFORE
const candidates: ContextEntry[] = this.getContextItems().map((item) => ({
  text: item.text,
  timestamp: item.timestamp,
  phase: undefined,
  // embedding not populated!
}));

// AFTER
async getAdaptiveContext(config: AdaptiveContextConfig): Promise<ContextEntry[]> {
  const items = this.getContextItems();
  
  // Batch embed all items for efficiency
  const texts = items.map(i => i.text);
  const embeddings = await this.embeddingPipeline.embedBatch(texts);
  
  const candidates: ContextEntry[] = items.map((item, i) => ({
    text: item.text,
    timestamp: item.timestamp,
    phase: this.detectPhase(item),
    embedding: embeddings[i],
  }));
  
  return this.adaptiveWindow.selectContext(candidates, config);
}
```

#### 1.2 Enable Thread Semantic Matching

**File:** `ConfidenceScorer.ts`

```typescript
// BEFORE
const CONFIDENCE_WEIGHTS = {
  bm25: 0.25,
  embedding: 0.0,  // DISABLED
  // ...
};

// AFTER
const CONFIDENCE_WEIGHTS = {
  bm25: 0.20,
  embedding: 0.25,  // ENABLED
  // ... (rebalance other weights)
};
```

**File:** `ThreadManager.ts` - Add embedding generation:

```typescript
async suspendActive(): Promise<void> {
  if (this.activeThread) {
    // Generate embedding for thread topic
    this.activeThread.embedding = await this.embeddingPipeline.embed(
      `${this.activeThread.topic} ${this.activeThread.goal}`
    );
    this.activeThread.status = 'suspended';
    this.suspendedThreads.push(this.activeThread);
    // ...
  }
}
```

#### 1.3 Performance Safeguards

- Cache embeddings per context item (keyed by text hash)
- Background embedding computation (non-blocking)
- Fallback to recency-only if embedding latency >100ms
- Use worker thread for embedding (already exists in `VectorStore.ts`)

#### Verification Criteria

- [ ] `accelerationEnabled` is true by default or has UI toggle
- [ ] Context items have embeddings populated
- [ ] AdaptiveContextWindow uses semantic scoring
- [ ] Thread matching uses embedding similarity
- [ ] No perceptible latency increase in UI

---

### Phase 2: Cross-Session Memory Persistence

**Timeline:** 3-5 days  
**Impact:** VERY HIGH  
**Effort:** MEDIUM  
**Dependencies:** Phase 1

#### 2.1 Database Schema

**New Migration:** `migrations/xxx_add_memory_tables.ts`

```sql
-- Persistent thread storage
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  goal TEXT,
  phase TEXT,
  key_decisions TEXT,        -- JSON array
  constraints TEXT,          -- JSON array
  code_context TEXT,         -- JSON array of {language, code, purpose}
  resume_keywords TEXT,      -- JSON array
  embedding BLOB,            -- Float32 array
  turn_count INTEGER DEFAULT 0,
  resume_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'expired'))
);

CREATE INDEX idx_threads_status ON conversation_threads(status);
CREATE INDEX idx_threads_last_active ON conversation_threads(last_active_at);

-- Long-term conversation history
CREATE TABLE IF NOT EXISTS conversation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT REFERENCES conversation_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  embedding BLOB,
  timestamp INTEGER NOT NULL,
  importance_score REAL DEFAULT 0.5,
  metadata TEXT  -- JSON for extensibility
);

CREATE INDEX idx_history_thread ON conversation_history(thread_id);
CREATE INDEX idx_history_timestamp ON conversation_history(timestamp);

-- Entity memory
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('person', 'technology', 'concept', 'project', 'company')),
  aliases TEXT,              -- JSON array
  first_mentioned INTEGER NOT NULL,
  last_mentioned INTEGER NOT NULL,
  mention_count INTEGER DEFAULT 1,
  context_summary TEXT,
  embedding BLOB,
  UNIQUE(name, type)
);

CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_last_mentioned ON entities(last_mentioned);

-- User learning/preferences
CREATE TABLE IF NOT EXISTS user_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT NOT NULL,  -- 'communication_style', 'expertise', 'preference'
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  evidence_count INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(pattern_type, key)
);

-- Vector search tables (using sqlite-vec)
-- Created dynamically based on embedding dimension
```

#### 2.2 Thread Persistence Layer

**New File:** `electron/memory/ThreadPersistence.ts`

```typescript
import { DatabaseManager } from '../db/DatabaseManager';
import { ConversationThread } from '../conscious/types';

export class ThreadPersistence {
  constructor(private db: DatabaseManager) {}

  async saveThread(thread: ConversationThread): Promise<void> {
    await this.db.run(`
      INSERT OR REPLACE INTO conversation_threads 
      (id, topic, goal, phase, key_decisions, constraints, code_context, 
       resume_keywords, embedding, turn_count, resume_count, 
       created_at, last_active_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      thread.id,
      thread.topic,
      thread.goal,
      thread.phase,
      JSON.stringify(thread.keyDecisions),
      JSON.stringify(thread.constraints),
      JSON.stringify(thread.codeContext),
      JSON.stringify(thread.resumeKeywords),
      thread.embedding ? Buffer.from(new Float32Array(thread.embedding).buffer) : null,
      thread.turnCount,
      thread.resumeCount,
      thread.createdAt,
      thread.lastActiveAt,
      thread.expiresAt,
      thread.status
    ]);
  }

  async loadThread(id: string): Promise<ConversationThread | null> {
    const row = await this.db.get(
      'SELECT * FROM conversation_threads WHERE id = ?',
      [id]
    );
    return row ? this.rowToThread(row) : null;
  }

  async findSimilarThreads(
    embedding: number[],
    limit: number = 5
  ): Promise<ConversationThread[]> {
    // Use sqlite-vec for vector similarity search
    const rows = await this.db.all(`
      SELECT t.*, vec_distance_cosine(t.embedding, ?) as distance
      FROM conversation_threads t
      WHERE t.status != 'expired' AND t.embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ?
    `, [Buffer.from(new Float32Array(embedding).buffer), limit]);
    
    return rows.map(this.rowToThread);
  }

  async getRecentThreads(
    limit: number = 10,
    maxAgeDays: number = 7
  ): Promise<ConversationThread[]> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const rows = await this.db.all(`
      SELECT * FROM conversation_threads
      WHERE last_active_at > ? AND status != 'expired'
      ORDER BY last_active_at DESC
      LIMIT ?
    `, [cutoff, limit]);
    
    return rows.map(this.rowToThread);
  }

  async expireOldThreads(maxAgeDays: number = 30): Promise<number> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const result = await this.db.run(`
      UPDATE conversation_threads
      SET status = 'expired'
      WHERE last_active_at < ? AND status != 'expired'
    `, [cutoff]);
    
    return result.changes;
  }

  private rowToThread(row: any): ConversationThread {
    return {
      id: row.id,
      topic: row.topic,
      goal: row.goal,
      phase: row.phase,
      keyDecisions: JSON.parse(row.key_decisions || '[]'),
      constraints: JSON.parse(row.constraints || '[]'),
      codeContext: JSON.parse(row.code_context || '{}'),
      resumeKeywords: JSON.parse(row.resume_keywords || '[]'),
      embedding: row.embedding ? 
        Array.from(new Float32Array(row.embedding.buffer)) : undefined,
      turnCount: row.turn_count,
      resumeCount: row.resume_count,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      expiresAt: row.expires_at,
      status: row.status
    };
  }
}
```

#### 2.3 Session Restore Flow

**Modified:** `electron/main.ts` or app initialization

```typescript
async function initializeMemorySystem(): Promise<void> {
  const memoryManager = new MemoryManager(db);
  
  // 1. Load user patterns
  const userPatterns = await memoryManager.loadUserPatterns();
  
  // 2. Load recent threads (last 24 hours)
  const recentThreads = await memoryManager.loadRecentThreads(24);
  
  // 3. Reconstruct ThreadManager state
  threadManager.restoreFromPersisted(recentThreads);
  
  // 4. Load epoch summaries
  const epochSummaries = await memoryManager.loadEpochSummaries();
  sessionTracker.restoreEpochSummaries(epochSummaries);
  
  console.log(`Memory restored: ${recentThreads.length} threads, ${userPatterns.length} patterns`);
}
```

#### Verification Criteria

- [ ] Database tables created via migration
- [ ] Threads persist across app restarts
- [ ] Thread search by embedding works
- [ ] Old threads expire correctly
- [ ] Session restore completes in <1 second

---

### Phase 3: Intelligent Entity Memory

**Timeline:** 2-3 days  
**Impact:** HIGH  
**Effort:** MEDIUM  
**Dependencies:** Phase 2

#### 3.1 Entity Extraction Pipeline

**New File:** `electron/memory/EntityExtractor.ts`

```typescript
import { LLMHelper } from '../llm/LLMHelper';

export interface Entity {
  name: string;
  type: 'person' | 'technology' | 'concept' | 'project' | 'company';
  aliases: string[];
  importance: number;  // 0-1
  contextSummary?: string;
  embedding?: number[];
}

export class EntityExtractor {
  // Pattern-based extraction for common entity types
  private patterns = {
    technology: /\b(React|TypeScript|Python|Docker|AWS|Kubernetes|Node\.js|PostgreSQL|Redis|GraphQL)\b/gi,
    // Add more patterns as needed
  };

  constructor(
    private llm: LLMHelper,
    private db: DatabaseManager
  ) {}

  async extract(text: string): Promise<Entity[]> {
    const entities: Entity[] = [];
    
    // 1. Pattern-based extraction (fast)
    for (const [type, pattern] of Object.entries(this.patterns)) {
      const matches = text.match(pattern) || [];
      for (const match of new Set(matches)) {
        entities.push({
          name: match,
          type: type as Entity['type'],
          aliases: [],
          importance: 0.5
        });
      }
    }
    
    // 2. LLM-based extraction for complex entities (if text is substantial)
    if (text.length > 100) {
      const llmEntities = await this.extractWithLLM(text);
      entities.push(...llmEntities);
    }
    
    return this.deduplicateEntities(entities);
  }

  private async extractWithLLM(text: string): Promise<Entity[]> {
    const prompt = `Extract named entities from this text. Return JSON array:
[{"name": "entity name", "type": "person|technology|concept|project|company", "importance": 0.0-1.0}]

Text: "${text.slice(0, 500)}"

Return only the JSON array, no explanation.`;

    try {
      const response = await this.llm.complete(prompt, { maxTokens: 200 });
      return JSON.parse(response);
    } catch {
      return [];
    }
  }

  async mergeEntities(newEntities: Entity[]): Promise<void> {
    for (const entity of newEntities) {
      await this.db.run(`
        INSERT INTO entities (name, type, aliases, first_mentioned, last_mentioned, mention_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(name, type) DO UPDATE SET
          last_mentioned = excluded.last_mentioned,
          mention_count = mention_count + 1
      `, [
        entity.name,
        entity.type,
        JSON.stringify(entity.aliases),
        Date.now(),
        Date.now()
      ]);
    }
  }

  async getRelevantEntities(
    query: string,
    limit: number = 10
  ): Promise<Entity[]> {
    // Get entities mentioned in query
    const queryEntities = await this.extract(query);
    const queryNames = queryEntities.map(e => e.name.toLowerCase());
    
    // Find related entities from memory
    const rows = await this.db.all(`
      SELECT * FROM entities
      WHERE LOWER(name) IN (${queryNames.map(() => '?').join(',')})
         OR last_mentioned > ?
      ORDER BY mention_count DESC, last_mentioned DESC
      LIMIT ?
    `, [...queryNames, Date.now() - 3600000, limit]);  // Last hour
    
    return rows.map(row => ({
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases || '[]'),
      importance: Math.min(row.mention_count / 10, 1.0),
      contextSummary: row.context_summary
    }));
  }

  private deduplicateEntities(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase()}`;
      if (!seen.has(key) || entity.importance > seen.get(key)!.importance) {
        seen.set(key, entity);
      }
    }
    return Array.from(seen.values());
  }
}
```

#### 3.2 Integration with Context Assembly

**Modified:** `IntelligenceEngine.ts` or context assembly point

```typescript
async assembleContext(query: string): Promise<AssembledContext> {
  // Get entity context (uses the entities token bucket)
  const relevantEntities = await this.entityExtractor.getRelevantEntities(query);
  
  const entityContext = relevantEntities.map(e => 
    `[${e.type}] ${e.name}: ${e.contextSummary || 'No summary'}`
  ).join('\n');
  
  return {
    // ... other context
    entities: entityContext,
    entityTokens: this.tokenBudget.allocate('entities', entityContext)
  };
}
```

#### 3.3 Background Entity Processing

```typescript
// In SessionTracker or dedicated worker
onNewTranscriptSegment(segment: TranscriptSegment): void {
  // Non-blocking entity extraction
  setImmediate(async () => {
    const entities = await this.entityExtractor.extract(segment.text);
    await this.entityExtractor.mergeEntities(entities);
  });
}
```

#### Verification Criteria

- [ ] Entities extracted from transcripts
- [ ] Entity deduplication works
- [ ] Relevant entities retrieved for queries
- [ ] Entity context included in LLM prompts
- [ ] No perceptible latency from entity processing

---

### Phase 4: Hierarchical Memory Architecture

**Timeline:** 3-4 days  
**Impact:** VERY HIGH  
**Effort:** HIGH  
**Dependencies:** Phases 2, 3

#### 4.1 Three-Tier Memory Model

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY (Tier 1)                  │
│  Ring Buffer + Active Thread + Recent Transcript            │
│  Retention: 120 seconds | Access: Instant (<10ms)           │
└─────────────────────────────────────────────────────────────┘
                              ↓ Compaction (every 1800 entries)
┌─────────────────────────────────────────────────────────────┐
│                   SESSION MEMORY (Tier 2)                   │
│  Epoch Summaries + Suspended Threads + Session Entities     │
│  Retention: Current session | Access: Fast (<100ms)         │
└─────────────────────────────────────────────────────────────┘
                              ↓ Persistence (on thread suspend/session end)
┌─────────────────────────────────────────────────────────────┐
│                   LONG-TERM MEMORY (Tier 3)                 │
│  SQLite + Vector Search: Threads, Entities, User Patterns   │
│  Retention: Indefinite | Access: Async (<500ms)             │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2 Memory Manager

**New File:** `electron/memory/MemoryManager.ts`

```typescript
import { SessionTracker } from '../SessionTracker';
import { ThreadPersistence } from './ThreadPersistence';
import { EntityExtractor } from './EntityExtractor';
import { VectorStore } from '../rag/VectorStore';

export interface ContextOptions {
  tokenBudget: number;
  workingMemoryWeight: number;   // Default: 0.4
  sessionMemoryWeight: number;   // Default: 0.35
  longTermMemoryWeight: number;  // Default: 0.25
}

export interface UnifiedContext {
  workingMemory: ContextEntry[];
  sessionMemory: ContextEntry[];
  longTermMemory: ContextEntry[];
  entities: Entity[];
  merged: string;  // Final assembled context string
  tokenCount: number;
}

export class MemoryManager {
  constructor(
    private sessionTracker: SessionTracker,
    private threadPersistence: ThreadPersistence,
    private entityExtractor: EntityExtractor,
    private vectorStore: VectorStore
  ) {}

  async getContext(
    query: string,
    options: Partial<ContextOptions> = {}
  ): Promise<UnifiedContext> {
    const opts: ContextOptions = {
      tokenBudget: 4000,
      workingMemoryWeight: 0.4,
      sessionMemoryWeight: 0.35,
      longTermMemoryWeight: 0.25,
      ...options
    };

    // Parallel retrieval from all memory tiers
    const [workingCtx, sessionCtx, longTermCtx, entities] = await Promise.all([
      this.getWorkingMemoryContext(query, opts),
      this.getSessionMemoryContext(query, opts),
      this.getLongTermMemoryContext(query, opts),
      this.entityExtractor.getRelevantEntities(query, 10)
    ]);

    // Merge and rank by multi-factor scoring
    const merged = this.mergeAndRank(
      workingCtx, sessionCtx, longTermCtx, entities, opts
    );

    return {
      workingMemory: workingCtx,
      sessionMemory: sessionCtx,
      longTermMemory: longTermCtx,
      entities,
      merged: this.assembleContextString(merged, entities),
      tokenCount: this.estimateTokens(merged)
    };
  }

  private async getWorkingMemoryContext(
    query: string,
    opts: ContextOptions
  ): Promise<ContextEntry[]> {
    const budget = Math.floor(opts.tokenBudget * opts.workingMemoryWeight);
    return this.sessionTracker.getAdaptiveContext({
      tokenBudget: budget,
      query
    });
  }

  private async getSessionMemoryContext(
    query: string,
    opts: ContextOptions
  ): Promise<ContextEntry[]> {
    // Epoch summaries + suspended thread contexts
    const epochSummaries = this.sessionTracker.getEpochSummaries();
    const suspendedThreads = this.sessionTracker.getSuspendedThreads();
    
    return [
      ...epochSummaries.map(s => ({ text: s, timestamp: Date.now(), source: 'epoch' })),
      ...suspendedThreads.map(t => ({ 
        text: `[Thread: ${t.topic}] ${t.goal}`, 
        timestamp: t.lastActiveAt,
        source: 'thread'
      }))
    ];
  }

  private async getLongTermMemoryContext(
    query: string,
    opts: ContextOptions
  ): Promise<ContextEntry[]> {
    // Vector search in long-term storage
    const embedding = await this.vectorStore.embed(query);
    const similarThreads = await this.threadPersistence.findSimilarThreads(
      embedding, 
      5
    );
    
    return similarThreads.map(t => ({
      text: `[Historical Thread: ${t.topic}] ${t.goal}`,
      timestamp: t.lastActiveAt,
      source: 'longterm',
      similarity: t.similarity
    }));
  }

  private mergeAndRank(
    working: ContextEntry[],
    session: ContextEntry[],
    longTerm: ContextEntry[],
    entities: Entity[],
    opts: ContextOptions
  ): ContextEntry[] {
    const all = [
      ...working.map(c => ({ ...c, tier: 'working', tierWeight: opts.workingMemoryWeight })),
      ...session.map(c => ({ ...c, tier: 'session', tierWeight: opts.sessionMemoryWeight })),
      ...longTerm.map(c => ({ ...c, tier: 'longterm', tierWeight: opts.longTermMemoryWeight }))
    ];

    // Multi-factor scoring
    const scored = all.map(entry => ({
      ...entry,
      score: this.computeScore(entry, entities)
    }));

    // Sort by score, then fit to budget
    scored.sort((a, b) => b.score - a.score);
    
    return this.fitToBudget(scored, opts.tokenBudget);
  }

  private computeScore(entry: ContextEntry, entities: Entity[]): number {
    const recencyScore = this.computeRecency(entry.timestamp);
    const semanticScore = entry.similarity || 0.5;
    const entityOverlap = this.computeEntityOverlap(entry.text, entities);
    const tierWeight = entry.tierWeight || 0.3;

    // Weighted combination
    return (
      0.30 * recencyScore +
      0.35 * semanticScore +
      0.15 * entityOverlap +
      0.20 * tierWeight
    );
  }

  private computeRecency(timestamp: number): number {
    const age = Date.now() - timestamp;
    const halfLife = 120000; // 2 minutes in ms
    return Math.exp(-age / halfLife);
  }

  private computeEntityOverlap(text: string, entities: Entity[]): number {
    const textLower = text.toLowerCase();
    const matches = entities.filter(e => 
      textLower.includes(e.name.toLowerCase())
    );
    return Math.min(matches.length / Math.max(entities.length, 1), 1.0);
  }

  private fitToBudget(entries: ContextEntry[], budget: number): ContextEntry[] {
    const result: ContextEntry[] = [];
    let tokenCount = 0;
    
    for (const entry of entries) {
      const entryTokens = this.estimateTokens(entry.text);
      if (tokenCount + entryTokens <= budget) {
        result.push(entry);
        tokenCount += entryTokens;
      }
    }
    
    return result;
  }

  private estimateTokens(text: string | ContextEntry[]): number {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    return text.reduce((sum, e) => sum + this.estimateTokens(e.text), 0);
  }

  private assembleContextString(entries: ContextEntry[], entities: Entity[]): string {
    const entitySection = entities.length > 0 
      ? `\n<entities>\n${entities.map(e => `- ${e.name} (${e.type})`).join('\n')}\n</entities>\n`
      : '';
    
    const contextSection = entries.map(e => e.text).join('\n\n');
    
    return `${entitySection}\n<context>\n${contextSection}\n</context>`;
  }

  // Background sync
  async syncToLongTerm(): Promise<void> {
    const threads = this.sessionTracker.getAllThreads();
    for (const thread of threads) {
      await this.threadPersistence.saveThread(thread);
    }
  }

  // Proactive prefetch
  async prefetchRelated(currentContext: string): Promise<void> {
    // Extract potential next topics
    const entities = await this.entityExtractor.extract(currentContext);
    
    // Prefetch related threads for these entities
    for (const entity of entities.slice(0, 3)) {
      const embedding = await this.vectorStore.embed(entity.name);
      await this.threadPersistence.findSimilarThreads(embedding, 3);
      // Results are cached by the database connection
    }
  }
}
```

#### Verification Criteria

- [ ] Three memory tiers working independently
- [ ] Unified context retrieval works
- [ ] Multi-factor scoring produces sensible rankings
- [ ] Token budget respected
- [ ] Background sync doesn't block UI

---

### Phase 5: Real-Time Intelligence Layer

**Timeline:** 2-3 days  
**Impact:** HIGH  
**Effort:** MEDIUM  
**Dependencies:** Phase 4

#### 5.1 Predictive Context Prefetching

**New File:** `electron/memory/ContextPredictor.ts`

```typescript
export class ContextPredictor {
  private predictionCache = new Map<string, string[]>();
  
  async predictNextTopics(recentHistory: Message[]): Promise<string[]> {
    if (recentHistory.length < 2) return [];
    
    // Simple heuristic: extract nouns and verbs from recent messages
    const recentText = recentHistory.slice(-5).map(m => m.content).join(' ');
    const entities = await this.entityExtractor.extract(recentText);
    
    // Predict related topics based on entities
    const predictions = entities.map(e => e.name);
    
    // Cache for deduplication
    const cacheKey = recentHistory.slice(-2).map(m => m.content).join('|');
    this.predictionCache.set(cacheKey, predictions);
    
    return predictions;
  }

  async prefetchForTopics(topics: string[]): Promise<void> {
    // Fire and forget - don't block
    Promise.all(topics.map(async topic => {
      const embedding = await this.vectorStore.embed(topic);
      await this.threadPersistence.findSimilarThreads(embedding, 3);
    })).catch(() => {}); // Ignore errors in background prefetch
  }

  onConversationUpdate(message: Message): void {
    // Debounced prediction on new messages
    this.debouncedPredict(message);
  }

  private debouncedPredict = debounce(async (message: Message) => {
    const predictions = await this.predictNextTopics([message]);
    this.prefetchForTopics(predictions);
  }, 500);
}
```

#### 5.2 Adaptive Token Budget

**Enhanced:** `TokenBudget.ts`

```typescript
export class AdaptiveTokenBudget {
  computeAllocation(context: ConversationContext): TokenAllocation {
    const base = this.getProviderBudget(context.provider);
    
    // Detect conversation characteristics
    const isCodeHeavy = this.detectCodeHeavy(context);
    const isMultiTopic = this.detectMultiTopic(context);
    const isDeepDive = this.detectDeepDive(context);
    
    if (isCodeHeavy) {
      return this.scaleAllocation(base, {
        codeContext: 1.5,      // +50% for code
        activeThread: 0.8,     // -20% for thread
        entities: 0.5          // -50% for entities
      });
    }
    
    if (isMultiTopic) {
      return this.scaleAllocation(base, {
        suspendedThreads: 1.5, // +50% for suspended threads
        activeThread: 0.7,     // -30% for active
        epochSummaries: 1.2    // +20% for summaries
      });
    }
    
    if (isDeepDive) {
      return this.scaleAllocation(base, {
        activeThread: 1.4,     // +40% for active thread
        entities: 1.3,         // +30% for entities
        suspendedThreads: 0.5  // -50% for suspended
      });
    }
    
    return base;
  }

  private detectCodeHeavy(context: ConversationContext): boolean {
    const codePatterns = /```|function|class|const|let|import|export/g;
    const recentText = context.recentMessages.map(m => m.content).join(' ');
    const matches = recentText.match(codePatterns) || [];
    return matches.length > 5;
  }

  private detectMultiTopic(context: ConversationContext): boolean {
    return context.suspendedThreadCount >= 2;
  }

  private detectDeepDive(context: ConversationContext): boolean {
    return context.activeThreadTurnCount > 10;
  }
}
```

#### 5.3 Importance Signaling

**Integration Points:**

```typescript
// Voice command detection in transcription
const importancePatterns = [
  /remember this/i,
  /this is important/i,
  /don't forget/i,
  /key point/i
];

onTranscriptSegment(segment: TranscriptSegment): void {
  for (const pattern of importancePatterns) {
    if (pattern.test(segment.text)) {
      // Mark recent context as important
      this.sessionTracker.markImportant(segment.timestamp, {
        score: 1.0,
        reason: 'user_explicit',
        persistImmediately: true
      });
      break;
    }
  }
}
```

#### Verification Criteria

- [ ] Predictive prefetch runs in background
- [ ] Token budget adapts to conversation type
- [ ] "Remember this" voice command works
- [ ] Important items persist to long-term memory
- [ ] No latency impact from adaptive features

---

### Phase 6: Anti-Repetition & Response Quality

**Timeline:** 1-2 days  
**Impact:** MEDIUM  
**Effort:** LOW  
**Dependencies:** Phase 1 (can run in parallel with Phase 2)

#### 6.1 Semantic Anti-Repetition

**Enhanced:** `TemporalContextBuilder.ts`

```typescript
export class SemanticAntiRepetition {
  private responseEmbeddings = new Map<string, number[]>();
  
  async checkNovelty(
    proposed: string,
    history: AssistantResponse[]
  ): Promise<NoveltyScore> {
    const proposedEmbed = await this.embed(proposed);
    
    const similarities = await Promise.all(
      history.slice(-5).map(async h => {
        // Use cached embedding if available
        let historyEmbed = this.responseEmbeddings.get(h.id);
        if (!historyEmbed) {
          historyEmbed = await this.embed(h.content);
          this.responseEmbeddings.set(h.id, historyEmbed);
        }
        return this.cosineSimilarity(proposedEmbed, historyEmbed);
      })
    );
    
    const maxSimilarity = Math.max(...similarities, 0);
    
    return {
      isNovel: maxSimilarity < 0.85,
      similarityScore: maxSimilarity,
      mostSimilarIndex: similarities.indexOf(maxSimilarity),
      variationHint: this.generateVariationHint(maxSimilarity)
    };
  }

  generateVariationHint(similarity: number): string {
    if (similarity > 0.9) {
      return "IMPORTANT: Your previous response was very similar. Use completely different phrasing, structure, and examples.";
    }
    if (similarity > 0.8) {
      return "Note: Vary your phrasing from previous responses. Consider different examples or angles.";
    }
    if (similarity > 0.7) {
      return "Consider using fresh examples or alternative explanations.";
    }
    return "";
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

#### 6.2 User Pattern Learning

```typescript
// Track and learn user preferences
interface UserPattern {
  type: 'response_length' | 'technical_depth' | 'tone' | 'format';
  value: string;
  confidence: number;
}

class UserPatternLearner {
  async learnFromInteraction(
    userMessage: string,
    assistantResponse: string,
    userFeedback?: 'positive' | 'negative'
  ): Promise<void> {
    // Infer preferences from interaction patterns
    const patterns: UserPattern[] = [];
    
    // Response length preference
    if (userFeedback === 'positive' && assistantResponse.length > 500) {
      patterns.push({
        type: 'response_length',
        value: 'detailed',
        confidence: 0.6
      });
    }
    
    // Technical depth
    const technicalTerms = assistantResponse.match(/\b(API|function|class|async|await)\b/g);
    if (technicalTerms && technicalTerms.length > 3 && userFeedback !== 'negative') {
      patterns.push({
        type: 'technical_depth',
        value: 'high',
        confidence: 0.5
      });
    }
    
    // Persist learned patterns
    for (const pattern of patterns) {
      await this.db.run(`
        INSERT INTO user_patterns (pattern_type, key, value, confidence, evidence_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(pattern_type, key) DO UPDATE SET
          value = CASE WHEN excluded.confidence > confidence THEN excluded.value ELSE value END,
          confidence = (confidence * evidence_count + excluded.confidence) / (evidence_count + 1),
          evidence_count = evidence_count + 1,
          updated_at = excluded.updated_at
      `, [pattern.type, pattern.type, pattern.value, pattern.confidence, Date.now(), Date.now()]);
    }
  }

  async getPatterns(): Promise<UserPattern[]> {
    return this.db.all(`
      SELECT pattern_type as type, value, confidence
      FROM user_patterns
      WHERE confidence > 0.5
      ORDER BY confidence DESC
    `);
  }
}
```

#### Verification Criteria

- [ ] Semantic similarity detects repetitive responses
- [ ] Variation hints included in LLM prompts
- [ ] User patterns learned over time
- [ ] Patterns influence response generation
- [ ] No false positives blocking valid responses

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION                              │
│  Voice Input → Transcription → Context Query → LLM → Response        │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       MEMORY MANAGER                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Working   │  │   Session   │  │  Long-Term  │                  │
│  │   Memory    │←→│   Memory    │←→│   Memory    │                  │
│  │  (120 sec)  │  │  (session)  │  │  (persist)  │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
│         │                │                │                          │
│         └────────────────┴────────────────┘                          │
│                          │                                           │
│                    Unified Context                                   │
│                          │                                           │
│  ┌───────────────────────┴───────────────────────┐                  │
│  │            CONTEXT ASSEMBLER                   │                  │
│  │  • Multi-factor scoring (recency + semantic)   │                  │
│  │  • Entity enrichment                           │                  │
│  │  • Token budget optimization                   │                  │
│  │  • Anti-repetition filtering                   │                  │
│  └────────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        PERSISTENCE LAYER                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐     │
│  │  Threads   │  │  History   │  │  Entities  │  │  Patterns  │     │
│  │   Table    │  │   Table    │  │   Table    │  │   Table    │     │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    VECTOR STORE (sqlite-vec)                 │    │
│  │   vec_threads_768  |  vec_history_768  |  vec_entities_768   │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Timeline Summary

| Phase | Duration | Cumulative | Key Deliverable |
|-------|----------|------------|-----------------|
| Phase 1 | 1-2 days | 2 days | Semantic context enabled |
| Phase 2 | 3-5 days | 7 days | Cross-session persistence |
| Phase 3 | 2-3 days | 10 days | Entity memory |
| Phase 4 | 3-4 days | 14 days | Hierarchical memory |
| Phase 5 | 2-3 days | 17 days | Real-time intelligence |
| Phase 6 | 1-2 days | (parallel) | Anti-repetition |

**Total: ~2.5-3 weeks for full implementation**

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Embedding latency | Cache aggressively, fallback to recency-only |
| Database size growth | Automatic expiration of old data |
| Memory usage | Tiered storage, lazy loading |
| Vector search performance | sqlite-vec native extension, background indexing |
| Breaking existing features | Feature flags for all new capabilities |

---

## Success Metrics

1. **Context Relevance**: Measure semantic similarity between retrieved context and query
2. **Cross-Session Recall**: Can the system recall information from previous sessions?
3. **Entity Recognition**: % of mentioned entities correctly identified and stored
4. **Response Novelty**: Semantic distance between consecutive responses
5. **Latency**: Context retrieval completes in <200ms
6. **User Satisfaction**: Qualitative feedback on memory quality

---

## Next Steps

1. [ ] Review and approve this plan
2. [ ] Prioritize phases based on immediate needs
3. [ ] Begin Phase 1 implementation
4. [ ] Set up metrics collection for success measurement
