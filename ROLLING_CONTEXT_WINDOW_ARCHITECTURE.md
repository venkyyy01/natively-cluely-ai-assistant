# Rolling Context Window Architecture

This document extracts the rolling context window design used in this app so it can be reused in another product.

It covers two related systems:
- a short-lived in-memory rolling context window for live assistant behavior
- a longer-lived retrieval memory pipeline for live and post-session semantic recall

## High-Level Design

The app does not use a single context mechanism. It uses two layers in parallel:

1. Live prompt context
- Optimized for low-latency assistant answers during an active meeting
- Maintained in memory by `electron/SessionTracker.ts`
- Holds recent transcript, recent assistant replies, interim interviewer speech, and compressed summaries of older transcript

2. Retrieval memory
- Optimized for semantic lookup during and after the meeting
- Coordinated by `electron/rag/RAGManager.ts`
- Uses preprocessing, chunking, embeddings, and SQLite vector search

The key idea is:
- recent context stays cheap and local
- old context is not simply dropped; it is compressed or indexed
- live generation and long-term retrieval read from the same transcript stream, but they do different jobs

## Core Files

Primary live rolling-context files:
- `electron/SessionTracker.ts`
- `electron/IntelligenceEngine.ts`
- `electron/llm/transcriptCleaner.ts`
- `electron/llm/TemporalContextBuilder.ts`
- `electron/MeetingPersistence.ts`

Primary retrieval-memory files:
- `electron/rag/RAGManager.ts`
- `electron/rag/LiveRAGIndexer.ts`
- `electron/rag/TranscriptPreprocessor.ts`
- `electron/rag/SemanticChunker.ts`
- `electron/rag/RAGRetriever.ts`
- `electron/rag/EmbeddingPipeline.ts`
- `electron/rag/VectorStore.ts`

Important wiring:
- `electron/main.ts`
- `electron/ipcHandlers.ts`
- `electron/db/DatabaseManager.ts`

## End-to-End Flow

### 1. Transcript arrives

Live transcript enters through the Electron main process and gets fed into two systems:
- `IntelligenceManager` / `IntelligenceEngine` for immediate live assistance
- `RAGManager.feedLiveTranscript(...)` for live semantic indexing

Only final transcript is allowed into the main rolling context buffer. Interim interviewer speech is tracked separately so it can still influence answer generation.

### 2. SessionTracker maintains the rolling prompt window

`SessionTracker` owns the short-lived in-memory session state:
- `contextItems`: recent prompt window
- `fullTranscript`: session transcript to persist/summarize
- `assistantResponseHistory`: recent assistant replies for anti-repetition
- `transcriptEpochSummaries`: compressed older history
- `lastInterimInterviewer`: latest non-final interviewer segment

Recent prompt context is evicted by time and safety cap:
- `contextWindowDuration = 120` seconds
- `maxContextItems = 500`

This means prompt construction always prefers recent context, but session history is still preserved elsewhere.

### 3. IntelligenceEngine builds the prompt window for live answers

For the main “what should I say?” mode, `IntelligenceEngine.runWhatShouldISay(...)` does this:
- pulls `contextItems` from the last `180` seconds
- injects the latest interim interviewer transcript if it is useful and not duplicate
- converts recent items into a cleaner transcript using `prepareTranscriptForWhatToAnswer(...)`
- adds anti-repetition and tone continuity via `buildTemporalContext(...)`
- sends the combined prompt to `WhatToAnswerLLM`

The live answer context is therefore not raw transcript. It is:
- recent turns
- cleaned turns
- sparsified turns
- recent assistant memory
- tone/role hints

### 4. Older transcript is compacted instead of discarded

`SessionTracker.compactTranscriptIfNeeded()` activates when:
- `fullTranscript.length > 1800`

It then:
- takes the oldest `500` transcript entries
- summarizes them with `RecapLLM`
- stores the summary in `transcriptEpochSummaries`
- trims those exact 500 entries from `fullTranscript`

Important limits:
- max epoch summaries: `5`

If summarization fails, it stores a fallback marker instead of losing the entire early context.

This is the app’s main “rolling context compression” strategy.

### 5. Full session context is reconstructed when needed

`SessionTracker.getFullSessionContext()` rebuilds longer session memory as:
- epoch summaries first
- recent transcript after that

So the long-form meeting context becomes:
- compressed early discussion
- detailed recent discussion

This is what preserves meeting continuity even after aggressive compaction.

### 6. Live retrieval memory is indexed in the background

`LiveRAGIndexer` handles the retrieval-side rolling memory during a live meeting.

Behavior:
- background tick every `30_000ms`
- does nothing until at least `3` new segments exist
- slices only the unindexed tail using `indexedSegmentCount`
- preprocesses the new transcript
- chunks it
- stores chunks
- embeds them if the embedding pipeline is ready
- advances the high-water mark

This is not part of the prompt window directly. It is the semantic memory layer that powers live lookup.

### 7. Meeting end snapshots state and resets live context

`MeetingPersistence` snapshots the session at meeting end.

