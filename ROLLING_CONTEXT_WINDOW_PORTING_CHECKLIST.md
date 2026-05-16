# Rolling Context Window Porting Checklist

Use this checklist when transplanting the rolling context feature into another app.

## 1. Transcript Intake

- Define a normalized live turn shape with `role`, `text`, `timestamp`, and `final`
- Ensure the transcript stream distinguishes final vs interim speech
- Decide which speaker roles map to your equivalent of `interviewer`, `user`, and `assistant`
- Feed final transcript into both the live context layer and retrieval layer
- Preserve the latest useful interim external-speaker turn for low-latency prompting

## 2. Live Rolling Prompt Context

- Implement an in-memory recent-turn buffer
- Evict prompt turns by time window, not just count
- Add a hard safety cap on total items
- Deduplicate same-role same-text turns within a small timestamp delta
- Store assistant-generated replies in the same rolling context
- Keep a bounded history of recent assistant replies for anti-repetition

## 3. Transcript Cleaning Before Prompting

- Remove filler words and verbal acknowledgements
- Drop weak turns below a minimum usefulness threshold
- Prefer important external-speaker turns over low-value user filler
- Sparsify the transcript to a bounded turn count before prompt assembly
- Format transcript consistently for the target model

## 4. Temporal Consistency Layer

- Add previous assistant replies to the prompt so the model avoids repetition
- Infer role context from recent transcript turns
- Add heuristic tone continuity if your app benefits from response consistency
- Truncate previous assistant replies before injecting them into prompts
- Keep this layer deterministic and cheap

## 5. Transcript Compaction

- Maintain a longer full-session transcript separate from the prompt window
- Set a compaction threshold for transcript growth
- Summarize the oldest fixed-size block when threshold is exceeded
- Store compacted summaries in a bounded array or list
- If summarization fails, store a fallback marker instead of silently dropping history
- Rebuild full session context as `older summaries + recent detailed transcript`

## 6. Live Retrieval Memory

- Add an append-only buffer for final transcript segments
- Use a periodic background indexer instead of indexing every segment synchronously
- Track a high-water mark so only new transcript is processed each tick
- Preprocess transcript before chunking
- Chunk with overlap and speaker-aware boundaries
- Save chunks before embeddings so indexing can resume after failure

## 7. Embedding and Vector Storage

- Persist chunk metadata and embeddings in durable storage
- Store embedding provider metadata and vector dimensions with each meeting/index
- Add retry behavior with bounded attempts and backoff
- Add a fallback embedding provider if your app needs offline resiliency
- Make retrieval tolerant to partial indexing

## 8. Retrieval and Reranking

- Retrieve more candidates than you plan to return
- Apply a minimum similarity threshold
- Add recency weighting when it improves live usefulness
- Assemble retrieved context against a token budget
- Keep fallback behavior when retrieval has no relevant context

## 9. Meeting / Session End Lifecycle

- Flush any pending interim transcript before ending the session
- Snapshot transcript, usage, metadata, and summaries before reset
- Reset live state immediately after snapshot
- Persist meeting data asynchronously
- Run heavier summarization and durable indexing in background

## 10. Product Safety and Correctness

- Make the rolling prompt window independent from your retrieval engine
- Ensure failure in summarization or embeddings does not break the main live assistant
- Log when compaction, summarization, or retrieval fallback occurs
- Add tests for duplicate transcript suppression and window eviction
- Add tests for transcript compaction and summary reconstruction

## 11. Recommended Implementation Order

### Minimal version
- transcript normalization
- in-memory rolling prompt window
- transcript cleaning and sparsification
- assistant-response anti-repetition history
- meeting-end snapshot and reset

### Production version
- transcript compaction summaries
- periodic live retrieval indexing
- persistent embedding queue
- semantic retrieval with reranking
- background post-session durable indexing

## 12. Adapter Interfaces To Create

- `TranscriptIngestor`
- `RollingContextManager`
- `PromptContextBuilder`
- `CompactionSummarizer`
- `LiveRetrievalIndexer`
- `SessionPersistenceService`

## 13. Validation Scenarios

- User speaks continuously for a short meeting
- External speaker asks a question but final STT arrives late
- Meeting runs long enough to trigger transcript compaction
- Retrieval queries happen before all chunks finish embedding
- Embedding provider fails and fallback path is needed
- Meeting ends while interim transcript still exists
