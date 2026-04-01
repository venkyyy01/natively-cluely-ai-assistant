export type ConversationTurnSpeaker = 'user' | 'interviewer' | 'assistant';
export type ConversationTurnSource = 'microphone' | 'system' | 'assistant';

export interface ConversationTurn {
  id: string;
  speaker: ConversationTurnSpeaker;
  source: ConversationTurnSource;
  text: string;
  startedAt: number;
  endedAt: number;
  final: boolean;
  confidence?: number;
  overlapGroupId?: string;
  mergedSegmentIds: string[];
}

export interface TimingVarianceStats {
  sampleCount: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}
