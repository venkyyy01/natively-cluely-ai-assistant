// electron/rag/LiveRAGIndexer.ts
// JIT RAG: Incrementally indexes transcript during a live meeting.
//
// Architecture:
// - Background timer (30s) chunks & embeds NEW transcript segments
// - Embedding is fire-and-forget — never blocks the query path
// - At query time, VectorStore already has indexed chunks for fast search
// - Falls back gracefully if embedding API unavailable

import { preprocessTranscript, RawSegment } from './TranscriptPreprocessor';
import { chunkTranscript, Chunk } from './SemanticChunker';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { getActiveAccelerationManager } from '../services/AccelerationManager';

const INDEXING_INTERVAL_MS = 30_000;  // 30 seconds
const MIN_NEW_SEGMENTS = 3;           // Don't chunk unless we have enough new content
const LIVE_SEGMENT_BACKLOG_LIMIT = 2000;
const EMBEDDING_DELAY_MS = 250;

export class LiveRAGIndexer {
    private vectorStore: VectorStore;
    private embeddingPipeline: EmbeddingPipeline;
    private meetingId: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private allSegments: RawSegment[] = [];
    private indexedSegmentCount = 0;  // High-water mark: segments already chunked
    private chunkCounter = 0;         // Running chunk index
    private indexedChunkCount = 0;    // Total chunks with embeddings
    private isProcessing = false;     // Guard against concurrent ticks
    private isActive = false;
    private runId = 0;

    private resetState(meetingId: string | null = null): void {
        this.meetingId = meetingId;
        this.allSegments = [];
        this.indexedSegmentCount = 0;
        this.chunkCounter = 0;
        this.indexedChunkCount = 0;
        this.isProcessing = false;
    }

    constructor(vectorStore: VectorStore, embeddingPipeline: EmbeddingPipeline) {
        this.vectorStore = vectorStore;
        this.embeddingPipeline = embeddingPipeline;
    }

    /**
     * Start live indexing for a meeting.
     * Begins a background timer that periodically chunks & embeds new transcript.
     */
    start(meetingId: string): void {
        if (this.isActive) {
            console.warn(`[LiveRAGIndexer] Restarting while active; dropping previous live session ${this.meetingId}`);
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
        }

        this.runId += 1;
        this.resetState(meetingId);
        this.isActive = true;

        console.log(`[LiveRAGIndexer] Started for meeting ${meetingId}`);

        this.timer = setInterval(() => {
            this.tick().catch(err => {
                console.error('[LiveRAGIndexer] Tick error:', err);
            });
        }, INDEXING_INTERVAL_MS);
    }

    /**
     * Feed new transcript segments from the live meeting.
     * Called by SessionTracker whenever new transcript arrives.
     * This is append-only — segments are never modified after being fed.
     */
    feedSegments(segments: RawSegment[]): void {
        if (!this.isActive || !this.meetingId) return;
        this.allSegments.push(...segments);
        if (this.allSegments.length > LIVE_SEGMENT_BACKLOG_LIMIT) {
            const overflow = this.allSegments.length - LIVE_SEGMENT_BACKLOG_LIMIT;
            this.allSegments.splice(0, overflow);
            this.indexedSegmentCount = Math.max(0, this.indexedSegmentCount - overflow);
        }
    }

