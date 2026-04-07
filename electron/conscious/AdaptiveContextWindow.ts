import { InterviewPhase } from './types';
import { isOptimizationActive } from '../config/optimizations';
import { TokenCounter } from '../shared/TokenCounter';

export interface ContextEntry {
  text: string;
  timestamp: number;
  embedding?: number[];
  phase?: InterviewPhase;
}

export interface ContextSelectionConfig {
  tokenBudget: number;
  recencyWeight: number;
  semanticWeight: number;
  phaseAlignmentWeight: number;
}

export class AdaptiveContextWindow {
  private currentPhase: InterviewPhase = 'requirements_gathering';
  private tokenCounter: TokenCounter;

  constructor(private readonly modelHint: string = 'generic') {
    this.tokenCounter = new TokenCounter(modelHint);
  }

  setCurrentPhase(phase: InterviewPhase): void {
    this.currentPhase = phase;
  }

  async selectContext(
    _query: string,
    queryEmbedding: number[],
    candidates: ContextEntry[],
    config: ContextSelectionConfig
  ): Promise<ContextEntry[]> {
    if (!isOptimizationActive('useAdaptiveWindow')) {
      return this.selectContextLegacy(candidates, config.tokenBudget);
    }

    const scored = await Promise.all(
      candidates.map(async (entry) => ({
        entry,
        score: this.computeScore(entry, queryEmbedding, config),
      }))
    );

    scored.sort((a, b) => b.score - a.score);

    const selected: ContextEntry[] = [];
    let usedTokens = 0;

    for (const { entry } of scored) {
      const entryTokens = this.estimateTokens(entry.text);
      if (usedTokens + entryTokens <= config.tokenBudget) {
        selected.push(entry);
        usedTokens += entryTokens;
      }
    }

    return selected;
  }

  private computeScore(
    entry: ContextEntry,
    queryEmbedding: number[],
    config: ContextSelectionConfig
  ): number {
    const recencyScore = this.computeRecency(entry.timestamp);
    const semanticScore = entry.embedding
      ? this.cosineSimilarity(entry.embedding, queryEmbedding)
      : 0;
    const phaseScore = this.computePhaseAlignment(entry.phase, this.currentPhase);

    return (
      config.recencyWeight * recencyScore +
      config.semanticWeight * semanticScore +
      config.phaseAlignmentWeight * phaseScore
    );
  }

  private computeRecency(timestamp: number): number {
    const ageMs = Date.now() - timestamp;
    const ageSeconds = ageMs / 1000;

    const halfLife = 120;
    return Math.pow(2, -ageSeconds / halfLife);
  }

  private computePhaseAlignment(
    entryPhase: InterviewPhase | undefined,
    currentPhase: InterviewPhase
  ): number {
    if (!entryPhase) return 0.5;

    if (entryPhase === currentPhase) return 1.0;
    if (this.isAdjacentPhase(entryPhase, currentPhase)) return 0.7;
    if (this.isRelatedPhase(entryPhase, currentPhase)) return 0.4;

    return 0.1;
  }

  private isAdjacentPhase(a: InterviewPhase, b: InterviewPhase): boolean {
    const phaseOrder: InterviewPhase[] = [
      'requirements_gathering',
      'high_level_design',
      'deep_dive',
      'implementation',
      'complexity_analysis',
      'scaling_discussion',
      'failure_handling',
      'behavioral_story',
      'wrap_up',
    ];

    const idxA = phaseOrder.indexOf(a);
    const idxB = phaseOrder.indexOf(b);

    return Math.abs(idxA - idxB) <= 1;
  }

  private isRelatedPhase(a: InterviewPhase, b: InterviewPhase): boolean {
    const relatedGroups: Record<InterviewPhase, InterviewPhase[]> = {
      requirements_gathering: ['high_level_design'],
      high_level_design: ['requirements_gathering', 'deep_dive'],
      deep_dive: ['high_level_design', 'implementation'],
      implementation: ['deep_dive'],
      complexity_analysis: ['deep_dive', 'scaling_discussion'],
      scaling_discussion: ['complexity_analysis', 'failure_handling'],
      failure_handling: ['scaling_discussion'],
      behavioral_story: ['wrap_up'],
      wrap_up: ['behavioral_story'],
    };

    return relatedGroups[a]?.includes(b) || relatedGroups[b]?.includes(a);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private estimateTokens(text: string): number {
    return this.tokenCounter.count(text, this.modelHint);
  }

  private selectContextLegacy(candidates: ContextEntry[], tokenBudget: number): ContextEntry[] {
    const sorted = [...candidates].sort((a, b) => b.timestamp - a.timestamp);

    const selected: ContextEntry[] = [];
    let usedTokens = 0;

    for (const entry of sorted) {
      const tokens = this.estimateTokens(entry.text);
      if (usedTokens + tokens <= tokenBudget) {
        selected.push(entry);
        usedTokens += tokens;
      }
    }

    return selected;
  }
}
