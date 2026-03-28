# Conscious Mode Realtime Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the production-ready Conscious Mode Realtime system with hierarchical token budgets, interview phase detection, thread management, hybrid confidence scoring, and four-tier fallback chain.

**Architecture:** The implementation extends the existing `ConsciousMode.ts`, `SessionTracker.ts`, and `IntelligenceEngine.ts` with new modules for token budgeting, phase detection, thread management, and fallback execution. All prompts are OpenAI-compatible for portability across providers.

**Tech Stack:** TypeScript, Node.js, OpenAI-compatible LLM APIs, Vitest for testing

**Spec Reference:** `docs/specs/2026-03-21-conscious-mode-realtime-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|----------------|
| `electron/conscious/TokenBudget.ts` | Provider-adaptive token budget management |
| `electron/conscious/InterviewPhase.ts` | Phase detection state machine and signals |
| `electron/conscious/ThreadManager.ts` | Active/suspended thread lifecycle |
| `electron/conscious/ConfidenceScorer.ts` | Hybrid BM25 + heuristic confidence scoring |
| `electron/conscious/FallbackExecutor.ts` | Four-tier fallback chain with timeout handling |
| `electron/conscious/CodeContextManager.ts` | Code snippet preservation and compression |
| `electron/conscious/types.ts` | Shared types for Conscious Mode Realtime |
| `electron/conscious/index.ts` | Module exports |
| `electron/tests/tokenBudget.test.ts` | Token budget unit tests |
| `electron/tests/interviewPhase.test.ts` | Phase detection unit tests |
| `electron/tests/threadManager.test.ts` | Thread management unit tests |
| `electron/tests/confidenceScorer.test.ts` | Confidence scoring unit tests |
| `electron/tests/fallbackExecutor.test.ts` | Fallback chain unit tests |
| `electron/tests/consciousModeIntegration.test.ts` | End-to-end integration tests |

### Modified Files
| File | Changes |
|------|---------|
| `electron/llm/prompts.ts` | Already updated with phase-aware prompts |
| `electron/SessionTracker.ts` | Add debounce config, thread storage, token budget integration |
| `electron/ConsciousMode.ts` | Update response types, add phase field, integrate thread manager |
| `electron/IntelligenceEngine.ts` | Add fallback executor integration, phase-aware routing |
| `electron/LLMHelper.ts` | Add timeout support for fallback tiers |

---

## Task 1: Core Types and Interfaces

**Files:**
- Create: `electron/conscious/types.ts`
- Test: `electron/tests/consciousModeTypes.test.ts`

- [ ] **Step 1: Write type definition tests**

```typescript
// electron/tests/consciousModeTypes.test.ts
import { describe, it, expect } from 'vitest';
import {
  InterviewPhase,
  ConversationThread,
  TokenBudget,
  ConfidenceScore,
  FallbackTier,
  ConsciousResponse,
  INTERVIEW_PHASES,
} from '../conscious/types';