    /**
     * Core indexing tick — processes only NEW segments since last tick.
     * 
     * Flow:
     * 1. Slice segments from high-water mark
     * 2. Preprocess (clean, merge speakers)
     * 3. Chunk (semantic boundaries, 200-400 tokens)
     * 4. Save chunks to VectorStore
     * 5. Embed each chunk via Gemini API
     * 6. Advance high-water mark
     */
    private async tick(): Promise<void> {
        if (!this.isActive || !this.meetingId) return;
        if (this.isProcessing) return;  // Skip if previous tick still running

        const newSegmentCount = this.allSegments.length - this.indexedSegmentCount;
        if (newSegmentCount < MIN_NEW_SEGMENTS) return;  // Not enough new content

        this.isProcessing = true;
        const meetingId = this.meetingId;
        const runId = this.runId;

        try {
            // 1. Get only new segments
            const newSegments = this.allSegments.slice(this.indexedSegmentCount);

            // 2. Preprocess
            const cleaned = preprocessTranscript(newSegments);
            if (cleaned.length === 0) {
                this.indexedSegmentCount = this.allSegments.length;
                return;
            }

            // 3. Chunk with offset index
            const chunks = chunkTranscript(meetingId, cleaned);
            if (chunks.length === 0) {
                this.indexedSegmentCount = this.allSegments.length;
                return;
            }

            // Re-index chunks to continue from where we left off
            const indexedChunks: Chunk[] = chunks.map((chunk, i) => ({
                ...chunk,
                chunkIndex: this.chunkCounter + i,
            }));

            // 4. Save chunks to DB (without embeddings initially)
            const chunkIds = this.vectorStore.saveChunks(indexedChunks);
            this.chunkCounter += indexedChunks.length;

            console.log(`[LiveRAGIndexer] Saved ${indexedChunks.length} chunks (${this.chunkCounter} total) for meeting ${meetingId}`);

            // 5. Embed each chunk (fire-and-forget per chunk, but sequential to avoid rate limits)
            if (this.embeddingPipeline.isReady()) {
                let embeddedCount = 0;
                for (let i = 0; i < chunkIds.length; i++) {
                    if (!this.isActive || this.runId !== runId || this.meetingId !== meetingId) {
                        console.warn('[LiveRAGIndexer] Aborting stale embedding loop');
                        break;
                    }
                    try {
                        const accelerationManager = getActiveAccelerationManager();
                        const embedding = accelerationManager
                            ? await accelerationManager.runInLane('background', () => this.embeddingPipeline.getEmbedding(indexedChunks[i].text))
                            : await this.embeddingPipeline.getEmbedding(indexedChunks[i].text);
                        if (!this.isActive || this.runId !== runId || this.meetingId !== meetingId) {
                            console.warn('[LiveRAGIndexer] Skipping stale embedding result');
                            break;
                        }
                        this.vectorStore.storeEmbedding(chunkIds[i], embedding);
                        embeddedCount++;
                        if (i < chunkIds.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, EMBEDDING_DELAY_MS));
                        }
                    } catch (err) {
                        console.warn(`[LiveRAGIndexer] Failed to embed chunk ${chunkIds[i]}:`, err);
                        // Continue with remaining chunks — partial indexing is better than none
                    }
                }
                this.indexedChunkCount += embeddedCount;
                console.log(`[LiveRAGIndexer] Embedded ${embeddedCount}/${chunkIds.length} chunks (${this.indexedChunkCount} total with embeddings)`);
            } else {
                console.log('[LiveRAGIndexer] Embedding pipeline not ready, chunks saved without embeddings');
            }

            // 6. Advance high-water mark
            if (this.isActive && this.runId === runId && this.meetingId === meetingId) {
                this.indexedSegmentCount = this.allSegments.length;
            }

        } catch (err) {
            console.error('[LiveRAGIndexer] Processing error:', err);
        } finally {
            if (this.runId === runId) {
                this.isProcessing = false;
            }
        }
    }

    /**
     * Stop live indexing. Flushes any remaining segments.
     */
    async stop(): Promise<void> {
        if (!this.isActive) return;

        console.log(`[LiveRAGIndexer] Stopping for meeting ${this.meetingId}`);
        const runId = this.runId;

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        // Final flush — process any remaining segments
        await this.tick();

        if (this.runId !== runId) {
            console.warn('[LiveRAGIndexer] Stop detected a newer run; skipping reset of current session');
            return;
        }

        const meetingId = this.meetingId;
        this.isActive = false;
        this.resetState(null);

        console.log(`[LiveRAGIndexer] Stopped for meeting ${meetingId}`);
    }

    /**
     * Check if there are any queryable JIT chunks for the current meeting.
     */
    hasIndexedChunks(): boolean {
        return this.indexedChunkCount > 0;
    }

    /**
     * Get the number of chunks with embeddings (queryable).
     */
    getIndexedChunkCount(): number {
        return this.indexedChunkCount;
    }

    /**
     * Get the meeting ID currently being indexed.
     */
    getActiveMeetingId(): string | null {
        return this.meetingId;
    }

    /**
     * Check if actively indexing.
     */
    isRunning(): boolean {
        return this.isActive;
    }
}
