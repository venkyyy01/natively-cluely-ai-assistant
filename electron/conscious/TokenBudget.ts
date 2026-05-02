// electron/conscious/TokenBudget.ts

import { TokenCounter } from "../shared/TokenCounter";
import type {
	BucketAllocation,
	LLMProvider,
	TokenBudget,
	TokenBudgetAllocations,
} from "./types";

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
	activeThread: { min: 0.2, max: 0.35 },
	recentTranscript: { min: 0.15, max: 0.3 },
	suspendedThreads: { min: 0.05, max: 0.2 },
	epochSummaries: { min: 0.05, max: 0.2 },
	entities: { min: 0.03, max: 0.15 },
	reserve: { min: 0.05, max: 0.15 },
};

type BucketName = keyof TokenBudgetAllocations;

export class TokenBudgetManager {
	private budget: TokenBudget;
	private tokenCounter: TokenCounter;
	private deepMode = false;

	constructor(provider: LLMProvider = "openai") {
		const totalBudget = PROVIDER_BUDGETS[provider];
		this.tokenCounter = new TokenCounter(provider);
		this.budget = {
			provider,
			totalBudget,
			allocations: this.initializeAllocations(totalBudget),
		};
	}

	private initializeAllocations(total: number): TokenBudgetAllocations {
		const allocations: TokenBudgetAllocations = {} as TokenBudgetAllocations;

		for (const [bucket, percentages] of Object.entries(
			DEFAULT_ALLOCATION_PERCENTAGES,
		)) {
			allocations[bucket as BucketName] = {
				min: Math.floor(total * percentages.min),
				max: Math.floor(total * percentages.max),
				current: 0,
			};
		}

		return allocations;
	}

	getTotalBudget(): number {
		if (this.deepMode) return Infinity;
		return this.budget.totalBudget;
	}

	getProvider(): LLMProvider {
		return this.budget.provider;
	}

	getAllocations(): TokenBudgetAllocations {
		return { ...this.budget.allocations };
	}

	canAdd(bucket: BucketName, tokens: number): boolean {
		if (this.deepMode) return true;
		const allocation = this.budget.allocations[bucket];
		return allocation.current + tokens <= allocation.max;
	}

	allocate(bucket: BucketName, tokens: number): boolean {
		if (
			!this.canAdd(bucket, tokens - this.budget.allocations[bucket].current)
		) {
			return false;
		}
		this.budget.allocations[bucket].current = tokens;
		return true;
	}

	getCurrentUsage(): number {
		return Object.values(this.budget.allocations).reduce(
			(sum, alloc) => sum + alloc.current,
			0,
		);
	}

	getAvailableSpace(): number {
		if (this.deepMode) return Infinity;
		return this.budget.totalBudget - this.getCurrentUsage();
	}

	rebalance(): void {
		if (this.deepMode) return;
		const allocations = this.budget.allocations;
		const total = this.budget.totalBudget;

		// Find underutilized buckets
		const underutilized: BucketName[] = [];
		let reclaimable = 0;

		for (const [bucket, alloc] of Object.entries(allocations) as [
			BucketName,
			BucketAllocation,
		][]) {
			if (alloc.current < alloc.min * 0.5) {
				underutilized.push(bucket);
				reclaimable += alloc.max - alloc.current;
			}
		}

		if (reclaimable === 0) return;

		// Distribute reclaimed space to active buckets proportionally
		const activeBuckets = Object.entries(allocations).filter(
			([bucket]) => !underutilized.includes(bucket as BucketName),
		) as [BucketName, BucketAllocation][];

		const perBucketBonus = Math.floor(
			reclaimable / Math.max(activeBuckets.length, 1),
		);

		for (const [bucket, alloc] of activeBuckets) {
			allocations[bucket].max = Math.min(
				alloc.max + perBucketBonus,
				total * 0.5, // Cap at 50% of total
			);
		}
	}

	estimateTokens(text: string): number {
		return this.tokenCounter.count(text, this.budget.provider);
	}

	estimateCodeTokens(code: string): number {
		return this.tokenCounter.count(code, `${this.budget.provider}:code`);
	}

	reset(): void {
		for (const bucket of Object.keys(this.budget.allocations) as BucketName[]) {
			this.budget.allocations[bucket].current = 0;
		}
	}

	setProvider(provider: LLMProvider): void {
		const totalBudget = PROVIDER_BUDGETS[provider];
		this.tokenCounter = new TokenCounter(provider);
		this.budget = {
			provider,
			totalBudget,
			allocations: this.initializeAllocations(totalBudget),
		};
	}

	setDeepMode(enabled: boolean): void {
		this.deepMode = enabled;
	}

	isDeepModeActive(): boolean {
		return this.deepMode;
	}
}