describe('ConsciousModeTypes', () => {
  it('should have all interview phases defined', () => {
    expect(INTERVIEW_PHASES).toContain('requirements_gathering');
    expect(INTERVIEW_PHASES).toContain('high_level_design');
    expect(INTERVIEW_PHASES).toContain('implementation');
    expect(INTERVIEW_PHASES.length).toBe(9);
  });

  it('should have correct fallback tier count', () => {
    const tiers: FallbackTier[] = ['full_conscious', 'reduced_conscious', 'normal_mode', 'emergency_local'];
    expect(tiers.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/consciousModeTypes.test.ts`
Expected: FAIL with "Cannot find module '../conscious/types'"

- [ ] **Step 3: Write types implementation**

```typescript
// electron/conscious/types.ts

// ============================================
// Interview Phases
// ============================================

export const INTERVIEW_PHASES = [
  'requirements_gathering',
  'high_level_design',
  'deep_dive',
  'implementation',
  'complexity_analysis',
  'scaling_discussion',
  'failure_handling',
  'behavioral_story',
  'wrap_up',
] as const;

export type InterviewPhase = typeof INTERVIEW_PHASES[number];

// ============================================
// Thread Management
// ============================================

export type ThreadStatus = 'active' | 'suspended' | 'completed' | 'expired';

export interface CodeSnippet {
  id: string;
  code: string;
  language: string;
  purpose: 'implementation' | 'example' | 'interviewer_shared' | 'pseudocode';
  lineCount: number;
  tokenCount: number;
  addedAt: number;
  lastReferencedAt: number;
  compressed?: string;
}

export interface ThreadCodeContext {
  snippets: CodeSnippet[];
  maxSnippets: number;
  totalTokenBudget: number;
}

export interface ConversationThread {
  id: string;
  status: ThreadStatus;
  topic: string;
  goal: string;
  phase: InterviewPhase;
  keyDecisions: string[];
  constraints: string[];
  codeContext: ThreadCodeContext;
  createdAt: number;
  lastActiveAt: number;
  suspendedAt?: number;
  ttlMs: number;
  resumeKeywords: string[];
  interruptedBy?: string;
  turnCount: number;
  tokenCount: number;
  resumeCount: number;
}

// ============================================
// Token Budget
// ============================================

export type LLMProvider = 'openai' | 'claude' | 'groq' | 'gemini' | 'ollama' | 'custom';

export interface BucketAllocation {
  min: number;
  max: number;
  current: number;
}

export interface TokenBudgetAllocations {
  activeThread: BucketAllocation;
  recentTranscript: BucketAllocation;
  suspendedThreads: BucketAllocation;
  epochSummaries: BucketAllocation;
  entities: BucketAllocation;
  reserve: BucketAllocation;
}

export interface TokenBudget {
  provider: LLMProvider;
  totalBudget: number;
  allocations: TokenBudgetAllocations;
}

// ============================================
// Confidence Scoring
// ============================================

export interface ConfidenceScore {
  bm25Score: number;
  embeddingScore: number;
  explicitMarkers: number;
  temporalDecay: number;
  phaseAlignment: number;
  sttQuality: number;
  topicShiftPenalty: number;
  interruptionRecency: number;
  total: number;
}

export const CONFIDENCE_WEIGHTS = {
  bm25: 0.15,
  embedding: 0.25,
  explicitMarkers: 0.20,
  temporalDecay: 0.10,
  phaseAlignment: 0.15,
  sttQuality: 0.05,
  topicShiftPenalty: -0.10,
  interruptionRecency: -0.05,
} as const;

export const RESUME_THRESHOLD = 0.69;

// ============================================
// Fallback Chain
// ============================================

export type FallbackTier = 'full_conscious' | 'reduced_conscious' | 'normal_mode' | 'emergency_local';

export interface FallbackTierConfig {
  name: FallbackTier;
  budgetMs: number;
  contextLevel: 'full' | 'reduced' | 'minimal' | 'none';
  outputType: 'reasoning_first' | 'direct' | 'template';
  retryable: boolean;
}

export const FALLBACK_TIERS: FallbackTierConfig[] = [
  { name: 'full_conscious', budgetMs: 1200, contextLevel: 'full', outputType: 'reasoning_first', retryable: true },
  { name: 'reduced_conscious', budgetMs: 800, contextLevel: 'reduced', outputType: 'reasoning_first', retryable: true },
  { name: 'normal_mode', budgetMs: 600, contextLevel: 'minimal', outputType: 'direct', retryable: true },
  { name: 'emergency_local', budgetMs: 400, contextLevel: 'none', outputType: 'template', retryable: false },
];

// ============================================
// Failure State
// ============================================

export type DegradationLevel = 'none' | 'reduced' | 'minimal' | 'emergency';

export interface FailureState {
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  degradationLevel: DegradationLevel;
  tierFailures: Record<FallbackTier, number>;
}

// ============================================
// Conscious Response
// ============================================

export type ConsciousResponseMode = 'reasoning_first' | 'direct' | 'code_first';

export interface ConsciousResponse {
  success: boolean;
  mode: ConsciousResponseMode;
  openingReasoning: string;
  spokenResponse: string;
  implementationPlan: string[];
  codeBlock?: { language: string; code: string };
  tradeoffs: string[];
  edgeCases: string[];
  likelyFollowUps: string[];
  pushbackResponses: Record<string, string>;
  tier: number;
  phase: InterviewPhase;
  threadId: string;
  latencyMs: number;
  tokensUsed: number;
}

// ============================================
// Debounce Config
// ============================================

export interface DebounceConfig {
  baseWindowMs: number;
  lowConfidenceExtensionMs: number;
  sttConfidenceThreshold: number;
  maxWindowMs: number;
  minCharacterThreshold: number;
}

export const DEFAULT_DEBOUNCE_CONFIG: DebounceConfig = {
  baseWindowMs: 350,
  lowConfidenceExtensionMs: 150,
  sttConfidenceThreshold: 0.7,
  maxWindowMs: 600,
  minCharacterThreshold: 10,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/consciousModeTypes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/types.ts electron/tests/consciousModeTypes.test.ts
git commit -m "feat(conscious): add core types for Conscious Mode Realtime"
```

---

## Task 2: Token Budget Manager

**Files:**
- Create: `electron/conscious/TokenBudget.ts`
- Test: `electron/tests/tokenBudget.test.ts`

- [ ] **Step 1: Write failing tests for token budget**

```typescript
// electron/tests/tokenBudget.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetManager } from '../conscious/TokenBudget';

describe('TokenBudgetManager', () => {
  let manager: TokenBudgetManager;

  beforeEach(() => {
    manager = new TokenBudgetManager('openai');
  });

  it('should initialize with correct total budget for OpenAI', () => {
    expect(manager.getTotalBudget()).toBe(4000);
  });

  it('should initialize with correct total budget for Groq', () => {
    const groqManager = new TokenBudgetManager('groq');
    expect(groqManager.getTotalBudget()).toBe(3100);
  });

  it('should check if tokens can be added to bucket', () => {
    expect(manager.canAdd('activeThread', 500)).toBe(true);
    expect(manager.canAdd('activeThread', 5000)).toBe(false);
  });

  it('should allocate tokens to bucket', () => {
    manager.allocate('activeThread', 300);
    const allocations = manager.getAllocations();
    expect(allocations.activeThread.current).toBe(300);
  });

  it('should rebalance when bucket is underutilized', () => {
    manager.allocate('suspendedThreads', 0); // No suspended threads
    manager.rebalance();
    const allocations = manager.getAllocations();
    // Active thread should get more when suspended is empty
    expect(allocations.activeThread.max).toBeGreaterThan(1200);
  });

  it('should estimate tokens from text', () => {
    const text = "This is a test sentence with some words.";
    const tokens = manager.estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // Roughly 4 chars per token
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/tokenBudget.test.ts`
Expected: FAIL with "Cannot find module '../conscious/TokenBudget'"

- [ ] **Step 3: Write TokenBudgetManager implementation**

```typescript
// electron/conscious/TokenBudget.ts
import {
  LLMProvider,
  TokenBudget,
  TokenBudgetAllocations,
  BucketAllocation,
} from './types';

const PROVIDER_BUDGETS: Record<LLMProvider, number> = {
  openai: 4000,
  claude: 5000,
  groq: 3100,
  gemini: 6000,
  ollama: 2000,
  custom: 4000,
};

// Percentages of total budget for each bucket
const DEFAULT_ALLOCATION_PERCENTAGES = {
  activeThread: { min: 0.20, max: 0.35 },
  recentTranscript: { min: 0.15, max: 0.30 },
  suspendedThreads: { min: 0.05, max: 0.20 },
  epochSummaries: { min: 0.05, max: 0.20 },
  entities: { min: 0.03, max: 0.15 },
  reserve: { min: 0.05, max: 0.15 },
};

type BucketName = keyof TokenBudgetAllocations;

export class TokenBudgetManager {
  private budget: TokenBudget;

  constructor(provider: LLMProvider = 'openai') {
    const totalBudget = PROVIDER_BUDGETS[provider];
    this.budget = {
      provider,
      totalBudget,
      allocations: this.initializeAllocations(totalBudget),
    };
  }

  private initializeAllocations(total: number): TokenBudgetAllocations {
    const allocations: TokenBudgetAllocations = {} as TokenBudgetAllocations;
    
    for (const [bucket, percentages] of Object.entries(DEFAULT_ALLOCATION_PERCENTAGES)) {
      allocations[bucket as BucketName] = {
        min: Math.floor(total * percentages.min),
        max: Math.floor(total * percentages.max),
        current: 0,
      };
    }
    
    return allocations;
  }

  getTotalBudget(): number {
    return this.budget.totalBudget;
  }

  getProvider(): LLMProvider {
    return this.budget.provider;
  }

  getAllocations(): TokenBudgetAllocations {
    return { ...this.budget.allocations };
  }

  canAdd(bucket: BucketName, tokens: number): boolean {
    const allocation = this.budget.allocations[bucket];
    return allocation.current + tokens <= allocation.max;
  }

  allocate(bucket: BucketName, tokens: number): boolean {
    if (!this.canAdd(bucket, tokens - this.budget.allocations[bucket].current)) {
      return false;
    }
    this.budget.allocations[bucket].current = tokens;
    return true;
  }

  getCurrentUsage(): number {
    return Object.values(this.budget.allocations)
      .reduce((sum, alloc) => sum + alloc.current, 0);
  }

  getAvailableSpace(): number {
    return this.budget.totalBudget - this.getCurrentUsage();
  }

  rebalance(): void {
    const allocations = this.budget.allocations;
    const total = this.budget.totalBudget;
    
    // Find underutilized buckets
    const underutilized: BucketName[] = [];
    let reclaimable = 0;
    
    for (const [bucket, alloc] of Object.entries(allocations) as [BucketName, BucketAllocation][]) {
      if (alloc.current < alloc.min * 0.5) {
        underutilized.push(bucket);
        reclaimable += alloc.max - alloc.current;
      }
    }
    
    if (reclaimable === 0) return;
    
    // Distribute reclaimed space to active buckets proportionally
    const activeBuckets = Object.entries(allocations)
      .filter(([bucket]) => !underutilized.includes(bucket as BucketName)) as [BucketName, BucketAllocation][];
    
    const perBucketBonus = Math.floor(reclaimable / Math.max(activeBuckets.length, 1));
    
    for (const [bucket, alloc] of activeBuckets) {
      allocations[bucket].max = Math.min(
        alloc.max + perBucketBonus,
        total * 0.5 // Cap at 50% of total
      );
    }
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for English
    return Math.ceil(text.length / 4);
  }

  estimateCodeTokens(code: string): number {
    // Code is more token-dense: ~3 characters per token
    return Math.ceil(code.length / 3);
  }

  reset(): void {
    for (const bucket of Object.keys(this.budget.allocations) as BucketName[]) {
      this.budget.allocations[bucket].current = 0;
    }
  }

  setProvider(provider: LLMProvider): void {
    const totalBudget = PROVIDER_BUDGETS[provider];
    this.budget = {
      provider,
      totalBudget,
      allocations: this.initializeAllocations(totalBudget),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/tokenBudget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/TokenBudget.ts electron/tests/tokenBudget.test.ts
git commit -m "feat(conscious): add TokenBudgetManager with provider-adaptive budgets"
```

---

## Task 3: Interview Phase Detection

**Files:**
- Create: `electron/conscious/InterviewPhase.ts`
- Test: `electron/tests/interviewPhase.test.ts`

- [ ] **Step 1: Write failing tests for phase detection**

```typescript
// electron/tests/interviewPhase.test.ts
import { describe, it, expect } from 'vitest';
import { InterviewPhaseDetector } from '../conscious/InterviewPhase';
import { InterviewPhase } from '../conscious/types';

describe('InterviewPhaseDetector', () => {
  const detector = new InterviewPhaseDetector();

  it('should detect requirements_gathering phase', () => {
    const result = detector.detectPhase(
      "Can I assume we have unlimited storage?",
      'high_level_design',
      []
    );
    expect(result.phase).toBe('requirements_gathering');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should detect implementation phase', () => {
    const result = detector.detectPhase(
      "Let me write the code for this LRU cache",
      'deep_dive',
      []
    );
    expect(result.phase).toBe('implementation');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should detect behavioral_story phase', () => {
    const result = detector.detectPhase(
      "Tell me about a time you led a challenging project",
      'requirements_gathering',
      []
    );
    expect(result.phase).toBe('behavioral_story');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should maintain current phase when confidence is low', () => {
    const result = detector.detectPhase(
      "Okay, continue",
      'deep_dive',
      []
    );
    expect(result.phase).toBe('deep_dive');
  });

  it('should detect scaling_discussion from scale keywords', () => {
    const result = detector.detectPhase(
      "How would this scale to a million users?",
      'high_level_design',
      []
    );
    expect(result.phase).toBe('scaling_discussion');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/interviewPhase.test.ts`
Expected: FAIL

- [ ] **Step 3: Write InterviewPhaseDetector implementation**

```typescript
// electron/conscious/InterviewPhase.ts
import { InterviewPhase, INTERVIEW_PHASES } from './types';

interface PhaseSignal {
  phase: InterviewPhase;
  keywords: string[];
  patterns: RegExp[];
  transitionsFrom: (InterviewPhase | 'any')[];
}

const PHASE_SIGNALS: PhaseSignal[] = [
  {
    phase: 'requirements_gathering',
    keywords: ['clarify', 'assume', 'constraints', 'requirements', 'scope', 'users', 'scale'],
    patterns: [/what if/i, /how many/i, /can I assume/i, /do we need/i, /what's the/i],
    transitionsFrom: ['any'],
  },
  {
    phase: 'high_level_design',
    keywords: ['architecture', 'components', 'services', 'API', 'database', 'system', 'design'],
    patterns: [/high level/i, /overall design/i, /main components/i, /at a high level/i],
    transitionsFrom: ['requirements_gathering', 'behavioral_story'],
  },
  {
    phase: 'deep_dive',
    keywords: ['specifically', 'implementation', 'algorithm', 'data structure', 'details'],
    patterns: [/how would you/i, /walk me through/i, /let's dive into/i, /explain how/i],
    transitionsFrom: ['high_level_design', 'scaling_discussion', 'implementation'],
  },
  {
    phase: 'implementation',
    keywords: ['code', 'write', 'implement', 'class', 'function', 'method', 'solution'],
    patterns: [/can you code/i, /write the/i, /implement a/i, /let me write/i, /coding/i],
    transitionsFrom: ['deep_dive', 'high_level_design', 'complexity_analysis'],
  },
  {
    phase: 'complexity_analysis',
    keywords: ['complexity', 'Big O', 'time', 'space', 'optimize', 'runtime', 'performance'],
    patterns: [/what's the complexity/i, /can you optimize/i, /time and space/i, /O\(.*\)/i],
    transitionsFrom: ['implementation', 'deep_dive'],
  },
  {
    phase: 'scaling_discussion',
    keywords: ['scale', 'million', 'distributed', 'sharding', 'replication', 'load', 'throughput'],
    patterns: [/how would this scale/i, /million users/i, /what if.*10x/i, /at scale/i],
    transitionsFrom: ['high_level_design', 'complexity_analysis', 'deep_dive'],
  },
  {
    phase: 'failure_handling',
    keywords: ['failure', 'fallback', 'retry', 'error', 'crash', 'recovery', 'resilience'],
    patterns: [/what happens if/i, /how do you handle/i, /what about failures/i, /if.*fails/i],
    transitionsFrom: ['scaling_discussion', 'deep_dive', 'high_level_design'],
  },
  {
    phase: 'behavioral_story',
    keywords: ['tell me about', 'experience', 'example', 'time when', 'challenge', 'conflict'],
    patterns: [/tell me about a time/i, /describe a situation/i, /give me an example/i, /past experience/i],
    transitionsFrom: ['any'],
  },
  {
    phase: 'wrap_up',
    keywords: ['questions for me', 'anything else', 'thank you', 'next steps', 'timeline'],
    patterns: [/any questions/i, /that's all/i, /we're done/i, /questions for us/i],
    transitionsFrom: ['any'],
  },
];

export interface PhaseDetectionResult {
  phase: InterviewPhase;
  confidence: number;
  signals: string[];
}

export class InterviewPhaseDetector {
  private currentPhase: InterviewPhase = 'requirements_gathering';
  
  detectPhase(
    transcript: string,
    currentPhase: InterviewPhase,
    recentContext: string[]
  ): PhaseDetectionResult {
    const scores = new Map<InterviewPhase, { score: number; signals: string[] }>();
    const lowerTranscript = transcript.toLowerCase();
    
    for (const signal of PHASE_SIGNALS) {
      let score = 0;
      const matchedSignals: string[] = [];
      
      // Keyword matching (0.35 weight)
      const keywordMatches = signal.keywords.filter(k => 
        lowerTranscript.includes(k.toLowerCase())
      );
      if (keywordMatches.length > 0) {
        score += (keywordMatches.length / signal.keywords.length) * 0.35;
        matchedSignals.push(...keywordMatches.map(k => `keyword:${k}`));
      }
      
      // Pattern matching (0.45 weight)
      const patternMatches = signal.patterns.filter(p => p.test(transcript));
      if (patternMatches.length > 0) {
        score += (patternMatches.length / signal.patterns.length) * 0.45;
        matchedSignals.push(...patternMatches.map(p => `pattern:${p.source.slice(0, 20)}`));
      }
      
      // Transition validity (0.20 weight)
      if (signal.transitionsFrom.includes(currentPhase) || 
          signal.transitionsFrom.includes('any')) {
        score += 0.20;
        matchedSignals.push('valid_transition');
      }
      
      scores.set(signal.phase, { score, signals: matchedSignals });
    }
    
    // Find highest scoring phase
    let bestPhase = currentPhase;
    let bestScore = 0;
    let bestSignals: string[] = [];
    
    for (const [phase, { score, signals }] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
        bestSignals = signals;
      }
    }
    
    // Require minimum confidence to change phase
    const PHASE_CHANGE_THRESHOLD = 0.4;
    if (bestPhase !== currentPhase && bestScore < PHASE_CHANGE_THRESHOLD) {
      return { 
        phase: currentPhase, 
        confidence: scores.get(currentPhase)?.score || 0,
        signals: scores.get(currentPhase)?.signals || []
      };
    }
    
    this.currentPhase = bestPhase;
    return { phase: bestPhase, confidence: bestScore, signals: bestSignals };
  }
  
  getCurrentPhase(): InterviewPhase {
    return this.currentPhase;
  }
  
  setPhase(phase: InterviewPhase): void {
    this.currentPhase = phase;
  }
  
  reset(): void {
    this.currentPhase = 'requirements_gathering';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/interviewPhase.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/InterviewPhase.ts electron/tests/interviewPhase.test.ts
git commit -m "feat(conscious): add InterviewPhaseDetector with signal-based detection"
```

---

## Task 4: Confidence Scorer

**Files:**
- Create: `electron/conscious/ConfidenceScorer.ts`
- Test: `electron/tests/confidenceScorer.test.ts`

- [ ] **Step 1: Write failing tests for confidence scorer**

```typescript
// electron/tests/confidenceScorer.test.ts
import { describe, it, expect } from 'vitest';
import { ConfidenceScorer } from '../conscious/ConfidenceScorer';
import { ConversationThread, InterviewPhase } from '../conscious/types';

describe('ConfidenceScorer', () => {
  const scorer = new ConfidenceScorer();

  const createMockThread = (overrides: Partial<ConversationThread> = {}): ConversationThread => ({
    id: 'test-thread',
    status: 'suspended',
    topic: 'caching layer design',
    goal: 'Design Redis caching',
    phase: 'high_level_design',
    keyDecisions: ['Use Redis', 'TTL-based expiry'],
    constraints: [],
    codeContext: { snippets: [], maxSnippets: 3, totalTokenBudget: 500 },
    createdAt: Date.now() - 60000,
    lastActiveAt: Date.now() - 30000,
    suspendedAt: Date.now() - 30000,
    ttlMs: 300000,
    resumeKeywords: ['caching', 'redis', 'cache', 'layer'],
    turnCount: 5,
    tokenCount: 200,
    resumeCount: 0,
    ...overrides,
  });

  it('should return high confidence for explicit resume markers', () => {
    const thread = createMockThread();
    const score = scorer.calculateResumeConfidence(
      "Let's go back to the caching layer",
      thread,
      'high_level_design'
    );
    expect(score.total).toBeGreaterThanOrEqual(0.69);
    expect(score.explicitMarkers).toBeGreaterThan(0);
  });

  it('should apply temporal decay to old threads', () => {
    const freshThread = createMockThread({ suspendedAt: Date.now() - 60000 });
    const oldThread = createMockThread({ suspendedAt: Date.now() - 240000 });

    const freshScore = scorer.calculateResumeConfidence('caching', freshThread, 'high_level_design');
    const oldScore = scorer.calculateResumeConfidence('caching', oldThread, 'high_level_design');

    expect(freshScore.temporalDecay).toBeGreaterThan(oldScore.temporalDecay);
  });

  it('should give phase alignment bonus', () => {
    const thread = createMockThread({ phase: 'high_level_design' });
    const alignedScore = scorer.calculateResumeConfidence('caching', thread, 'high_level_design');
    const misalignedScore = scorer.calculateResumeConfidence('caching', thread, 'implementation');

    expect(alignedScore.phaseAlignment).toBeGreaterThan(misalignedScore.phaseAlignment);
  });

  it('should apply topic shift penalty', () => {
    const thread = createMockThread();
    const score = scorer.calculateResumeConfidence(
      "Let's move on to a different topic entirely",
      thread,
      'high_level_design'
    );
    expect(score.topicShiftPenalty).toBeGreaterThan(0);
  });

  it('should calculate BM25 score for keyword overlap', () => {
    const thread = createMockThread({ resumeKeywords: ['caching', 'redis', 'layer'] });
    const score = scorer.calculateResumeConfidence('redis caching layer', thread, 'high_level_design');
    expect(score.bm25Score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/confidenceScorer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write ConfidenceScorer implementation**

```typescript
// electron/conscious/ConfidenceScorer.ts
import { 
  ConversationThread, 
  ConfidenceScore, 
  CONFIDENCE_WEIGHTS,
  InterviewPhase,
  RESUME_THRESHOLD 
} from './types';

const EXPLICIT_RESUME_MARKERS = [
  /back to/i,
  /as I was saying/i,
  /going back/i,
  /returning to/i,
  /where were we/i,
  /continuing with/i,
  /let's continue/i,
  /about that.*earlier/i,
  /picking up/i,
  /resume/i,
];

const TOPIC_SHIFT_MARKERS = [
  'new question',
  'different topic', 
  "let's talk about",
  'moving on',
  'switch gears',
  'change topic',
  'new subject',
];

export class ConfidenceScorer {
  calculateResumeConfidence(
    transcript: string,
    thread: ConversationThread,
    currentPhase: InterviewPhase,
    sttConfidence: number = 0.9
  ): ConfidenceScore {
    const now = Date.now();
    const lowerTranscript = transcript.toLowerCase();
    
    // BM25 keyword overlap
    const bm25Score = this.calculateBM25(transcript, thread.resumeKeywords);
    
    // Explicit resume markers
    const hasExplicitMarker = EXPLICIT_RESUME_MARKERS.some(p => p.test(transcript));
    const explicitMarkers = hasExplicitMarker ? 1.0 : 0.0;
    
    // Temporal decay (exponential decay over TTL)
    const timeSinceSuspend = now - (thread.suspendedAt || now);
    const temporalDecay = Math.exp(-timeSinceSuspend / (thread.ttlMs / 2));
    
    // Phase alignment
    const phaseAlignment = currentPhase === thread.phase ? 1.0 : 0.3;
    
    // STT quality factor
    const sttQuality = sttConfidence;
    
    // Topic shift penalty
    const hasTopicShift = TOPIC_SHIFT_MARKERS.some(marker => 
      lowerTranscript.includes(marker)
    );
    const topicShiftPenalty = hasTopicShift ? 1.0 : 0.0;
    
    // Interruption recency penalty
    const recentInterruption = thread.interruptedBy && 
      lowerTranscript.includes(thread.interruptedBy.toLowerCase());
    const interruptionRecency = recentInterruption ? 1.0 : 0.0;
    
    // Embedding score placeholder (0 if not available)
    const embeddingScore = 0;
    
    // Calculate weighted sum
    const total = Math.max(0, Math.min(1,
      (bm25Score * CONFIDENCE_WEIGHTS.bm25) +
      (embeddingScore * CONFIDENCE_WEIGHTS.embedding) +
      (explicitMarkers * CONFIDENCE_WEIGHTS.explicitMarkers) +
      (temporalDecay * CONFIDENCE_WEIGHTS.temporalDecay) +
      (phaseAlignment * CONFIDENCE_WEIGHTS.phaseAlignment) +
      (sttQuality * CONFIDENCE_WEIGHTS.sttQuality) +
      (topicShiftPenalty * CONFIDENCE_WEIGHTS.topicShiftPenalty) +
      (interruptionRecency * CONFIDENCE_WEIGHTS.interruptionRecency)
    ));
    
    return {
      bm25Score,
      embeddingScore,
      explicitMarkers,
      temporalDecay,
      phaseAlignment,
      sttQuality,
      topicShiftPenalty,
      interruptionRecency,
      total,
    };
  }
  
  private calculateBM25(
    query: string,
    documentKeywords: string[],
    k1: number = 1.5,
    b: number = 0.75
  ): number {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || documentKeywords.length === 0) return 0;
    
    const avgDocLength = 10;
    const docLength = documentKeywords.length;
    
    let score = 0;
    
    for (const term of queryTerms) {
      const tf = documentKeywords.filter(k => 
        k.toLowerCase().includes(term.toLowerCase()) ||
        term.toLowerCase().includes(k.toLowerCase())
      ).length;
      
      if (tf === 0) continue;
      
      // Simplified IDF
      const idf = Math.log(1 + (3 - tf + 0.5) / (tf + 0.5));
      
      // BM25 term score
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      
      score += idf * (numerator / denominator);
    }
    
    // Normalize to 0-1 range
    return Math.min(1, score / queryTerms.length);
  }
  
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }
  
  shouldResume(confidence: ConfidenceScore): boolean {
    return confidence.total >= RESUME_THRESHOLD;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/confidenceScorer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/ConfidenceScorer.ts electron/tests/confidenceScorer.test.ts
git commit -m "feat(conscious): add ConfidenceScorer with BM25 and heuristic signals"
```

---

## Task 5: Thread Manager

**Files:**
- Create: `electron/conscious/ThreadManager.ts`
- Test: `electron/tests/threadManager.test.ts`

- [ ] **Step 1: Write failing tests for thread manager**

```typescript
// electron/tests/threadManager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadManager } from '../conscious/ThreadManager';

describe('ThreadManager', () => {
  let manager: ThreadManager;

  beforeEach(() => {
    manager = new ThreadManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a new thread', () => {
    const thread = manager.createThread('Design YouTube', 'high_level_design');
    expect(thread.topic).toBe('Design YouTube');
    expect(thread.phase).toBe('high_level_design');
    expect(thread.status).toBe('active');
  });

  it('should suspend active thread when creating new', () => {
    manager.createThread('Design YouTube', 'high_level_design');
    manager.createThread('Leadership story', 'behavioral_story');
    
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(1);
    expect(suspended[0].topic).toBe('Design YouTube');
    expect(suspended[0].status).toBe('suspended');
  });

  it('should limit suspended threads to 3', () => {
    manager.createThread('Thread 1', 'high_level_design');
    manager.createThread('Thread 2', 'deep_dive');
    manager.createThread('Thread 3', 'implementation');
    manager.createThread('Thread 4', 'scaling_discussion');
    
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(3);
    expect(suspended.some(t => t.topic === 'Thread 1')).toBe(false); // Oldest evicted
  });

  it('should resume a suspended thread', () => {
    const original = manager.createThread('Design YouTube', 'high_level_design');
    manager.createThread('Leadership story', 'behavioral_story');
    
    const resumed = manager.resumeThread(original.id);
    expect(resumed).toBe(true);
    expect(manager.getActiveThread()?.topic).toBe('Design YouTube');
    expect(manager.getActiveThread()?.resumeCount).toBe(1);
  });

  it('should expire threads past TTL', () => {
    manager.createThread('Old thread', 'high_level_design');
    manager.createThread('New thread', 'behavioral_story');
    
    // Advance time past TTL (5 minutes)
    vi.advanceTimersByTime(6 * 60 * 1000);
    
    manager.pruneExpired();
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(0);
  });

  it('should find matching thread by keywords', () => {
    manager.createThread('Design caching layer', 'high_level_design');
    manager.createThread('Tell me about leadership', 'behavioral_story');
    
    const match = manager.findMatchingThread("Let's go back to the caching discussion");
    expect(match).not.toBeNull();
    expect(match?.thread.topic).toContain('caching');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/threadManager.test.ts`
Expected: FAIL

- [ ] **Step 3: Write ThreadManager implementation**

```typescript
// electron/conscious/ThreadManager.ts
import { 
  ConversationThread, 
  InterviewPhase, 
  ThreadCodeContext,
  ConfidenceScore 
} from './types';
import { ConfidenceScorer } from './ConfidenceScorer';

const MAX_SUSPENDED_THREADS = 3;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateThreadId(): string {
  return `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
    'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not', 'only',
    'own', 'same', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'me', 'you', 'it', 'we', 'they', 'i', 'let', 'about', 'tell', 'design', 'implement']);
  
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

export class ThreadManager {
  private activeThread: ConversationThread | null = null;
  private suspendedThreads: ConversationThread[] = [];
  private confidenceScorer: ConfidenceScorer = new ConfidenceScorer();

  createThread(topic: string, phase: InterviewPhase): ConversationThread {
    // Suspend current active thread if exists
    if (this.activeThread) {
      this.suspendActive(topic);
    }
    
    const now = Date.now();
    const newThread: ConversationThread = {
      id: generateThreadId(),
      status: 'active',
      topic,
      goal: `Discuss ${topic}`,
      phase,
      keyDecisions: [],
      constraints: [],
      codeContext: { snippets: [], maxSnippets: 3, totalTokenBudget: 500 },
      createdAt: now,
      lastActiveAt: now,
      ttlMs: DEFAULT_TTL_MS,
      resumeKeywords: extractKeywords(topic),
      turnCount: 0,
      tokenCount: 0,
      resumeCount: 0,
    };
    
    this.activeThread = newThread;
    return newThread;
  }

  suspendActive(interruptedBy?: string): void {
    if (!this.activeThread) return;
    
    this.activeThread.status = 'suspended';
    this.activeThread.suspendedAt = Date.now();
    if (interruptedBy) {
      this.activeThread.interruptedBy = interruptedBy;
    }
    
    // Add to suspended list
    this.suspendedThreads.unshift(this.activeThread);
    
    // Enforce max suspended threads (evict oldest)
    while (this.suspendedThreads.length > MAX_SUSPENDED_THREADS) {
      this.suspendedThreads.pop();
    }
    
    this.activeThread = null;
  }

  resumeThread(threadId: string): boolean {
    const index = this.suspendedThreads.findIndex(t => t.id === threadId);
    if (index === -1) return false;
    
    // Suspend current active first
    if (this.activeThread) {
      this.suspendActive();
    }
    
    // Resume the target thread
    const thread = this.suspendedThreads.splice(index, 1)[0];
    thread.status = 'active';
    thread.lastActiveAt = Date.now();
    thread.resumeCount += 1;
    delete thread.suspendedAt;
    delete thread.interruptedBy;
    
    this.activeThread = thread;
    return true;
  }

  getActiveThread(): ConversationThread | null {
    return this.activeThread;
  }

  getSuspendedThreads(): ConversationThread[] {
    return [...this.suspendedThreads];
  }

  findMatchingThread(
    transcript: string,
    currentPhase: InterviewPhase = 'requirements_gathering'
  ): { thread: ConversationThread; confidence: ConfidenceScore } | null {
    if (this.suspendedThreads.length === 0) return null;
    
    let bestMatch: { thread: ConversationThread; confidence: ConfidenceScore } | null = null;
    
    for (const thread of this.suspendedThreads) {
      const confidence = this.confidenceScorer.calculateResumeConfidence(
        transcript, 
        thread, 
        currentPhase
      );
      
      if (!bestMatch || confidence.total > bestMatch.confidence.total) {
        bestMatch = { thread, confidence };
      }
    }
    
    return bestMatch;
  }

  pruneExpired(): number {
    const now = Date.now();
    const initialCount = this.suspendedThreads.length;
    
    this.suspendedThreads = this.suspendedThreads.filter(thread => {
      const suspendedAt = thread.suspendedAt || thread.lastActiveAt;
      const age = now - suspendedAt;
      return age < thread.ttlMs;
    });
    
    return initialCount - this.suspendedThreads.length;
  }

  updateActiveThread(updates: Partial<ConversationThread>): void {
    if (!this.activeThread) return;
    
    Object.assign(this.activeThread, updates, { lastActiveAt: Date.now() });
  }

  addDecisionToActive(decision: string): void {
    if (!this.activeThread) return;
    
    if (!this.activeThread.keyDecisions.includes(decision)) {
      this.activeThread.keyDecisions.push(decision);
    }
  }

  addKeywordsToActive(keywords: string[]): void {
    if (!this.activeThread) return;
    
    const existing = new Set(this.activeThread.resumeKeywords);
    for (const keyword of keywords) {
      if (!existing.has(keyword)) {
        this.activeThread.resumeKeywords.push(keyword);
      }
    }
  }

  reset(): void {
    this.activeThread = null;
    this.suspendedThreads = [];
  }

  completeActiveThread(): void {
    if (this.activeThread) {
      this.activeThread.status = 'completed';
      this.activeThread = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/threadManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/ThreadManager.ts electron/tests/threadManager.test.ts
git commit -m "feat(conscious): add ThreadManager with suspend/resume lifecycle"
```

---

## Task 6: Fallback Executor

**Files:**
- Create: `electron/conscious/FallbackExecutor.ts`
- Test: `electron/tests/fallbackExecutor.test.ts`

- [ ] **Step 1: Write failing tests for fallback executor**

```typescript
// electron/tests/fallbackExecutor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FallbackExecutor } from '../conscious/FallbackExecutor';
import { InterviewPhase } from '../conscious/types';

describe('FallbackExecutor', () => {
  let executor: FallbackExecutor;

  beforeEach(() => {
    executor = new FallbackExecutor();
  });

  it('should return emergency template for phase', () => {
    const response = executor.getEmergencyResponse('requirements_gathering');
    expect(response).toBeTruthy();
    expect(typeof response).toBe('string');
    expect(response.length).toBeGreaterThan(10);
  });

  it('should have emergency templates for all phases', () => {
    const phases: InterviewPhase[] = [
      'requirements_gathering', 'high_level_design', 'deep_dive',
      'implementation', 'complexity_analysis', 'scaling_discussion',
      'failure_handling', 'behavioral_story', 'wrap_up'
    ];
    
    for (const phase of phases) {
      const response = executor.getEmergencyResponse(phase);
      expect(response).toBeTruthy();
    }
  });

  it('should track failure state', () => {
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    
    const state = executor.getFailureState();
    expect(state.consecutiveFailures).toBe(2);
    expect(state.degradationLevel).toBe('reduced');
  });

  it('should recover on success', () => {
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    executor.recordSuccess();
    
    const state = executor.getFailureState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.degradationLevel).toBe('none');
  });

  it('should get start tier based on degradation level', () => {
    expect(executor.getStartTier()).toBe(0); // none -> tier 0
    
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    expect(executor.getStartTier()).toBe(1); // reduced -> tier 1
    
    executor.recordFailure('reduced_conscious');
    executor.recordFailure('reduced_conscious');
    expect(executor.getStartTier()).toBe(2); // minimal -> tier 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/fallbackExecutor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write FallbackExecutor implementation**

```typescript
// electron/conscious/FallbackExecutor.ts
import { 
  InterviewPhase, 
  FallbackTier, 
  FallbackTierConfig, 
  FALLBACK_TIERS,
  FailureState, 
  DegradationLevel,
  ConsciousResponse 
} from './types';
import { CONSCIOUS_MODE_EMERGENCY_TEMPLATES } from '../llm/prompts';

const FAILURE_THRESHOLDS = {
  reduced: 2,
  minimal: 4,
  emergency: 6,
  recovery: 2,
  cooldownMs: 300000, // 5 minutes
};

export class FallbackExecutor {
  private failureState: FailureState = {
    consecutiveFailures: 0,
    totalFailures: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    degradationLevel: 'none',
    tierFailures: {
      full_conscious: 0,
      reduced_conscious: 0,
      normal_mode: 0,
      emergency_local: 0,
    },
  };

  getEmergencyResponse(phase: InterviewPhase): string {
    const templates = CONSCIOUS_MODE_EMERGENCY_TEMPLATES[phase];
    if (!templates || templates.length === 0) {
      return "Let me think about that for a moment...";
    }
    return templates[Math.floor(Math.random() * templates.length)];
  }

  recordFailure(tier: FallbackTier): void {
    this.failureState.consecutiveFailures += 1;
    this.failureState.totalFailures += 1;
    this.failureState.lastFailureTime = Date.now();
    this.failureState.tierFailures[tier] += 1;
    this.failureState.degradationLevel = this.calculateDegradationLevel();
  }

  recordSuccess(): void {
    this.failureState.consecutiveFailures = Math.max(
      0, 
      this.failureState.consecutiveFailures - FAILURE_THRESHOLDS.recovery
    );
    this.failureState.lastSuccessTime = Date.now();
    this.failureState.degradationLevel = this.calculateDegradationLevel();
  }

  private calculateDegradationLevel(): DegradationLevel {
    const failures = this.failureState.consecutiveFailures;
    if (failures >= FAILURE_THRESHOLDS.emergency) return 'emergency';
    if (failures >= FAILURE_THRESHOLDS.minimal) return 'minimal';
    if (failures >= FAILURE_THRESHOLDS.reduced) return 'reduced';
    return 'none';
  }

  getFailureState(): FailureState {
    return { ...this.failureState };
  }

  getStartTier(): number {
    switch (this.failureState.degradationLevel) {
      case 'emergency': return 3;
      case 'minimal': return 2;
      case 'reduced': return 1;
      default: return 0;
    }
  }

  getTierConfig(tierIndex: number): FallbackTierConfig {
    return FALLBACK_TIERS[Math.min(tierIndex, FALLBACK_TIERS.length - 1)];
  }

  checkAutoRecovery(): boolean {
    const now = Date.now();
    if (this.failureState.lastFailureTime && 
        now - this.failureState.lastFailureTime > FAILURE_THRESHOLDS.cooldownMs) {
      this.failureState.consecutiveFailures = 0;
      this.failureState.degradationLevel = 'none';
      return true;
    }
    return false;
  }

  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  buildEmergencyResponse(phase: InterviewPhase): ConsciousResponse {
    return {
      success: true,
      mode: 'direct',
      openingReasoning: '',
      spokenResponse: this.getEmergencyResponse(phase),
      implementationPlan: [],
      tradeoffs: [],
      edgeCases: [],
      likelyFollowUps: [],
      pushbackResponses: {},
      tier: 3,
      phase,
      threadId: '',
      latencyMs: 0,
      tokensUsed: 0,
    };
  }

  reset(): void {
    this.failureState = {
      consecutiveFailures: 0,
      totalFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      degradationLevel: 'none',
      tierFailures: {
        full_conscious: 0,
        reduced_conscious: 0,
        normal_mode: 0,
        emergency_local: 0,
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/fallbackExecutor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/conscious/FallbackExecutor.ts electron/tests/fallbackExecutor.test.ts
git commit -m "feat(conscious): add FallbackExecutor with tiered degradation"
```

---

## Task 7: Module Index and Exports

**Files:**
- Create: `electron/conscious/index.ts`

- [ ] **Step 1: Create module index**

```typescript
// electron/conscious/index.ts
export * from './types';
export { TokenBudgetManager } from './TokenBudget';
export { InterviewPhaseDetector } from './InterviewPhase';
export { ConfidenceScorer } from './ConfidenceScorer';
export { ThreadManager } from './ThreadManager';
export { FallbackExecutor } from './FallbackExecutor';
```

- [ ] **Step 2: Verify imports work**

Run: `cd electron && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add electron/conscious/index.ts
git commit -m "feat(conscious): add module exports"
```

---

## Task 8: Integration with SessionTracker

**Files:**
- Modify: `electron/SessionTracker.ts`
- Test: `electron/tests/sessionTrackerConscious.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// electron/tests/sessionTrackerConscious.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from '../SessionTracker';

describe('SessionTracker Conscious Integration', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it('should initialize with thread manager', () => {
    expect(tracker.getThreadManager()).toBeDefined();
  });

  it('should initialize with phase detector', () => {
    expect(tracker.getPhaseDetector()).toBeDefined();
  });

  it('should get current interview phase', () => {
    const phase = tracker.getCurrentPhase();
    expect(phase).toBe('requirements_gathering'); // Default
  });

  it('should create thread on conscious mode activation', () => {
    tracker.setConsciousModeEnabled(true);
    const thread = tracker.getThreadManager().createThread('Test topic', 'high_level_design');
    expect(thread).toBeDefined();
    expect(thread.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/sessionTrackerConscious.test.ts`
Expected: FAIL (methods don't exist yet)

- [ ] **Step 3: Update SessionTracker with conscious mode integration**

Add to `electron/SessionTracker.ts` after imports:

```typescript
import { ThreadManager, InterviewPhaseDetector, TokenBudgetManager, InterviewPhase } from './conscious';
```

Add new private fields after existing fields:

```typescript
    // Conscious Mode Realtime components
    private threadManager: ThreadManager = new ThreadManager();
    private phaseDetector: InterviewPhaseDetector = new InterviewPhaseDetector();
    private tokenBudgetManager: TokenBudgetManager = new TokenBudgetManager('openai');
```

Add new methods before the `reset()` method:

```typescript
    // ============================================
    // Conscious Mode Realtime Accessors
    // ============================================

    getThreadManager(): ThreadManager {
        return this.threadManager;
    }

    getPhaseDetector(): InterviewPhaseDetector {
        return this.phaseDetector;
    }

    getTokenBudgetManager(): TokenBudgetManager {
        return this.tokenBudgetManager;
    }

    getCurrentPhase(): InterviewPhase {
        return this.phaseDetector.getCurrentPhase();
    }

    setCurrentPhase(phase: InterviewPhase): void {
        this.phaseDetector.setPhase(phase);
    }

    detectPhaseFromTranscript(transcript: string): InterviewPhase {
        const result = this.phaseDetector.detectPhase(
            transcript,
            this.phaseDetector.getCurrentPhase(),
            this.contextItems.slice(-5).map(item => item.text)
        );
        return result.phase;
    }
```

Update the `reset()` method to include:

```typescript
        this.threadManager.reset();
        this.phaseDetector.reset();
        this.tokenBudgetManager.reset();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/sessionTrackerConscious.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/SessionTracker.ts electron/tests/sessionTrackerConscious.test.ts
git commit -m "feat(session): integrate ThreadManager and PhaseDetector into SessionTracker"
```

---

## Task 9: Integration with IntelligenceEngine

**Files:**
- Modify: `electron/IntelligenceEngine.ts`
- Test: `electron/tests/intelligenceEngineConscious.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// electron/tests/intelligenceEngineConscious.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { LLMHelper } from '../LLMHelper';

// Mock LLMHelper
vi.mock('../LLMHelper', () => ({
  LLMHelper: vi.fn().mockImplementation(() => ({
    getProvider: () => 'openai',
  })),
}));

describe('IntelligenceEngine Conscious Integration', () => {
  let engine: IntelligenceEngine;
  let session: SessionTracker;

  beforeEach(() => {
    const mockLLMHelper = new LLMHelper({} as any, {} as any);
    session = new SessionTracker();
    engine = new IntelligenceEngine(mockLLMHelper, session);
  });

  it('should have fallback executor', () => {
    expect(engine.getFallbackExecutor()).toBeDefined();
  });

  it('should detect phase from transcript', () => {
    session.setConsciousModeEnabled(true);
    const phase = session.detectPhaseFromTranscript('Can I clarify the requirements?');
    expect(phase).toBe('requirements_gathering');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run tests/intelligenceEngineConscious.test.ts`
Expected: FAIL

- [ ] **Step 3: Update IntelligenceEngine with fallback executor**

Add import at top of `electron/IntelligenceEngine.ts`:

```typescript
import { FallbackExecutor, InterviewPhase, CONSCIOUS_MODE_PHASE_PROMPTS } from './conscious';
```

Add new field after existing fields:

```typescript
    private fallbackExecutor: FallbackExecutor = new FallbackExecutor();
```

Add accessor method:

```typescript
    getFallbackExecutor(): FallbackExecutor {
        return this.fallbackExecutor;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run tests/intelligenceEngineConscious.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/IntelligenceEngine.ts electron/tests/intelligenceEngineConscious.test.ts
git commit -m "feat(engine): integrate FallbackExecutor into IntelligenceEngine"
```

---

## Task 10: Full Integration Test

**Files:**
- Create: `electron/tests/consciousModeIntegration.test.ts`

- [ ] **Step 1: Write end-to-end integration test**

```typescript
// electron/tests/consciousModeIntegration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from '../SessionTracker';
import { ThreadManager } from '../conscious/ThreadManager';
import { InterviewPhaseDetector } from '../conscious/InterviewPhase';
import { ConfidenceScorer } from '../conscious/ConfidenceScorer';
import { FallbackExecutor } from '../conscious/FallbackExecutor';
import { RESUME_THRESHOLD } from '../conscious/types';

describe('Conscious Mode Integration', () => {
  let session: SessionTracker;

  beforeEach(() => {
    session = new SessionTracker();
    session.setConsciousModeEnabled(true);
  });

  describe('Thread Resume Flow', () => {
    it('should suspend and resume threads correctly', () => {
      const threadManager = session.getThreadManager();
      
      // Start system design discussion
      const designThread = threadManager.createThread(
        'Design YouTube video streaming',
        'high_level_design'
      );
      expect(designThread.status).toBe('active');
      
      // Behavioral interruption
      threadManager.createThread(
        'Leadership experience story',
        'behavioral_story'
      );
      
      // Original thread should be suspended
      const suspended = threadManager.getSuspendedThreads();
      expect(suspended.length).toBe(1);
      expect(suspended[0].topic).toContain('YouTube');
      
      // Resume original thread
      const scorer = new ConfidenceScorer();
      const confidence = scorer.calculateResumeConfidence(
        "Let's go back to the YouTube design",
        suspended[0],
        'high_level_design'
      );
      
      expect(confidence.total).toBeGreaterThanOrEqual(RESUME_THRESHOLD);
      
      // Actually resume
      threadManager.resumeThread(suspended[0].id);
      expect(threadManager.getActiveThread()?.topic).toContain('YouTube');
    });
  });

  describe('Phase Detection Flow', () => {
    it('should detect phase transitions correctly', () => {
      const detector = session.getPhaseDetector();
      
      // Start with requirements
      let result = detector.detectPhase(
        'What are the scale requirements?',
        'requirements_gathering',
        []
      );
      expect(result.phase).toBe('requirements_gathering');
      
      // Transition to design
      result = detector.detectPhase(
        'Let me draw the high-level architecture',
        'requirements_gathering',
        []
      );
      expect(result.phase).toBe('high_level_design');
      
      // Deep dive
      result = detector.detectPhase(
        'Walk me through how the caching layer works',
        'high_level_design',
        []
      );
      expect(result.phase).toBe('deep_dive');
    });
  });

  describe('Fallback Chain', () => {
    it('should handle failures gracefully', () => {
      const executor = new FallbackExecutor();
      
      // Simulate failures
      executor.recordFailure('full_conscious');
      executor.recordFailure('full_conscious');
      
      expect(executor.getStartTier()).toBe(1); // Skip tier 0
      
      // Get emergency response
      const emergency = executor.getEmergencyResponse('high_level_design');
      expect(emergency.length).toBeGreaterThan(10);
      
      // Recovery
      executor.recordSuccess();
      expect(executor.getFailureState().consecutiveFailures).toBe(0);
    });
  });

  describe('Full Interview Scenario', () => {
    it('should handle Google L5 system design with interruption', () => {
      const threadManager = session.getThreadManager();
      const phaseDetector = session.getPhaseDetector();
      const scorer = new ConfidenceScorer();
      
      // Phase 1: Requirements
      let phase = phaseDetector.detectPhase(
        'Design YouTube. What scale should we target?',
        'requirements_gathering',
        []
      );
      expect(phase.phase).toBe('requirements_gathering');
      
      const youtubeThread = threadManager.createThread('Design YouTube', phase.phase);
      threadManager.addDecisionToActive('Target 1B DAU');
      threadManager.addKeywordsToActive(['youtube', 'video', 'streaming']);
      
      // Phase 2: High-level design
      phase = phaseDetector.detectPhase(
        'Walk me through the high-level architecture',
        'requirements_gathering',
        []
      );
      threadManager.updateActiveThread({ phase: phase.phase });
      
      // Interruption: Behavioral question
      phase = phaseDetector.detectPhase(
        'Tell me about a time you led a challenging project',
        'high_level_design',
        []
      );
      expect(phase.phase).toBe('behavioral_story');
      
      threadManager.createThread('Leadership story', 'behavioral_story');
      
      // YouTube thread should be suspended
      const suspended = threadManager.getSuspendedThreads();
      expect(suspended[0].topic).toBe('Design YouTube');
      expect(suspended[0].keyDecisions).toContain('Target 1B DAU');
      
      // Resume YouTube discussion
      const resumeConfidence = scorer.calculateResumeConfidence(
        "Let's go back to the YouTube architecture",
        suspended[0],
        'behavioral_story'
      );
      
      expect(resumeConfidence.total).toBeGreaterThanOrEqual(0.5);
      expect(scorer.shouldResume(resumeConfidence)).toBe(true);
      
      threadManager.resumeThread(suspended[0].id);
      expect(threadManager.getActiveThread()?.topic).toBe('Design YouTube');
      expect(threadManager.getActiveThread()?.resumeCount).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run full integration test**

Run: `cd electron && npx vitest run tests/consciousModeIntegration.test.ts`
Expected: PASS

- [ ] **Step 3: Run all conscious mode tests**

Run: `cd electron && npx vitest run tests/conscious --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add electron/tests/consciousModeIntegration.test.ts
git commit -m "test(conscious): add full integration tests for Conscious Mode Realtime"
```

---

## Task 11: Final Verification and Cleanup

- [ ] **Step 1: Run all tests**

Run: `cd electron && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript type check**

Run: `cd electron && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No errors or only warnings

- [ ] **Step 4: Create final commit**

```bash
git add -A
git commit -m "feat(conscious): complete Conscious Mode Realtime implementation

- Add hierarchical token budget system with provider-adaptive limits
- Add interview phase detection with signal-based state machine
- Add thread management with suspend/resume lifecycle
- Add hybrid confidence scoring (BM25 + heuristics) with 0.69 threshold
- Add four-tier fallback chain with timeout handling
- Add emergency templates for graceful degradation
- Integrate with SessionTracker and IntelligenceEngine
- Add comprehensive unit and integration tests"
```

---

## Summary

This implementation plan covers:

1. **Types (Task 1)**: Core interfaces and constants
2. **Token Budget (Task 2)**: Provider-adaptive budget management
3. **Phase Detection (Task 3)**: Interview phase state machine
4. **Confidence Scoring (Task 4)**: BM25 + heuristic resume decisions
5. **Thread Management (Task 5)**: Active/suspended thread lifecycle
6. **Fallback Executor (Task 6)**: Four-tier degradation chain
7. **Module Exports (Task 7)**: Clean module structure
8. **SessionTracker Integration (Task 8)**: State management hooks
9. **IntelligenceEngine Integration (Task 9)**: Routing hooks
10. **Integration Tests (Task 10)**: End-to-end scenarios
11. **Final Verification (Task 11)**: Type checking and linting

Each task follows TDD principles with explicit file paths, complete code, and verification steps.
