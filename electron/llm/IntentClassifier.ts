// electron/llm/IntentClassifier.ts
// Lightweight intent classification for "What should I say?"
// Micro step that runs before answer generation
//
// Three-tier classification:
// 1. Weighted cue scoring (< 1ms) for pattern-matched intents
// 2. Fine-tuned SLM (~15-40ms) — DeBERTa-v3-small text-classification
//    with post-SLM cue-override gate and calibration
// 3. Context heuristic (0ms) for conversation-flow signals

import { isElectronAppPackaged, resolveBundledModelsPath } from '../utils/modelPaths';
import { getIntentConfidenceService } from './IntentConfidenceService';
import { traceLogger } from '../tracing';
const { loadTransformers } = require('../utils/transformersLoader');

export type ConversationIntent =
    | 'clarification'      // "Can you explain that?"
    | 'follow_up'          // "What happened next?"
    | 'deep_dive'          // "Tell me more about X"
    | 'behavioral'         // "Give me an example of..."
    | 'example_request'    // "Can you give a concrete example?"
    | 'summary_probe'      // "So to summarize..."
    | 'coding'             // "Write code for X" or implementation questions
    | 'general';           // Default fallback

export interface IntentResult {
  intent: ConversationIntent;
  confidence: number;
  answerShape: string;
  /** NAT-056: revision + age when produced via IntentClassificationCoordinator. */
  staleness?: { transcriptRevision: number; ageMs: number };
  /** NAT-XXX: Latency of the classification in ms (optional for tracing) */
  latencyMs?: number;
}

/**
 * Answer shapes mapped to intents
 * This controls HOW the answer is structured, not just WHAT it says
 */
const INTENT_ANSWER_SHAPES: Record<ConversationIntent, string> = {
    clarification: 'Give a direct, focused 1-2 sentence clarification. No setup, no context-setting.',
    follow_up: 'Continue the narrative naturally. 1-2 sentences. No recap of what was already said.',
    deep_dive: 'Provide a structured but concise explanation. Use concrete specifics, not abstract concepts.',
    behavioral: 'For explicit behavioral questions, answer in clear STAR with most depth in Action. For hidden behavioral questions, give one short approach statement and then one concrete example that proves it. Focus on personal actions, decision logic, outcomes, and lessons learned when relevant.',
    example_request: 'Provide ONE concrete, detailed example. Make it realistic and specific.',
    summary_probe: 'Confirm the summary briefly and add one clarifying point if needed.',
    coding: 'Provide a FULL, complete, working and production-ready code implementation (including necessary boilerplate like Java imports/classes). Start with a brief approach description, then the fully runnable code block, then a concise explanation of why this approach works.',
    general: 'Respond naturally based on context. Keep it conversational and direct.'
};

// ========================
// Fine-Tuned SLM Classifier
// ========================

const SLM_LABEL_MAP: Record<string, ConversationIntent> = {
  'clarification': 'clarification',
  'follow_up': 'follow_up',
  'deep_dive': 'deep_dive',
  'behavioral': 'behavioral',
  'example_request': 'example_request',
  'summary_probe': 'summary_probe',
  'coding': 'coding',
  'general': 'general',
};

const CUE_OVERRIDE_MIN_WEIGHT = 3.0;
const CUE_OVERRIDE_SLM_MAX_CONFIDENCE = 0.72;

