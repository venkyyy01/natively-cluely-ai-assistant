// sessionTypes.ts
// Shared types, constants, and pure utilities for session management.

/** Maximum transcript entries before forced eviction (prevents memory exhaustion) */
export const MAX_TRANSCRIPT_ENTRIES = 5000;

/** Maximum assistant response history entries */
export const MAX_ASSISTANT_HISTORY = 100;

/** Maximum context history entries (beyond time-based eviction) */
export const MAX_CONTEXT_HISTORY = 200;

export const HOT_MEMORY_WINDOW_MS = 60_000;
export const HOT_MEMORY_CEILING_BYTES = 50 * 1024 * 1024;
export const WARM_MEMORY_CEILING_BYTES = 100 * 1024 * 1024;
// NAT-014 / audit R-2: getColdState() previously returned every cold entry
// it knew about, which on a multi-hour meeting drove the persisted session
// JSON unbounded. We now cap the snapshot at 8 MB. Overflow rows are
// dropped from the snapshot — the existing `MeetingPersistence` already
// owns the on-disk record so persisted history is not lost; the upcoming
// EPIC-15 event-sourced path will replace this with cold-on-demand reads.
export const COLD_MEMORY_CEILING_BYTES = 8 * 1024 * 1024;

import type { InterviewPhase } from '../conscious';
import type { SupervisorEvent } from '../runtime/types';

/** Ring buffer for fixed-capacity context items */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(this.head + i) % this.capacity];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

export type SupervisorBusEmitter = {
  emit(event: SupervisorEvent): Promise<void>;
};

export interface TranscriptSegment {
  marker?: string;
  speaker: string;
  text: string;
  timestamp: number;
  final: boolean;
  confidence?: number;
  /** NAT-XXX: Trace ID for correlation with STT and intent classification */
  traceId?: string;
  /** Stable utterance identifier assigned by utterance-level trigger buffering. */
  utteranceId?: string;
}

export interface SuggestionTrigger {
  context: string;
  lastQuestion: string;
  confidence: number;
  sourceUtteranceId?: string;
}

// Context item matching Swift ContextManager structure
export interface ContextItem {
  role: 'interviewer' | 'user' | 'assistant';
  text: string;
  timestamp: number;
  phase?: InterviewPhase;
  embedding?: number[];
}

export interface AssistantResponse {
  text: string;
  timestamp: number;
  questionContext: string;
}

export interface PinnedItem {
  id: string;
  text: string;
  pinnedAt: number;
  label?: string;
}

export interface MeetingMetadataSnapshot {
  title?: string;
  calendarEventId?: string;
  source?: 'manual' | 'calendar';
}

export interface MeetingSnapshot {
  transcript: TranscriptSegment[];
  usage: UsageInteraction[];
  startTime: number;
  durationMs: number;
  context: string;
  meetingMetadata: MeetingMetadataSnapshot | null;
}

export interface UsageInteraction {
  type: 'assist' | 'followup' | 'chat' | 'followup_questions';
  timestamp: number;
  question?: string;
  answer?: string;
  items?: unknown;
}

export function mapSpeakerToRole(speaker: string): 'interviewer' | 'user' | 'assistant' {
  if (speaker === 'user') return 'user';
  if (speaker === 'assistant') return 'assistant';
  return 'interviewer'; // system audio = interviewer
}
