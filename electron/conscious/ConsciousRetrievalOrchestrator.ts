import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

interface ConsciousRetrievalSession {
  getFormattedContext(lastSeconds: number): string;
  getContext?(lastSeconds: number): Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
  getConsciousEvidenceContext(): string;
  getConsciousLongMemoryContext(question: string): string;
  getActiveReasoningThread(): ReasoningThread | null;
  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null;
  getLatestQuestionReaction(): QuestionReaction | null;
  getLatestAnswerHypothesis(): AnswerHypothesis | null;
}

export interface ConsciousRetrievalPack {
  stateBlock: string;
  combinedContext: string;
}

const LIVE_RAG_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'about', 'would', 'what',
  'when', 'where', 'which', 'into', 'while', 'there', 'their', 'then', 'than', 'been', 'were',
  'will', 'could', 'should', 'does', 'did', 'are', 'how', 'why', 'can', 'you', 'our', 'but', 'not',
]);

const LIVE_RAG_ASSISTANT_FALLBACK_MARKERS = [
  'could you repeat',
  "i'm not sure",
  'i cant',
  "i can't",
  'i cannot',
  "can't share that information",
  'cannot share that information',
  "don't know",
  'do not know',
  'fallback',
];

function sanitizeLiveRagText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '(')
    .replace(/>/g, ')');
}

function isFallbackLikeAssistantText(value: string): boolean {
  const lowered = value.toLowerCase();
  return LIVE_RAG_ASSISTANT_FALLBACK_MARKERS.some((marker) => lowered.includes(marker));
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !LIVE_RAG_STOPWORDS.has(token))
  ));
}

function overlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokens = new Set(tokenize(text));
  if (textTokens.size === 0) {
    return 0;
  }

  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

export class ConsciousRetrievalOrchestrator {
  constructor(private readonly session: ConsciousRetrievalSession) {}

  buildStateBlock(question: string): string {
    const thread = this.session.getActiveReasoningThread();
    const response = this.session.getLatestConsciousResponse();
    const reaction = this.session.getLatestQuestionReaction();
    const hypothesis = this.session.getLatestAnswerHypothesis();

    const lines = [
      '<conscious_state>',
      `CURRENT_INTERVIEWER_QUESTION: ${question || 'n/a'}`,
    ];

    if (thread) {
      lines.push(`ACTIVE_THREAD_ROOT: ${thread.rootQuestion}`);
      lines.push(`ACTIVE_THREAD_LAST_QUESTION: ${thread.lastQuestion}`);
      lines.push(`ACTIVE_THREAD_FOLLOW_UP_COUNT: ${thread.followUpCount}`);
    }

    if (reaction) {
      lines.push(`LATEST_INTERVIEWER_REACTION: ${reaction.kind}`);
      lines.push(`REACTION_CONFIDENCE: ${reaction.confidence.toFixed(2)}`);
      if (reaction.targetFacets.length > 0) {
        lines.push(`REACTION_TARGETS: ${reaction.targetFacets.join(', ')}`);
      }
    }

    if (hypothesis) {
      lines.push(`LIKELY_USER_ANSWER_CONFIDENCE: ${hypothesis.confidence.toFixed(2)}`);
      lines.push(`LIKELY_USER_THEMES: ${hypothesis.likelyThemes.join(' | ') || 'n/a'}`);
      lines.push(`LIKELY_USER_ANSWER_SUMMARY: ${hypothesis.latestSuggestedAnswer || 'n/a'}`);
    }

    if (response) {
      if (response.tradeoffs.length > 0) {
        lines.push(`KNOWN_TRADEOFFS: ${response.tradeoffs.join(' | ')}`);
      }
      if (response.scaleConsiderations.length > 0) {
        lines.push(`KNOWN_SCALE_CONSIDERATIONS: ${response.scaleConsiderations.join(' | ')}`);
      }
      if (response.pushbackResponses.length > 0) {
        lines.push(`KNOWN_PUSHBACKS: ${response.pushbackResponses.join(' | ')}`);
      }
    }

    lines.push('</conscious_state>');
    return lines.join('\n');
  }

  buildPack(input: {
    question: string;
    lastSeconds?: number;
    contextItems?: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
  }): ConsciousRetrievalPack {
    const lastSeconds = input.lastSeconds ?? 180;
    const stateBlock = this.buildStateBlock(input.question);
    const longMemoryBlock = this.session.getConsciousLongMemoryContext(input.question);
    const formattedContext = this.session.getFormattedContext(lastSeconds);
    const evidenceBlock = this.session.getConsciousEvidenceContext();
    const liveRagItems = input.contextItems
      ?? (typeof this.session.getContext === 'function' ? this.session.getContext(lastSeconds) : undefined)
      ?? [];
    const liveRagBlock = this.buildLiveRagBlock({
      question: input.question,
      contextItems: liveRagItems,
      maxItems: 6,
    });
    return {
      stateBlock,
      combinedContext: [stateBlock, longMemoryBlock, evidenceBlock, liveRagBlock, formattedContext].filter(Boolean).join('\n\n'),
    };
  }

  buildLiveRagBlock(input: {
    question: string;
    contextItems: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
    maxItems?: number;
  }): string {
    const queryTokens = tokenize(input.question || '');
    const maxItems = Math.max(2, Math.min(10, input.maxItems ?? 6));
    const now = Date.now();

    const scored = input.contextItems
      .map((item) => ({
        ...item,
        sanitizedText: sanitizeLiveRagText(item.text),
      }))
      .filter((item) => item.sanitizedText.length > 0)
      .filter((item) => item.role !== 'assistant' || !isFallbackLikeAssistantText(item.sanitizedText))
      .map((item) => {
        const overlap = overlapScore(queryTokens, item.sanitizedText);
        const ageMinutes = Math.max(0, (now - item.timestamp) / 60_000);
        const recency = Math.max(0, 1 - (ageMinutes / 30));
        const speakerWeight = item.role === 'interviewer' ? 1 : item.role === 'user' ? 0.9 : 0.45;
        return {
          item,
          score: (overlap * 0.65) + (recency * 0.2) + (speakerWeight * 0.15),
        };
      })
      .sort((left, right) => right.score - left.score || right.item.timestamp - left.item.timestamp);

    const deduped = new Set<string>();
    const selected: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }> = [];

    for (const entry of scored) {
      const key = `${entry.item.role}:${entry.item.sanitizedText.toLowerCase()}`;
      if (deduped.has(key)) {
        continue;
      }
      deduped.add(key);
      selected.push({
        role: entry.item.role,
        text: entry.item.sanitizedText,
        timestamp: entry.item.timestamp,
      });
      if (selected.length >= maxItems) {
        break;
      }
    }

    if (selected.length === 0) {
      return '';
    }

    selected.sort((left, right) => left.timestamp - right.timestamp);

    const lines = ['<conscious_live_rag>'];
    for (const item of selected) {
      const label = item.role === 'interviewer'
        ? 'INTERVIEWER'
        : item.role === 'user'
          ? 'USER'
          : 'ASSISTANT';
      lines.push(`[${label}] ${item.text}`);
    }
    lines.push('</conscious_live_rag>');

    return lines.join('\n');
  }
}
