export type BufferedUtteranceFlushReason = 'punctuation' | 'silence' | 'max_buffer' | 'speaker_change' | 'manual';

export interface BufferedUtterance {
  speaker: string;
  text: string;
  utteranceId: string;
  revision: number;
  flushReason: BufferedUtteranceFlushReason;
}

export interface InterviewerUtteranceBufferOptions {
  silenceMs?: number;
  maxBufferMs?: number;
  onUtterance?: (utterance: BufferedUtterance) => void;
}

interface ActiveUtteranceBuffer {
  speaker: string;
  text: string;
  utteranceId: string;
  revision: number;
}

const DEFAULT_SILENCE_MS = 700;
const DEFAULT_MAX_BUFFER_MS = 6_000;

function normalizeFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasTerminalPunctuation(value: string): boolean {
  return /[.!?]$/.test(value.trim());
}

function mergeFragment(existing: string, incoming: string): string {
  const normalizedExisting = normalizeFragment(existing);
  const normalizedIncoming = normalizeFragment(incoming);
  if (!normalizedExisting) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedExisting;

  const existingLower = normalizedExisting.toLowerCase();
  const incomingLower = normalizedIncoming.toLowerCase();
  if (incomingLower.startsWith(existingLower)) {
    return normalizedIncoming;
  }
  if (existingLower.endsWith(incomingLower)) {
    return normalizedExisting;
  }
  return `${normalizedExisting} ${normalizedIncoming}`;
}

export function splitMultiQuestionTurn(text: string): string[] {
  const normalized = normalizeFragment(text);
  if (!normalized) return [];

  const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((part) => normalizeFragment(part))
    .filter(Boolean) ?? [];
  return parts.length > 0 ? parts : [normalized];
}

export class InterviewerUtteranceBuffer {
  private readonly silenceMs: number;
  private readonly maxBufferMs: number;
  private onUtterance?: (utterance: BufferedUtterance) => void;
  private active: ActiveUtteranceBuffer | null = null;
  private nextUtteranceNumber = 1;
  private silenceTimer: NodeJS.Timeout | null = null;
  private maxBufferTimer: NodeJS.Timeout | null = null;

  constructor(options: InterviewerUtteranceBufferOptions = {}) {
    this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
    this.maxBufferMs = options.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
    this.onUtterance = options.onUtterance;
  }

  setOnUtterance(handler: ((utterance: BufferedUtterance) => void) | undefined): void {
    this.onUtterance = handler;
  }

  pushFragment(speaker: string, text: string, isFinal: boolean): BufferedUtterance[] {
    const normalized = normalizeFragment(text);
    if (!normalized || !isFinal) {
      return [];
    }

    const emitted: BufferedUtterance[] = [];
    if (this.active && this.active.speaker !== speaker) {
      emitted.push(...this.flush('speaker_change'));
    }

    if (!this.active) {
      this.active = {
        speaker,
        text: normalized,
        utteranceId: `utterance-${this.nextUtteranceNumber++}`,
        revision: 1,
      };
      this.startMaxBufferTimer();
    } else {
      this.active.text = mergeFragment(this.active.text, normalized);
      this.active.revision += 1;
    }

    this.resetSilenceTimer();

    if (hasTerminalPunctuation(this.active.text)) {
      emitted.push(...this.flush('punctuation'));
    }

    return emitted;
  }

  flush(reason: BufferedUtteranceFlushReason = 'manual'): BufferedUtterance[] {
    if (!this.active) {
      return [];
    }

    const active = this.active;
    this.active = null;
    this.clearTimers();

    const parts = splitMultiQuestionTurn(active.text);
    const utterances = parts.map((part, index): BufferedUtterance => ({
      speaker: active.speaker,
      text: part,
      utteranceId: index === 0 ? active.utteranceId : `${active.utteranceId}:${index + 1}`,
      revision: active.revision,
      flushReason: reason,
    }));

    for (const utterance of utterances) {
      this.onUtterance?.(utterance);
    }

    return utterances;
  }

  dispose(): void {
    this.clearTimers();
    this.active = null;
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.flush('silence');
    }, this.silenceMs);
  }

  private startMaxBufferTimer(): void {
    if (this.maxBufferTimer) {
      clearTimeout(this.maxBufferTimer);
    }
    this.maxBufferTimer = setTimeout(() => {
      this.flush('max_buffer');
    }, this.maxBufferMs);
  }

  private clearTimers(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.maxBufferTimer) {
      clearTimeout(this.maxBufferTimer);
      this.maxBufferTimer = null;
    }
  }
}
