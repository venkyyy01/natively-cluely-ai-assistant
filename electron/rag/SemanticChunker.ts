// electron/rag/SemanticChunker.ts
// Turn-based semantic chunking for RAG
// Chunks by speaker turns, respects token limits
// Uses sliding-window overlap to preserve context across chunk boundaries

import { CleanedSegment, estimateTokens } from './TranscriptPreprocessor';

export interface Chunk {
    meetingId: string;
    chunkIndex: number;
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
    tokenCount: number;
}

// Chunking parameters
const TARGET_TOKENS = 300;
const MAX_TOKENS = 400;
const MIN_TOKENS = 100;

// Sliding window overlap: keep last N segments (~50 tokens) from previous chunk
const OVERLAP_TARGET_TOKENS = 50;

function endsSentence(text: string): boolean {
    return /[.!?]["')\]]?$/.test(text.trim());
}

function startsTopicShift(text: string): boolean {
    return /^(anyway|now|next|switching gears|moving on|on another note|separately|however|but|so)\b/i.test(text.trim());
}

/**
 * Build a chunk from accumulated segments
 */
function buildChunk(
    meetingId: string,
    index: number,
    segments: CleanedSegment[]
): Chunk {
    const text = segments.map(s => s.text).join(' ');
    const speakers = new Set(segments.map(s => s.speaker));
    return {
        meetingId,
        chunkIndex: index,
        speaker: speakers.size === 1 ? segments[0].speaker : 'Mixed',
        startMs: segments[0].startMs,
        endMs: segments[segments.length - 1].endMs,
        text,
        tokenCount: estimateTokens(text)
    };
}

/**
 * Calculate how many trailing segments to keep as overlap,
 * targeting roughly OVERLAP_TARGET_TOKENS worth of context.
 */
function calculateOverlap(segments: CleanedSegment[]): { overlapSegments: CleanedSegment[], overlapTokens: number } {
    let tokens = 0;
    let count = 0;

    // Walk backwards from the end, accumulating tokens
    for (let i = segments.length - 1; i >= 0; i--) {
        const segTokens = estimateTokens(segments[i].text);
        if (tokens + segTokens > OVERLAP_TARGET_TOKENS && count > 0) {
            break; // Adding this segment would exceed our budget
        }
        tokens += segTokens;
        count++;
        // Keep at most 2 segments as overlap
        if (count >= 2) break;
    }

    const overlapSegments = segments.slice(segments.length - count);
    return { overlapSegments, overlapTokens: tokens };
}

function shouldCarryCrossSpeakerOverlap(previousChunk: CleanedSegment[], nextSegment: CleanedSegment): boolean {
    const previousSegment = previousChunk[previousChunk.length - 1];
    if (!previousSegment) return false;
    if (startsTopicShift(nextSegment.text)) return false;
    return previousSegment.isQuestion
        || nextSegment.isQuestion
        || estimateTokens(previousSegment.text) <= OVERLAP_TARGET_TOKENS;
}

/**
 * Semantic chunking algorithm with sliding-window overlap
 * 
 * Strategy:
 * 1. Group by speaker turns (natural conversation boundaries)
 * 2. Merge short consecutive turns from same speaker
 * 3. Split if exceeding token limit
 * 4. Target 200-400 tokens per chunk
 * 5. On split, carry last 1-2 segments (~50 tokens) into the next chunk
 *    to preserve semantic context across RAG boundaries
 * 
 * Why this works:
 * - Turn-based chunking preserves conversational context
 * - Speaker metadata enables filtering ("what did X say?")
 * - Token limits ensure embedding quality and retrieval precision
 * - Sliding overlap prevents information loss at chunk boundaries
 */
export function chunkTranscript(
    meetingId: string,
    segments: CleanedSegment[]
): Chunk[] {
    if (segments.length === 0) return [];

    const chunks: Chunk[] = [];
    let currentChunk: CleanedSegment[] = [];
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const seg of segments) {
        const segTokens = estimateTokens(seg.text);
        const lastSegment = currentChunk[currentChunk.length - 1];
        const semanticBoundary =
            currentChunk.length > 0 &&
            endsSentence(lastSegment.text) &&
            startsTopicShift(seg.text);

        // Decide whether to start a new chunk
        const shouldSplit =
            // Speaker changed and we have content
            (currentChunk.length > 0 && seg.speaker !== currentChunk[0].speaker) ||
            // Would exceed max tokens and we have minimum content
            (currentTokens + segTokens > MAX_TOKENS && currentTokens >= MIN_TOKENS) ||
            semanticBoundary;

        if (shouldSplit && currentChunk.length > 0) {
            chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));

            // Sliding window: carry last 1-2 segments as overlap into the new chunk.
            // Preserve compact cross-speaker adjacency because interview follow-ups often
            // rely on the immediately preceding question/answer pair.
            if (
                seg.speaker === currentChunk[currentChunk.length - 1].speaker ||
                shouldCarryCrossSpeakerOverlap(currentChunk, seg)
            ) {
                const { overlapSegments, overlapTokens } = calculateOverlap(currentChunk);
                currentChunk = [...overlapSegments];
                currentTokens = overlapTokens;
            } else {
                currentChunk = [];
                currentTokens = 0;
            }
        }

        currentChunk.push(seg);
        currentTokens += segTokens;

        // Force split if single segment exceeds max (rare edge case)
        if (currentTokens > MAX_TOKENS && currentChunk.length === 1) {
            chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));
            currentChunk = [];
            currentTokens = 0;
        }
    }

    // Flush remaining segments
    if (currentChunk.length > 0) {
        chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));
    }

    return chunks;
}

/**
 * Format chunks for display in context
 */
export function formatChunkForContext(chunk: Chunk): string {
    const minutes = Math.floor(chunk.startMs / 60000);
    const seconds = Math.floor((chunk.startMs % 60000) / 1000);
    const timestamp = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    return `[${timestamp}] ${chunk.speaker}: ${chunk.text}`;
}