Typical behavior:
- flushes pending interim transcript
- captures transcript, usage, metadata, summaries, and start time
- resets the live session state quickly so the app is ready for the next session
- generates title/summary in background
- persists the completed meeting
- pushes the saved meeting through durable RAG indexing

This separation is important when porting: reset live context immediately, but process the completed meeting asynchronously.

## Short-Lived Rolling Context Layer

### SessionTracker responsibilities

`electron/SessionTracker.ts` is the center of the live rolling context design.

#### Main responsibilities
- accept transcript and assistant replies
- deduplicate recent items
- evict old prompt context by time window
- hold a full transcript copy for persistence
- compact older transcript into summaries
- track last assistant reply and assistant response history
- hold the last interim interviewer segment

#### Main data structures

`ContextItem`
```ts
{
  role: 'interviewer' | 'user' | 'assistant'
  text: string
  timestamp: number
}
```

`TranscriptSegment`
```ts
{
  speaker: string
  text: string
  timestamp: number
  final: boolean
  confidence?: number
}
```

`AssistantResponse`
```ts
{
  text: string
  timestamp: number
  questionContext: string
}
```

#### Rules
- ignore non-final transcript in the main rolling prompt context
- dedupe exact same role/text if timestamp delta is under `500ms`
- track assistant reply history but cap it to the last `10`
- preserve one pending interim interviewer segment

#### Why this works
- prompt context stays small and relevant
- assistant avoids repeating itself
- the last question can still be captured even before STT finalization
- early meeting history is not lost when transcript grows

## Prompt Construction Layer

### Transcript cleaning

`electron/llm/transcriptCleaner.ts` is deterministic and cheap.

Pipeline:
- remove fillers and acknowledgements
- remove weak/short turns
- keep interviewer turns preferentially
- sparsify to recent important turns
- format for prompt input

Important thresholds:
- non-interviewer turns under `3` words are dropped
- short weak turns under roughly `10` chars are dropped
- max prompt turns default to `12`
- target shape is roughly `8-12` turns and `300-600` tokens

This is important for reuse because raw transcript is usually too noisy for a rolling context prompt.

### Temporal anti-repetition context

`electron/llm/TemporalContextBuilder.ts` adds memory about prior assistant behavior.

It derives:
- `recentTranscript`
- `previousResponses`
- `roleContext`
- `toneSignals`
- `hasRecentResponses`

Important defaults:
- time window default: `180` seconds
- previous responses included: up to `3`
- each previous response truncated to `200` chars

Role detection looks at the last few items to decide whether the user is answering:
- the interviewer
- themselves / their own thread
- a general context

Tone detection is heuristic and string-pattern-based. It tries to preserve continuity without needing another model.

### IntelligenceEngine orchestration

`electron/IntelligenceEngine.ts` owns mode routing and live prompt execution.

Relevant responsibilities:
- mode switching
- cooldown management
- prompt assembly for live answering
- refinement mode triggering
- connecting `RecapLLM` into `SessionTracker`

Important thresholds:
- trigger cooldown: `3000ms`
- typical answer-generation context window: `180` seconds
- assist mode context window: `60` seconds

Porting note:
- `SessionTracker` depends on `IntelligenceEngine.initializeLLMs()` to inject `RecapLLM`
- if you port only the tracker and forget the recap LLM injection, transcript compaction still trims but summarization quality/fallback behavior changes

## Long-Lived Retrieval Memory Layer

### Why it exists

The short rolling prompt context is not enough for:
- semantic search
- long meetings
- asking about older discussion
- querying across meetings

So the app also builds retrieval memory.

### LiveRAGIndexer

`electron/rag/LiveRAGIndexer.ts` incrementally indexes new transcript during a live meeting.

Core state:
- `allSegments`
- `indexedSegmentCount`
- `chunkCounter`
- `indexedChunkCount`
- `isProcessing`

Core algorithm:
1. collect all transcript segments
2. on a timer, slice only segments after `indexedSegmentCount`
3. preprocess them
4. chunk them
5. save chunks
6. embed them
7. move the high-water mark forward

This is a classic append-only rolling indexing design.

### Transcript preprocessing

`electron/rag/TranscriptPreprocessor.ts` cleans transcript before chunking.

Notable rules from the implementation summary:
- merge consecutive same-speaker segments if gap is under `5000ms`
- drop cleaned segments under `3` words
- token estimate is `ceil(text.length / 4)`

### Chunking

`electron/rag/SemanticChunker.ts` builds transcript chunks for retrieval.

Important targets:
- target tokens: `300`
- min tokens: `100`
- max tokens: `400`
- overlap target: `50`
- overlap limited to last `2` segments
- overlap does not cross speaker changes

This is the retrieval-side rolling window equivalent: overlapping semantic chunks instead of prompt turns.

### Retrieval

`electron/rag/RAGRetriever.ts` retrieves and reranks chunks.

Defaults:
- `maxTokens = 1500`
- `topK = 8`
- candidate fetch = `topK * 2`
- `minSimilarity = 0.25`
- `recencyWeight = 0.3`
- recency half-life = 7 days

Global retrieval also boosts chunks from meetings whose summary matches the query.

