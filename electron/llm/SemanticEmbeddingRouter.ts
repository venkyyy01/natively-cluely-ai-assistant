// electron/llm/SemanticEmbeddingRouter.ts
// Hybrid semantic embedding router for intent classification.
// Embeds the input question and compares against canonical intent patterns
// using cosine similarity. Falls back to pseudo-embeddings if real embeddings
// are unavailable.
//
// This is Layer 3 in the cascading intent router:
//   SLM (Layer 1) → IntentClassifier (Layer 2) → SemanticEmbeddingRouter (Layer 3) → Regex (Layer 4)

import type { ConversationIntent, IntentResult } from './IntentClassifier';
import { buildPseudoEmbedding, cosineSimilarity } from '../session/sessionContext';
import { getAnswerShapeGuidance } from './IntentClassifier';

interface IntentPattern {
  intent: ConversationIntent;
  phrases: string[];
  embeddings?: number[][];
  minConfidence: number;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'deep_dive',
    minConfidence: 0.65,
    phrases: [
      'how would you design a system',
      'design an architecture for',
      'how would you build a scalable',
      'walk me through your design',
      'how would you approach designing',
      'what is your system design for',
      'design a distributed system',
      'how would you handle millions of',
      'design a url shortener',
      'design a rate limiter',
      'design a chat application',
      'design a notification system',
      'how would you scale this',
      'architecture for high throughput',
      'tradeoffs between consistency and availability',
      'how would you shard this data',
      'design a cache layer',
      'how would you handle failover',
      'microservices vs monolith',
      'database replication strategy',
      'load balancing approach',
      'distributed consensus mechanism',
      'event driven architecture',
      'cqrs and event sourcing',
      'how would you optimize latency',
    ],
  },
  {
    intent: 'coding',
    minConfidence: 0.68,
    phrases: [
      'write a function to',
      'implement an algorithm for',
      'code a solution for',
      'write code to solve',
      'implement this in python',
      'write a class that',
      'debug this code',
      'optimize this function',
      'write a method to',
      'implement a data structure',
      'solve this leetcode problem',
      'write a recursive function',
      'implement binary search',
      'code a hash map',
      'write an api endpoint',
      'implement authentication logic',
      'write a sql query',
      'code a react component',
    ],
  },
  {
    intent: 'behavioral',
    minConfidence: 0.65,
    phrases: [
      'tell me about a time when',
      'describe a situation where you',
      'give me an example of',
      'walk me through a conflict',
      'share an experience where',
      'tell me about your biggest failure',
      'describe a time you disagreed',
      'give me a leadership example',
      'tell me about a project you led',
      'describe how you handle stress',
      'walk me through a difficult decision',
      'tell me about a team challenge',
      'describe your collaboration style',
      'give an example of prioritization',
    ],
  },
  {
    intent: 'clarification',
    minConfidence: 0.62,
    phrases: [
      'can you clarify',
      'what do you mean by',
      'could you explain',
      'i did not understand',
      'can you elaborate',
      'what exactly is',
      'when you say that',
      'how does that work',
      'can you break that down',
      'what are the requirements',
    ],
  },
  {
    intent: 'follow_up',
    minConfidence: 0.60,
    phrases: [
      'what happened next',
      'then what did you do',
      'how did that turn out',
      'what was the result',
      'did you face any challenges',
      'how did you handle that',
      'what did you learn',
      'can you go deeper',
      'tell me more about',
    ],
  },
  {
    intent: 'example_request',
    minConfidence: 0.60,
    phrases: [
      'can you give an example',
      'provide a concrete example',
      'show me a specific instance',
      'what is a real world example',
      'give me a practical case',
      'can you illustrate with',
      'for example how would',
    ],
  },
  {
    intent: 'summary_probe',
    minConfidence: 0.60,
    phrases: [
      'so to summarize',
      'let me make sure i understand',
      'if i understood correctly',
      'so you are saying',
      'am i right that',
      'to confirm my understanding',
      'did i get that right',
    ],
  },
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computePseudoEmbedding(text: string): number[] {
  return buildPseudoEmbedding(text);
}

export interface SemanticRouterResult extends IntentResult {
  matchedPhrase: string;
  similarity: number;
  patternCount: number;
}

export class SemanticEmbeddingRouter {
  private static instance: SemanticEmbeddingRouter | null = null;
  private patterns: IntentPattern[];
  private initialized = false;

  private constructor() {
    this.patterns = INTENT_PATTERNS.map((p) => ({
      ...p,
      embeddings: p.phrases.map((phrase) => computePseudoEmbedding(phrase)),
    }));
    this.initialized = true;
  }

  static getInstance(): SemanticEmbeddingRouter {
    if (!SemanticEmbeddingRouter.instance) {
      SemanticEmbeddingRouter.instance = new SemanticEmbeddingRouter();
    }
    return SemanticEmbeddingRouter.instance;
  }

  static resetForTesting(): void {
    SemanticEmbeddingRouter.instance = null;
  }

  /**
   * Classify a question using semantic similarity against canonical intent patterns.
   * Returns null if no pattern matches above the intent-specific confidence threshold.
   */
  async classify(question: string): Promise<SemanticRouterResult | null> {
    if (!question || question.trim().length < 3) {
      return null;
    }

    const normalized = normalizeText(question);
    const queryEmbedding = computePseudoEmbedding(normalized);

    let bestMatch: {
      intent: ConversationIntent;
      similarity: number;
      matchedPhrase: string;
      patternCount: number;
    } | null = null;

    for (const pattern of this.patterns) {
      if (!pattern.embeddings || pattern.embeddings.length === 0) continue;

      for (let i = 0; i < pattern.embeddings.length; i++) {
        const phraseEmbedding = pattern.embeddings[i];
        const similarity = cosineSimilarity(queryEmbedding, phraseEmbedding);

        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = {
            intent: pattern.intent,
            similarity,
            matchedPhrase: pattern.phrases[i],
            patternCount: pattern.embeddings.length,
          };
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    // Find the minConfidence for the matched intent
    const patternDef = this.patterns.find((p) => p.intent === bestMatch!.intent);
    const minConfidence = patternDef?.minConfidence ?? 0.60;

    if (bestMatch.similarity < minConfidence) {
      return null;
    }

    // Convert similarity (0-1) to confidence score, capping at 0.90
    const confidence = Math.min(0.90, 0.55 + bestMatch.similarity * 0.45);

    console.log(
      `[SemanticEmbeddingRouter] Matched "${bestMatch.intent}" ` +
      `similarity=${(bestMatch.similarity * 100).toFixed(1)}% ` +
      `confidence=${(confidence * 100).toFixed(1)}% ` +
      `phrase="${bestMatch.matchedPhrase}" ` +
      `input="${question.substring(0, 60)}..."`
    );

    return {
      intent: bestMatch.intent,
      confidence,
      answerShape: getAnswerShapeGuidance(bestMatch.intent),
      matchedPhrase: bestMatch.matchedPhrase,
      similarity: bestMatch.similarity,
      patternCount: bestMatch.patternCount,
    };
  }

  /**
   * Batch classify multiple questions. Useful for testing and calibration.
   */
  async classifyBatch(questions: string[]): Promise<(SemanticRouterResult | null)[]> {
    return Promise.all(questions.map((q) => this.classify(q)));
  }
}

/**
 * Convenience function for one-off classification.
 */
export async function classifyByEmbedding(question: string): Promise<SemanticRouterResult | null> {
  return SemanticEmbeddingRouter.getInstance().classify(question);
}
