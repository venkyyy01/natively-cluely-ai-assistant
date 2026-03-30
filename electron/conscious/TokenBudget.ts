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