### Embedding pipeline

`electron/rag/EmbeddingPipeline.ts` makes indexing durable.

Notable rules:
- persistent queue in DB
- `MAX_RETRIES = 3`
- exponential backoff base `2000ms`
- `retry_count = -1` means force local fallback
- worker timeout `30_000ms`

This matters when porting because the reliability design is part of the feature, not just an optimization.

## Architecture Diagram

```text
Live STT
  -> SessionTracker.handleTranscript()
      -> contextItems (recent rolling prompt window)
      -> fullTranscript (persistent session history)
      -> compactTranscriptIfNeeded() -> epoch summaries
      -> assistantResponseHistory

  -> IntelligenceEngine.runWhatShouldISay()
      -> get recent context
      -> inject interim interviewer turn
      -> transcriptCleaner
      -> TemporalContextBuilder
      -> WhatToAnswerLLM

In parallel:

Live STT final segments
  -> RAGManager.feedLiveTranscript()
      -> LiveRAGIndexer
          -> preprocess
          -> semantic chunk
          -> save chunk
          -> embed
          -> vector store

Meeting end
  -> MeetingPersistence snapshot
  -> reset live state
  -> save meeting
  -> durable meeting indexing
```

## Porting Blueprint

If you want this feature in another app, port it in this order.

### Phase 1: Live prompt window

Build these first:
- a `SessionTracker` equivalent
- a transcript cleaner
- a temporal-context builder
- a live answer orchestrator

Minimum requirements:
- append final transcript turns
- maintain `lastInterimInterviewer`
- evict prompt context by time window
- store assistant response history
- add a prompt assembly step that mixes:
  - recent transcript
  - previous assistant replies
  - role context
  - tone continuity

### Phase 2: Transcript compaction

Add:
- transcript compaction threshold
- oldest-block summarization
- bounded summary stack

Recommended behavior based on this app:
- compact when transcript gets too large
- summarize a fixed oldest block
- keep summaries capped
- prepend summaries when reconstructing full context

### Phase 3: Retrieval memory

Add:
- append-only live indexer
- transcript preprocessing
- semantic chunking with overlap
- embeddings + vector store
- reranking with recency weighting

### Phase 4: Meeting end lifecycle

Add:
- session snapshotting
- immediate live reset
- background persistence and summarization
- durable indexing after save

## Reusable Implementation Rules

These are the most reusable design rules extracted from the codebase.

### Rule 1: Separate prompt context from retrieval memory
- prompt context should be small, recent, and cheap
- retrieval memory should be chunked, embedded, and persistent

### Rule 2: Never rely only on raw transcript
- clean transcript before prompting
- sparsify low-value turns
- treat interviewer turns as higher value when applicable

### Rule 3: Preserve old context by compression, not silent eviction
- summarize old transcript blocks into compact session memory
- prepend those summaries when building longer context

### Rule 4: Track your own assistant outputs
- keep recent assistant replies
- use them to reduce repetition and preserve tone consistency

### Rule 5: Handle interim transcript explicitly
- final transcript is not enough for low-latency UX
- store one pending interim question-like segment and inject it carefully

### Rule 6: Use append-only high-water-mark indexing for live RAG
- never reprocess the full meeting every few seconds
- process only the unindexed tail

## Important Coupling To Preserve

If you are transferring this architecture, keep these dependencies in mind:

- `SessionTracker` needs a recap/summarization LLM injected for transcript compaction quality
- live answer generation depends on the exact transcript stream shape and final/interim handling
- live RAG depends on receiving only final transcript segments
- retrieval correctness depends on embedding provider metadata and embedding dimension consistency
- the app uses fallback paths when RAG has no relevant context; do not make RAG a hard dependency for all chat flows

## Recommended Minimal Port

If you only want the rolling context window feature, but not full RAG, port this subset:
- `SessionTracker` behavior
- transcript cleaning + sparsification
- temporal anti-repetition builder
- transcript compaction into rolling summaries
- meeting-end snapshot + reset

If you want full parity, add:
- live incremental RAG indexing
- chunk embeddings
- retrieval reranking
- post-session durable indexing

## Suggested Adapter Interfaces For Another App

Use interfaces like these when porting:

```ts
interface LiveTurn {
  role: 'interviewer' | 'user' | 'assistant';
  text: string;
  timestamp: number;
  final: boolean;
}

interface RollingContextManager {
  addTurn(turn: LiveTurn): void;
  addAssistantMessage(text: string): void;
  getRecentPromptContext(seconds: number): string;
  getFullSessionContext(): string;
  flushInterim(): void;
  reset(): void;
}

interface RetrievalIndexer {
  start(sessionId: string): void;
  feedFinalTurns(turns: LiveTurn[]): void;
  stop(): Promise<void>;
}
```

## Final Takeaway

The core architecture is not “keep the last N messages.”

It is:
- keep a recent rolling prompt window
- keep a parallel history buffer
- compress old history into summaries
- keep assistant self-memory for anti-repetition
- index final transcript in the background for retrieval
- reset live state fast, persist durable state asynchronously

That combination is what makes the feature portable and production-friendly.