function normalizeForIntentHeuristics(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function likelyIntentCue(text: string): ConversationIntent | null {
  const normalized = normalizeForIntentHeuristics(text);
  if (!normalized) {
    return null;
  }

  if (/(implement|write code|debug|algorithm|lru|typescript|javascript|handler code|api payload|function|refactor|snippet)/i.test(normalized)) {
    return 'coding';
  }

  if (/(so you are saying|so you re saying|let me make sure|to summarize|so to summarize|if i understood correctly|am i right|do i have this right|to confirm)/i.test(normalized)) {
    return 'summary_probe';
  }

  if (/(what happened next|then what|after that)/i.test(normalized)) {
    return 'follow_up';
  }

  if (/(clarify|what do you mean|can you explain|unpack|how so|what exactly|when you say|break that down)/i.test(normalized)) {
    return 'clarification';
  }

  // Weighted behavioral vs deep_dive — same logic as the cue scoring system
  const hasStrongBehavioral = /\b(tell me about a time|describe a time|describe a situation where you|when have you|share an experience|walk me through a failure|walk me through .+ (time|situation|conflict|failure|mistake|decision))\b/i.test(normalized);
  const hasDeepDive = /\b(tradeoff|trade.off|why would you choose|why choose|why not|compare|latency|freshness|consistency|availability|throughput|distributed systems|microservice|load balancer|consensus|raft|sharding|replication|rate limiting|circuit breaker|idempotency|backpressure|system design|design a|design an|how would you (build|design|scale|handle|approach)|architecture|scalability|partition tolerance|concurrency|parallelism|deadlock|race condition|big o|database|indexing|transaction|acid|docker|kubernetes|redis|kafka|postgres|mongodb|caching|queue|pipeline)\b/i.test(normalized);

  if (hasStrongBehavioral && !hasDeepDive) {
    return 'behavioral';
  }
  if (hasDeepDive) {
    return 'deep_dive';
  }

  if (/(concrete example|specific example|for example|for instance|specific instance|like what|such as)/i.test(normalized)) {
    return 'example_request';
  }

  if (/(tell me about your experience|describe a situation|how do you manage|how do you prioritize|give me an example|what is your .+ style|how do you influence)/i.test(normalized)) {
    return 'behavioral';
  }

  return null;
}

function calibrateSlmResultByCue(text: string, slmResult: IntentResult): IntentResult {
  const cue = likelyIntentCue(text);
  if (!cue || cue === slmResult.intent) {
    return slmResult;
  }

  const conflictSeverity = isDistantConflict(cue, slmResult.intent) ? 0.35 : 0.2;
  const downgradedConfidence = Math.min(slmResult.confidence - conflictSeverity, 0.48);
  return {
    ...slmResult,
    confidence: downgradedConfidence,
  };
}

function isDistantConflict(cue: ConversationIntent, slmIntent: ConversationIntent): boolean {
  const distantPairs: Array<[ConversationIntent, ConversationIntent]> = [
    ['behavioral', 'coding'],
    ['coding', 'behavioral'],
    ['clarification', 'coding'],
    ['coding', 'clarification'],
    ['summary_probe', 'deep_dive'],
    ['behavioral', 'deep_dive'],
    ['deep_dive', 'behavioral'],
    ['coding', 'deep_dive'],
    ['deep_dive', 'coding'],
    ['clarification', 'behavioral'],
    ['behavioral', 'clarification'],
  ];
  return distantPairs.some(([a, b]) => cue === a && slmIntent === b);
}

class FineTunedClassifier {
  private static instance: FineTunedClassifier | null = null;
  private pipe: any = null;
  private loadingPromise: Promise<void> | null = null;
  private loadFailed = false;

  private constructor() {}

  static getInstance(): FineTunedClassifier {
    if (!FineTunedClassifier.instance) {
      FineTunedClassifier.instance = new FineTunedClassifier();
    }
    return FineTunedClassifier.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipe) return;
    if (this.loadFailed) return;

    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    this.loadingPromise = (async () => {
      try {
        const { pipeline, env } = await loadTransformers();

        env.allowRemoteModels = false;
        env.localModelPath = resolveBundledModelsPath();

        console.log('[IntentClassifier] Loading fine-tuned classifier (nli-deberta-v3-small)...');
        this.pipe = await pipeline(
          'text-classification',
          'Xenova/nli-deberta-v3-small',
          { local_files_only: isElectronAppPackaged(), quantized: true }
        );
        console.log('[IntentClassifier] Fine-tuned classifier loaded successfully.');
      } catch (e) {
        console.warn('[IntentClassifier] Failed to load fine-tuned model, regex-only fallback:', e);
        this.loadFailed = true;
        this.pipe = null;
      }
    })();

    try {
      await this.loadingPromise;
    } catch {
      this.loadingPromise = null;
    }
  }

  async classify(text: string, traceId?: string, spanId?: string): Promise<IntentResult | null> {
    await this.ensureLoaded();
    if (!this.pipe) return null;

    const modelLatencyStart = Date.now();

    try {
      const result = await this.pipe(text, { top_k: 8 });
      const modelLatencyMs = Date.now() - modelLatencyStart;

      const allScores: Array<{ label: string; score: number }> = Array.isArray(result) ? result : [result];
      allScores.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

      const top = allScores[0];
      const resolvedIntent = SLM_LABEL_MAP[top.label] || 'general';

      // NAT-XXX: Log SLM model invocation
      if (traceId) {
        traceLogger.logModelInvocation(traceId, spanId, {
          modelName: 'Xenova/nli-deberta-v3-small',
          modelVersion: 'quantized',
          latencyMs: modelLatencyMs,
          inputTokens: text.length / 4, // Rough estimate
        });
      }

      const rawResult: IntentResult = {
        intent: resolvedIntent,
        confidence: top.score,
        answerShape: INTENT_ANSWER_SHAPES[resolvedIntent],
      };

      let calibratedResult = calibrateSlmResultByCue(text, rawResult);

      calibratedResult = this.applyCueOverrideGate(text, calibratedResult);

      if (calibratedResult.confidence < getIntentConfidenceService().getSlmMinAcceptScore()) {
        return null;
      }

      console.log(`[IntentClassifier] SLM classified as "${calibratedResult.intent}" (${(calibratedResult.confidence * 100).toFixed(1)}%): "${text.substring(0, 60)}..."`);

      return {
        intent: calibratedResult.intent,
        confidence: calibratedResult.confidence,
        answerShape: calibratedResult.answerShape,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.warn('[IntentClassifier] SLM classification error:', e);

      // NAT-XXX: Log SLM error
      if (traceId) {
        traceLogger.logModelInvocation(traceId, spanId, {
          modelName: 'Xenova/nli-deberta-v3-small',
          modelVersion: 'quantized',
          latencyMs: Date.now() - modelLatencyStart,
          error: errorMsg,
        });
      }

      return null;
    }
  }

  private applyCueOverrideGate(text: string, slmResult: IntentResult): IntentResult {
    const cueScores = computeCueScores(text);
    const sorted = Array.from(cueScores.values()).sort((a, b) => b.totalWeight - a.totalWeight);
    const topCue = sorted[0];

    if (!topCue || topCue.category === slmResult.intent) {
      return slmResult;
    }

    if (topCue.totalWeight >= CUE_OVERRIDE_MIN_WEIGHT && slmResult.confidence <= CUE_OVERRIDE_SLM_MAX_CONFIDENCE) {
      const overrideConfidence = Math.min(0.88, 0.6 + topCue.totalWeight * 0.04);
      console.log(
        `[IntentClassifier] Cue override: SLM="${slmResult.intent}" (${(slmResult.confidence * 100).toFixed(0)}%) ` +
        `overridden by cue="${topCue.category}" (weight=${topCue.totalWeight.toFixed(1)}): "${text.substring(0, 60)}..."`
      );
      return {
        intent: topCue.category,
        confidence: overrideConfidence,
        answerShape: INTENT_ANSWER_SHAPES[topCue.category],
      };
    }

    return slmResult;
  }

  warmup(): void {
    this.ensureLoaded().catch(() => {});
  }
}

// ========================
// Weighted Cue Scoring System
// ========================

type CueCategory = 'clarification' | 'follow_up' | 'deep_dive' | 'behavioral' | 'example_request' | 'summary_probe' | 'coding';

interface WeightedCue {
  pattern: RegExp;
  weight: number;
  category: CueCategory;
}

const WEIGHTED_CUES: WeightedCue[] = [
  // ── Clarification (high weight — unambiguous) ──
  { pattern: /\b(can you explain|what do you mean|clarify|could you elaborate on that specific|unpack that|break that down|what exactly do you mean|what exactly is|when you say|how so)\b/i, weight: 3.0, category: 'clarification' },

  // ── Follow-up (high weight — unambiguous) ──
  { pattern: /\b(what happened|then what|and after that|what's next|how did that go|what came next)\b/i, weight: 2.8, category: 'follow_up' },

  // ── Summary probe (high weight — unambiguous) ──
  { pattern: /\b(so to summarize|in summary|so basically|so you're saying|so you are saying|let me make sure|if i understood correctly|am i right|correct me if i.m wrong|do i have this right|to confirm)\b/i, weight: 3.0, category: 'summary_probe' },

  // ── Coding (very high weight — unambiguous) ──
  { pattern: /\b(write code|write a function|build a class|implement a method|program|function for|algorithm|how to code|setup a .+ project|using .+ library|debug this|snippet|boilerplate|optimize|refactor|best practice for .+ code|utility method|component for|logic for)\b/i, weight: 3.5, category: 'coding' },
  { pattern: /\b(implement|debug)\b/i, weight: 2.5, category: 'coding' },
  { pattern: /\bexample of .+ in .+\b/i, weight: 2.8, category: 'coding' },

  // ── STRONG behavioral cues (personal-experience anchored — always behavioral) ──
  { pattern: /\btell me about a time\b/i, weight: 3.5, category: 'behavioral' },
  { pattern: /\bdescribe a time\b/i, weight: 3.5, category: 'behavioral' },
  { pattern: /\bdescribe a situation where you\b/i, weight: 3.5, category: 'behavioral' },
  { pattern: /\bwhen have you\b/i, weight: 3.0, category: 'behavioral' },
  { pattern: /\bshare an experience\b/i, weight: 3.0, category: 'behavioral' },
  { pattern: /\bgive me an example of a time\b/i, weight: 3.5, category: 'behavioral' },
  { pattern: /\bwalk me through a failure\b/i, weight: 3.5, category: 'behavioral' },
  { pattern: /\bwalk me through .+ (time|situation|conflict|failure|mistake|decision|disagreement|stakeholder|team challenge|project you led|owned end to end)\b/i, weight: 3.2, category: 'behavioral' },
  { pattern: /\bconflict with|disagreed with|disagreement with\b/i, weight: 2.5, category: 'behavioral' },

  // ── AMBIGUOUS behavioral cues (could be behavioral OR technical — lower weight) ──
  { pattern: /\btell me about your experience\b/i, weight: 1.2, category: 'behavioral' },
  { pattern: /\bdescribe a situation\b/i, weight: 1.0, category: 'behavioral' },
  { pattern: /\bhow do you manage\b/i, weight: 1.0, category: 'behavioral' },
  { pattern: /\bhow do you (make|take) .*?decisions?\b/i, weight: 1.0, category: 'behavioral' },
  { pattern: /\bhow do you influence\b/i, weight: 1.2, category: 'behavioral' },
  { pattern: /\bhow do you prioritize\b/i, weight: 1.0, category: 'behavioral' },
  { pattern: /\bwhat is your .+ style\b/i, weight: 1.0, category: 'behavioral' },
  { pattern: /\bwalk me through your experience\b/i, weight: 1.2, category: 'behavioral' },
  { pattern: /\bleadership|stakeholder\b/i, weight: 0.8, category: 'behavioral' },
  { pattern: /\bgive me an example\b/i, weight: 0.9, category: 'behavioral' },

  // ── STRONG deep_dive / technical cues (higher weight than ambiguous behavioral) ──
  { pattern: /\btell me more|dive deeper|explain further|how does that work\b/i, weight: 2.8, category: 'deep_dive' },
  { pattern: /\bwalk me through .+ (design|architecture|approach|implementation|system|code|logic|structure|how .+ work|rate limiter|cache|queue|scale|pipeline|workflow|process|model|algorithm|database|schema|api|microservice|load balancer|raft|consensus)\b/i, weight: 3.0, category: 'deep_dive' },
  { pattern: /\btradeoff|trade.off|why would you choose|why choose|why not\b/i, weight: 2.5, category: 'deep_dive' },
  { pattern: /\bcompare|versus|vs\.?\b/i, weight: 2.2, category: 'deep_dive' },
  { pattern: /\b(consistency|availability|latency|freshness|throughput|scalability|reliability|partition tolerance|cap theorem|eventual consistency|strong consistency)\b/i, weight: 2.5, category: 'deep_dive' },
  { pattern: /\b(distributed systems|microservice|load balancer|consensus|raft|paxos|gossip|sharding|replication|caching strategy|rate limiting|circuit breaker|idempotency|backpressure|data pipeline|etl|message queue|pub sub|event driven|cqrs|event sourcing)\b/i, weight: 2.8, category: 'deep_dive' },
  { pattern: /\b(system design|design a|design an|architect|architecture of|how would you (build|design|scale|handle|approach)|how does .+ (work|handle|scale|fail|recover))\b/i, weight: 2.6, category: 'deep_dive' },
  { pattern: /\b(concurrency|parallelism|thread safety|deadlock|race condition|mutex|semaphore|atomic|lock.free|wait.free)\b/i, weight: 2.5, category: 'deep_dive' },
  { pattern: /\b(big o|time complexity|space complexity|hash table|binary search|tree traversal|graph|sorting|dynamic programming|greedy|backtracking|divide and conquer)\b/i, weight: 2.5, category: 'deep_dive' },
  { pattern: /\b(network|tcp|udp|http|dns|ssl|tls|websocket|grpc|rest|rpc|cdn|proxy|firewall)\b/i, weight: 1.8, category: 'deep_dive' },
  { pattern: /\b(database|sql|nosql|indexing|query optimization|transaction|acid|join|normaliz|orm|migration|schema)\b/i, weight: 1.8, category: 'deep_dive' },
  { pattern: /\b(security|authenticat|authoriz|encrypt|oauth|jwt|token|csrf|xss|injection|vulnerability)\b/i, weight: 1.8, category: 'deep_dive' },
  { pattern: /\b(testing|unit test|integration test|e2e|tdd|bdd|mock|stub|coverage|ci|cd|deploy|pipeline|monitor|observ|logging|metric|alert)\b/i, weight: 1.5, category: 'deep_dive' },
  { pattern: /\b(docker|kubernetes|container|orchestrat|vm|cloud|aws|gcp|azure|serverless|lambda|s3|dynamodb|redis|kafka|rabbitmq|postgres|mongodb)\b/i, weight: 1.8, category: 'deep_dive' },

  // ── Example request (only when not mixed with coding/behavioral) ──
  { pattern: /\b(concrete example|specific instance|specific example|like what|such as|for instance|one concrete|one specific)\b/i, weight: 2.0, category: 'example_request' },
  { pattern: /\bfor example\b/i, weight: 1.0, category: 'example_request' },
];

interface CueScore {
  category: CueCategory;
  totalWeight: number;
  matchedCues: string[];
}

function computeCueScores(text: string): Map<CueCategory, CueScore> {
  const scores = new Map<CueCategory, CueScore>();

  for (const cue of WEIGHTED_CUES) {
    if (cue.pattern.test(text)) {
      const existing = scores.get(cue.category);
      if (existing) {
        existing.totalWeight += cue.weight;
        existing.matchedCues.push(cue.pattern.source.substring(0, 40));
      } else {
        scores.set(cue.category, {
          category: cue.category,
          totalWeight: cue.weight,
          matchedCues: [cue.pattern.source.substring(0, 40)],
        });
      }
    }
  }

  return scores;
}

const AMBIGUOUS_PAIRS: Array<[CueCategory, CueCategory, number]> = [
  ['behavioral', 'deep_dive', 1.5],
  ['behavioral', 'coding', 1.2],
  ['example_request', 'behavioral', 1.0],
  ['example_request', 'deep_dive', 1.0],
  ['example_request', 'coding', 0.8],
];

function resolveCueScores(scores: Map<CueCategory, CueScore>, text: string): IntentResult | null {
  if (scores.size === 0) return null;

  const sorted = Array.from(scores.values()).sort((a, b) => b.totalWeight - a.totalWeight);
  const top = sorted[0];
  const second = sorted.length > 1 ? sorted[1] : null;

  // If top category has decisive lead, return it
  if (!second || top.totalWeight > second.totalWeight * 2) {
    const confidence = Math.min(0.9, 0.6 + top.totalWeight * 0.04);
    return { intent: top.category, confidence, answerShape: INTENT_ANSWER_SHAPES[top.category] };
  }

  // Check ambiguous pairs — if top is behavioral but deep_dive has significant technical score
  for (const [catA, catB, minRatio] of AMBIGUOUS_PAIRS) {
    const scoreA = scores.get(catA);
    const scoreB = scores.get(catB);
    if (scoreA && scoreB) {
      const ratio = scoreB.totalWeight / scoreA.totalWeight;
      // If the competing category's score is close enough, prefer the more specific one
      if (ratio >= minRatio) {
        // Prefer the more TECHNICAL / SPECIFIC category over the more AMBIGUOUS one
        // deep_dive > behavioral when both score similarly (technical cues are more specific)
        // coding > behavioral, coding > example_request
        // deep_dive > example_request
        const preferOrder: CueCategory[] = ['coding', 'deep_dive', 'clarification', 'follow_up', 'summary_probe', 'example_request', 'behavioral'];
        const idxA = preferOrder.indexOf(catA);
        const idxB = preferOrder.indexOf(catB);
        const winner = idxA < idxB ? catA : catB;
        const winScore = scores.get(winner)!;
        const confidence = Math.min(0.88, 0.6 + winScore.totalWeight * 0.04);
        return { intent: winner, confidence, answerShape: INTENT_ANSWER_SHAPES[winner] };
      }
    }
  }

  // Default: return top-scoring category
  const confidence = Math.min(0.85, 0.55 + top.totalWeight * 0.03);
  return { intent: top.category, confidence, answerShape: INTENT_ANSWER_SHAPES[top.category] };
}

// ========================
// Regex Fast-Path
// ========================

/**
 * Pattern-based intent detection using weighted cue scoring.
 * Instead of first-match-wins, collects ALL cue matches, weights them,
 * and resolves conflicts — especially behavioral vs deep_dive.
 */
export function detectIntentByPattern(lastInterviewerTurn: string): IntentResult | null {
  const text = lastInterviewerTurn.toLowerCase().trim();
  if (!text) return null;

  const scores = computeCueScores(text);
  const result = resolveCueScores(scores, text);

  if (result) {
    console.log(
      `[IntentClassifier] Cue scoring: intent=${result.intent} conf=${(result.confidence * 100).toFixed(0)}% ` +
      `scores={${Array.from(scores.entries()).map(([k, v]) => `${k}=${v.totalWeight.toFixed(1)}`).join(', ')}} ` +
      `text="${text.substring(0, 60)}..."`
    );
  }

  return result;
}

// ========================
// Context-Aware Fallback
// ========================

/**
 * Context-aware intent detection
 * Looks at conversation flow, not just the last turn
 */
export function detectIntentByContext(
    recentTranscript: string,
    assistantMessageCount: number
): IntentResult {
    const lines = recentTranscript.split('\n');
    const interviewerLines = lines.filter(l => l.includes('[INTERVIEWER'));
    const assistantLines = lines.filter(l => l.includes('[ASSISTANT') || l.includes('[INTERVIEWEE'));
    const lastInterviewerLine = interviewerLines[interviewerLines.length - 1] || '';
    const lastInterviewerText = lastInterviewerLine.replace(/\[INTERVIEWER[^]]*\]\s*:/i, '').trim();

    // Check if recent assistant responses contained code → follow_up/deep_dive about code
    const recentAssistantText = assistantLines.slice(-3).join('\n');
    const hasCodeInRecentAnswers = /```|function |class |const |import |def /.test(recentAssistantText);

    if (assistantMessageCount >= 2) {
        // Short interviewer prompts after long exchanges = follow-up probe
        if (lastInterviewerText.length < 50) {
            if (hasCodeInRecentAnswers) {
                return { intent: 'deep_dive', confidence: 0.6, answerShape: INTENT_ANSWER_SHAPES.deep_dive };
            }
            return { intent: 'follow_up', confidence: 0.7, answerShape: INTENT_ANSWER_SHAPES.follow_up };
        }

        // Longer prompt after code answer → likely deep_dive
        if (hasCodeInRecentAnswers) {
            return { intent: 'deep_dive', confidence: 0.55, answerShape: INTENT_ANSWER_SHAPES.deep_dive };
        }
    }

    // First exchange, long question → likely deep_dive or general
    if (assistantMessageCount === 0 && lastInterviewerText.length > 80) {
        return { intent: 'deep_dive', confidence: 0.5, answerShape: INTENT_ANSWER_SHAPES.deep_dive };
    }

    // Default to general
    return { intent: 'general', confidence: 0.45, answerShape: INTENT_ANSWER_SHAPES.general };
}

// ========================
// Public API
// ========================

/**
 * Main intent classification function (async)
 *
 * Three-tier priority:
 * 1. Regex fast-path (< 1ms, high confidence)
 * 2. Fine-tuned SLM fallback (~10-50ms, medium-high confidence)
 * 3. Context-based heuristic (0ms, low confidence)
 *
 * NAT-XXX: Full tracing of tier decisions and model usage
 */
export async function classifyIntent(
  lastInterviewerTurn: string | null,
  recentTranscript: string,
  assistantMessageCount: number,
  traceId?: string
): Promise<IntentResult> {
  const startTime = Date.now();
  const spanId = traceId ? `classify-${startTime}` : undefined;

  // Tier 1: Try regex-based first (high confidence, instant)
  if (lastInterviewerTurn) {
    const patternResult = detectIntentByPattern(lastInterviewerTurn);
    if (patternResult) {
      const result: IntentResult = {
        ...patternResult,
        latencyMs: Date.now() - startTime,
      };

      // NAT-XXX: Log Tier 1 success (regex)
      if (traceId) {
        traceLogger.logIntentClassificationEvent(traceId, spanId, 'completed', {
          question: lastInterviewerTurn.substring(0, 200),
          result: {
            intent: result.intent,
            confidence: result.confidence,
            answerShape: result.answerShape,
            provider: 'regex',
            retryCount: 0,
          },
          modelUsed: 'regex',
          tier: 1,
        });
        traceLogger.logModelInvocation(traceId, spanId, {
          modelName: 'regex',
          modelVersion: 'v1',
          latencyMs: result.latencyMs,
        });
      }

      console.log(`[IntentClassifier] Tier 1 (regex) classified as "${result.intent}" (${(result.confidence * 100).toFixed(0)}%): "${lastInterviewerTurn.substring(0, 60)}..."`);
      return result;
    }

    // Tier 2: Try fine-tuned SLM (if regex didn't match)
    if (lastInterviewerTurn.trim().length > 5) {
      const slmResult = await FineTunedClassifier.getInstance().classify(lastInterviewerTurn, traceId, spanId);
      if (slmResult) {
        const result: IntentResult = {
          ...slmResult,
          latencyMs: Date.now() - startTime,
        };

        // NAT-XXX: Log Tier 2 success (SLM)
        if (traceId) {
          traceLogger.logIntentClassificationEvent(traceId, spanId, 'completed', {
            question: lastInterviewerTurn.substring(0, 200),
            result: {
              intent: result.intent,
              confidence: result.confidence,
              answerShape: result.answerShape,
              provider: 'slm',
              retryCount: 0,
            },
            modelUsed: 'slm',
            tier: 2,
          });
        }

        return result;
      }
    }
  }

  // Tier 3: Fall back to context-based heuristic
  const contextResult = detectIntentByContext(recentTranscript, assistantMessageCount);
  const result: IntentResult = {
    ...contextResult,
    latencyMs: Date.now() - startTime,
  };

  // NAT-XXX: Log Tier 3 fallback (context heuristic)
  if (traceId) {
    traceLogger.logIntentClassificationEvent(traceId, spanId, 'completed', {
      question: lastInterviewerTurn?.substring(0, 200) ?? '',
      result: {
        intent: result.intent,
        confidence: result.confidence,
        answerShape: result.answerShape,
        provider: 'context_heuristic',
        retryCount: 0,
      },
      modelUsed: 'context_heuristic',
      tier: 3,
    });
    traceLogger.logModelInvocation(traceId, spanId, {
      modelName: 'context_heuristic',
      modelVersion: 'v1',
      latencyMs: result.latencyMs,
    });
  }

  console.log(`[IntentClassifier] Tier 3 (context) classified as "${result.intent}" (${(result.confidence * 100).toFixed(0)}%): "${lastInterviewerTurn?.substring(0, 60) ?? 'N/A'}..."`);
  return result;
}

/**
 * Get answer shape guidance for prompt injection
 */
export function getAnswerShapeGuidance(intent: ConversationIntent): string {
    return INTENT_ANSWER_SHAPES[intent];
}

/**
 * Pre-warm the SLM model in background.
 * Call this during app initialization to avoid cold-start on first classification.
 */
export function warmupIntentClassifier(): void {
  FineTunedClassifier.getInstance().warmup();
}
