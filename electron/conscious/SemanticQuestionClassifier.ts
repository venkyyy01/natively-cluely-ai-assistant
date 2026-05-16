/**
 * SemanticQuestionClassifier
 *
 * NAT-CM-AUDIT: regex-only classification misses any phrasing not on the
 * keyword list. "Walk me through how you'd structure a recommendation
 * pipeline" should land on `system_design`, but the live-coding regex steals
 * it because it sees "structure". Reaction kinds suffer the same way:
 * "I'm not sure that scales well" is a `challenge` semantically, but the
 * regex sees neither "why" nor "defend".
 *
 * This classifier asks the LLM with a tight JSON schema and a hard timeout
 * (~600ms by default) so it never becomes a latency cliff. Results are
 * cached per (question, threadKey) so a follow-up retry costs nothing.
 *
 * The classifier is **advisory**: callers must always have a deterministic
 * fallback (regex or default). Failures, timeouts, and parse errors return
 * `null` — never throw, never block.
 */

import type { ConsciousResponseQuestionMode } from './ConsciousResponsePreferenceStore';
import type { QuestionReactionKind } from './QuestionReactionClassifier';

interface StructuredGenerationClient {
  generateContentStructured(message: string): Promise<string>;
  hasStructuredGenerationCapability?(): boolean;
}

export interface SemanticQuestionClassification {
  /** What kind of interview question this is, semantically. */
  questionMode: ConsciousResponseQuestionMode;
  /** What kind of probe/reaction this is, semantically. */
  reactionKind: QuestionReactionKind;
  /** 0–1; higher means the LLM was confident in both labels. */
  confidence: number;
  /** Free-text rationale; useful for telemetry and debugging. */
  reason: string;
  /** Phrasings the classifier considered most signal-bearing. */
  signals: string[];
}

const QUESTION_MODES: readonly ConsciousResponseQuestionMode[] = [
  'live_coding',
  'system_design',
  'behavioral',
  'general',
];

const REACTION_KINDS: readonly QuestionReactionKind[] = [
  'fresh_question',
  'challenge',
  'tradeoff_probe',
  'metric_probe',
  'example_request',
  'clarification',
  'repeat_request',
  'deep_dive',
  'topic_shift',
  'generic_follow_up',
];

const SEMANTIC_QUESTION_CLASSIFIER_PROMPT = `You classify a single interviewer utterance during a live tech interview.

Return ONLY valid JSON, no prose, no markdown:
{
  "questionMode": "live_coding" | "system_design" | "behavioral" | "general",
  "reactionKind": "fresh_question" | "challenge" | "tradeoff_probe" | "metric_probe" | "example_request" | "clarification" | "repeat_request" | "deep_dive" | "topic_shift" | "generic_follow_up",
  "confidence": <number between 0 and 1>,
  "reason": "<one short sentence explaining the choice>",
  "signals": ["<short phrase from the utterance that drove the choice>", ...]
}

GUIDANCE:
- "live_coding" = they want code. "Implement", "write a function", screenshot of LeetCode, asking about complexity of code.
- "system_design" = architecture, scaling, components, distributed systems, data flow, "how would you build/design", "walk me through how you'd structure", "take me through how X works at scale".
- "behavioral" = past experience, leadership, conflict, mistakes, "tell me about a time", STAR-style.
- "general" = chitchat, intro, off-topic.

REACTION KIND:
- "fresh_question" — start of a new topic.
- "challenge" — pushing back, "are you sure?", "doesn't that...", "I'm not convinced".
- "tradeoff_probe" — "what's the tradeoff?", "what do you give up?", "what's the cost?".
- "metric_probe" — asks about numbers, latency, throughput, SLOs, capacity, "how do you measure".
- "example_request" — "give me an example", "concretely", "in practice".
- "clarification" — "what do you mean?", "can you clarify", "be more specific".
- "repeat_request" — "say that again", "I missed that".
- "deep_dive" — "go deeper", "edge cases", "what if X breaks".
- "topic_shift" — "let's switch", "different question", or clearly off the previous thread.
- "generic_follow_up" — short follow-up that builds on prior context.

Pick the BEST single label for each axis. If unsure between two question modes, prefer "system_design" over "general" when the utterance mentions architecture/components/scale; prefer "behavioral" when it asks about past experience.`;

export interface SemanticClassifierOptions {
  timeoutMs?: number;
  cacheSize?: number;
}

interface CacheEntry {
  classification: SemanticQuestionClassification;
  insertedAt: number;
}

export class SemanticQuestionClassifier {
  private readonly timeoutMs: number;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: StructuredGenerationClient | null | undefined,
    options: SemanticClassifierOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 600;
    this.cacheSize = options.cacheSize ?? 64;
  }

  /**
   * Classify a question semantically. Returns `null` on missing client,
   * timeout, malformed JSON, or any other failure — callers MUST have a
   * deterministic fallback.
   */
  async classify(input: {
    question: string;
    /** Optional thread context to disambiguate follow-ups vs fresh questions. */
    threadHint?: string;
  }): Promise<SemanticQuestionClassification | null> {
    const question = input.question.trim();
    if (!question) return null;
    if (!this.client) return null;
    if (typeof this.client.generateContentStructured !== 'function') return null;
    if (this.client.hasStructuredGenerationCapability && !this.client.hasStructuredGenerationCapability()) {
      return null;
    }

    const cacheKey = this.buildCacheKey(question, input.threadHint);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // Refresh recency.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.classification;
    }

    const prompt = this.buildPrompt(question, input.threadHint);
    const timeoutSentinel = Symbol('semantic-classify-timeout');
    let raw: string | symbol;
    try {
      raw = await Promise.race([
        this.client.generateContentStructured(prompt),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), this.timeoutMs)),
      ]);
    } catch (err) {
      console.warn('[SemanticQuestionClassifier] LLM call failed:', err);
      return null;
    }

    if (raw === timeoutSentinel) {
      return null;
    }

    const parsed = this.parsePayload(raw as string);
    if (!parsed) return null;

    this.evictIfNeeded();
    this.cache.set(cacheKey, { classification: parsed, insertedAt: Date.now() });
    return parsed;
  }

  /** Test/inspection helper: clear the cache. */
  clearCache(): void {
    this.cache.clear();
  }

  private buildPrompt(question: string, threadHint?: string): string {
    const lines = [SEMANTIC_QUESTION_CLASSIFIER_PROMPT];
    if (threadHint && threadHint.trim()) {
      lines.push('', 'ACTIVE THREAD CONTEXT:', threadHint.trim());
    }
    lines.push('', 'INTERVIEWER UTTERANCE:', question, '', 'CLASSIFICATION:');
    return lines.join('\n');
  }

  private buildCacheKey(question: string, threadHint?: string): string {
    const q = question.toLowerCase().replace(/\s+/g, ' ').trim();
    const t = (threadHint || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${t}::${q}`;
  }

  private parsePayload(raw: string): SemanticQuestionClassification | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const stripped = trimmed
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const questionMode = QUESTION_MODES.includes(parsed.questionMode) ? parsed.questionMode : null;
    const reactionKind = REACTION_KINDS.includes(parsed.reactionKind) ? parsed.reactionKind : null;
    if (!questionMode || !reactionKind) return null;

    const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.6;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    const signals = Array.isArray(parsed.signals)
      ? parsed.signals.filter((s: unknown) => typeof s === 'string').slice(0, 5)
      : [];

    return { questionMode, reactionKind, confidence, reason, signals };
  }

  private evictIfNeeded(): void {
    while (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
