// electron/rag/LiveRAGIndexer.ts
// JIT RAG: Incrementally indexes transcript during a live meeting.
//
// Architecture:
// - Background timer chunks & embeds NEW transcript segments
// - Embedding is fire-and-forget — never blocks the query path
// - At query time, VectorStore already has indexed chunks for fast search
// - Falls back gracefully if embedding API unavailable

import path from 'path';
import { Worker } from 'worker_threads';

import { DatabaseManager } from '../db/DatabaseManager';
import { preprocessTranscript, RawSegment } from './TranscriptPreprocessor';
import { chunkTranscript, Chunk } from './SemanticChunker';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { getActiveAccelerationManager } from '../services/AccelerationManager';

const INDEXING_INTERVAL_MS = 10_000;  // Backstop; final interviewer turns flush sooner
const MIN_NEW_SEGMENTS = 3;           // Don't chunk unless we have enough new content
const LIVE_SEGMENT_BACKLOG_LIMIT = 2000;
/** NAT-053: batch provider.embed calls to reduce round-trips */
const MAX_EMBED_BATCH = 8;
const EMBEDDING_DELAY_MS = 250;
const LIVE_FLUSH_DEBOUNCE_MS = 750;
const LIVE_PAUSE_GAP_MS = 2_000;

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
    private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
            this.clearPendingFlush();
        }

        this.runId += 1;
        this.resetState(meetingId);
        this.isActive = true;

        console.log(`[LiveRAGIndexer] Started for meeting ${meetingId}`);

        // NAT-053: defer tick so the interval callback returns quickly (non-blocking scheduling).
        this.timer = setInterval(() => {
            setImmediate(() => {
                void this.tick().catch(err => {
                    console.error('[LiveRAGIndexer] Tick error:', err);
                });
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
        const previousLastSegment = this.allSegments[this.allSegments.length - 1] ?? null;
        this.allSegments.push(...segments);
        if (this.allSegments.length > LIVE_SEGMENT_BACKLOG_LIMIT) {
            const overflow = this.allSegments.length - LIVE_SEGMENT_BACKLOG_LIMIT;
            this.allSegments.splice(0, overflow);
            this.indexedSegmentCount = Math.max(0, this.indexedSegmentCount - overflow);
        }
        if (this.shouldFlushSoon(segments, previousLastSegment)) {
            this.scheduleFreshnessFlush();
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
    async flushNow(_reason: 'manual' | 'final_interviewer_turn' | 'long_pause' | 'stop' = 'manual'): Promise<void> {
        this.clearPendingFlush();
        await this.tick(true);
    }

    private async tick(force: boolean = false): Promise<void> {
        if (!this.isActive || !this.meetingId) return;
        if (this.isProcessing) return;  // Skip if previous tick still running

        const newSegmentCount = this.allSegments.length - this.indexedSegmentCount;
        if (newSegmentCount <= 0) return;
        if (!force && newSegmentCount < MIN_NEW_SEGMENTS) return;  // Not enough new content

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

            // 4. Save chunks off the main thread (worker SQLite insert), fallback to main thread on failure
            let chunkIds: number[];
            try {
                chunkIds = await this.saveChunksViaWorker(indexedChunks);
            } catch (err) {
                console.warn('[LiveRAGIndexer] Worker chunk save failed; using main thread:', err);
                chunkIds = this.vectorStore.saveChunks(indexedChunks);
            }
            this.chunkCounter += indexedChunks.length;

            console.log(`[LiveRAGIndexer] Saved ${indexedChunks.length} chunks (${this.chunkCounter} total) for meeting ${meetingId}`);

            // 5. Embed in batches (provider.embedBatch when available)
            if (this.embeddingPipeline.isReady()) {
                let embeddedCount = 0;
                for (let i = 0; i < chunkIds.length; i += MAX_EMBED_BATCH) {
                    if (!this.isActive || this.runId !== runId || this.meetingId !== meetingId) {
                        console.warn('[LiveRAGIndexer] Aborting stale embedding loop');
                        break;
                    }
                    const batchIds = chunkIds.slice(i, i + MAX_EMBED_BATCH);
                    const batchTexts = indexedChunks.slice(i, i + MAX_EMBED_BATCH).map((c) => c.text);
                    try {
                        const accelerationManager = getActiveAccelerationManager();
                        const runBatch = () => this.embeddingPipeline.embedDocumentsBatch(batchTexts);
                        const embeddings = accelerationManager
                            ? await accelerationManager.runInLane('background', runBatch)
                            : await runBatch();
                        if (!this.isActive || this.runId !== runId || this.meetingId !== meetingId) {
                            console.warn('[LiveRAGIndexer] Skipping stale embedding batch');
                            break;
                        }
                        for (let j = 0; j < batchIds.length; j++) {
                            const id = batchIds[j];
                            const emb = embeddings[j];
                            if (id === undefined || emb === undefined) continue;
                            this.vectorStore.storeEmbedding(id, emb);
                            embeddedCount++;
                        }
                        if (i + MAX_EMBED_BATCH < chunkIds.length) {
                            await new Promise((resolve) => setTimeout(resolve, EMBEDDING_DELAY_MS));
                        }
                    } catch (err) {
                        console.warn(`[LiveRAGIndexer] Failed to embed batch at offset ${i}:`, err);
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
        this.clearPendingFlush();

        // Final flush — process any remaining segments
        await this.flushNow('stop');

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

    /**
     * NAT-053: insert chunk rows in a worker thread so the main process does not run sync SQLite transactions.
     */
    private async saveChunksViaWorker(chunks: Chunk[]): Promise<number[]> {
        if (chunks.length === 0) {
            return [];
        }
        const dbPath = DatabaseManager.getInstance().getDatabasePath();
        const workerPath = path.join(__dirname, 'liveRagIndexerWorker.js');
        return new Promise((resolve, reject) => {
            const worker = new Worker(workerPath);
            let settled = false;
            const cleanup = () => {
                if (settled) return;
                settled = true;
                void worker.terminate().catch(() => {});
            };
            const onMessage = (msg: { ok: true; chunkIds: number[] } | { ok: false; error: string }) => {
                cleanup();
                if (msg.ok && 'chunkIds' in msg) {
                    resolve(msg.chunkIds);
                } else {
                    reject(new Error('error' in msg ? msg.error : 'Worker chunk save failed'));
                }
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            worker.once('message', onMessage);
            worker.once('error', onError);
            worker.postMessage({
                type: 'saveChunks',
                dbPath,
                chunks: chunks.map((c) => ({
                    meetingId: c.meetingId,
                    chunkIndex: c.chunkIndex,
                    speaker: c.speaker,
                    startMs: c.startMs,
                    endMs: c.endMs,
                    text: c.text,
                    tokenCount: c.tokenCount,
                })),
            });
        });
    }

    private clearPendingFlush(): void {
        if (!this.pendingFlushTimer) {
            return;
        }
        clearTimeout(this.pendingFlushTimer);
        this.pendingFlushTimer = null;
    }

    private scheduleFreshnessFlush(): void {
        this.clearPendingFlush();
        this.pendingFlushTimer = setTimeout(() => {
            this.pendingFlushTimer = null;
            this.flushNow('final_interviewer_turn').catch(err => {
                console.error('[LiveRAGIndexer] Freshness flush error:', err);
            });
        }, LIVE_FLUSH_DEBOUNCE_MS);
    }

    private shouldFlushSoon(segments: RawSegment[], previousLastSegment: RawSegment | null): boolean {
        if (segments.length === 0) {
            return false;
        }

        const hasInterviewerFinalTurn = segments.some((segment) => {
            const speaker = segment.speaker.toLowerCase();
            const text = segment.text.trim();
            const wordCount = text.split(/\s+/).filter(Boolean).length;
            return /interviewer|speaker|system/.test(speaker)
                && (text.endsWith('?') || wordCount >= 4);
        });
        if (hasInterviewerFinalTurn) {
            return true;
        }

        const firstNewSegment = segments[0];
        return Boolean(
            previousLastSegment
            && firstNewSegment.timestamp - previousLastSegment.timestamp >= LIVE_PAUSE_GAP_MS
        );
    }
}
