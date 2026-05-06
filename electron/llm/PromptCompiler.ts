import { isOptimizationActive } from "../config/optimizations";
import type { InterviewPhase } from "../conscious/types";
import { TokenCounter } from "../shared/TokenCounter";
import {
	CORE_IDENTITY,
	PHASE_GUIDANCE,
	PROVIDER_ADAPTERS,
	STRICT_BEHAVIOR_RULES,
} from "./promptComponents";
import {
	CLAUDE_SYSTEM_PROMPT,
	CONSCIOUS_MODE_PHASE_PROMPTS,
	CUSTOM_SYSTEM_PROMPT,
	GROQ_SYSTEM_PROMPT,
	HARD_SYSTEM_PROMPT,
	OPENAI_SYSTEM_PROMPT,
	UNIVERSAL_SYSTEM_PROMPT,
} from "./prompts";

export interface CompileOptions {
	provider: string;
	phase: InterviewPhase;
	mode: "conscious" | "standard";
	contextSnapshot?: {
		recentTopics: string[];
		activeThread?: string;
	};
}

export interface CompiledPrompt {
	systemPrompt: string;
	responseFormat: string;
	estimatedTokens: number;
}

interface CacheEntry {
	prompt: CompiledPrompt;
	createdAt: number;
}

const PROVIDER_PROMPT_MAP: Record<string, string> = {
	groq: GROQ_SYSTEM_PROMPT,
	openai: OPENAI_SYSTEM_PROMPT,
	claude: CLAUDE_SYSTEM_PROMPT,
	gemini: HARD_SYSTEM_PROMPT,
	ollama: UNIVERSAL_SYSTEM_PROMPT,
	custom: CUSTOM_SYSTEM_PROMPT,
};

export class PromptCompiler {
	private cache: Map<string, CacheEntry> = new Map();
	private readonly CACHE_TTL_MS = 5 * 60 * 1000;
	private readonly tokenCounter = new TokenCounter();

	async compile(options: CompileOptions): Promise<CompiledPrompt> {
		if (!isOptimizationActive("usePromptCompiler")) {
			return this.compileLegacy(options);
		}

		const cacheKey = this.getCacheKey(options);

		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.createdAt < this.CACHE_TTL_MS) {
			return cached.prompt;
		}

		const compiled = await this.assemble(options);
		this.cache.set(cacheKey, { prompt: compiled, createdAt: Date.now() });

		return compiled;
	}

	private getCacheKey(options: CompileOptions): string {
		const contextHash = options.contextSnapshot
			? this.hashContext(options.contextSnapshot)
			: "no-context";
		return `${options.provider}:${options.phase}:${options.mode}:${contextHash}`;
	}

	private hashContext(
		snapshot: NonNullable<CompileOptions["contextSnapshot"]>,
	): string {
		const thread = snapshot.activeThread || "";
		const topics = snapshot.recentTopics?.join(",") || "";
		let hash = 0;
		const str = `${thread}::${topics}`;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash |= 0;
		}
		return hash.toString(36);
	}

	private async assemble(options: CompileOptions): Promise<CompiledPrompt> {
		const adapter =
			PROVIDER_ADAPTERS[options.provider] || PROVIDER_ADAPTERS.custom;
		const phaseGuidance = PHASE_GUIDANCE[options.phase] || "";

		const components = [CORE_IDENTITY, STRICT_BEHAVIOR_RULES, phaseGuidance];

		if (options.mode === "conscious") {
			components.push(this.getConsciousModeContract());
		}

		const basePrompt = components.filter(Boolean).join("\n\n");

		let finalPrompt = basePrompt;
		if (options.contextSnapshot?.activeThread) {
			finalPrompt += `\n\n<active_thread>${options.contextSnapshot.activeThread}</active_thread>`;
		}
		if (options.contextSnapshot?.recentTopics?.length) {
			finalPrompt += `\n\n<recent_topics>${options.contextSnapshot.recentTopics.join(",")}</recent_topics>`;
		}

		const systemPrompt = adapter.systemPromptWrapper(finalPrompt);
		const estimatedTokens =
			this.estimateTokens(systemPrompt, options.provider) *
			adapter.tokenBudgetMultiplier;

		return {
			systemPrompt,
			responseFormat: adapter.responseFormatHints,
			estimatedTokens: Math.round(estimatedTokens),
		};
	}

	private getConsciousModeContract(): string {
		return `
<conscious_mode_contract>
When in conscious mode, respond with valid JSON in this exact format:
{
  "reasoning": "Your internal reasoning (not shown to user)",
  "answer": "What the user should say (plain text)",
  "confidence": 0.95,
  "suggestedFollowUps": ["Question 1", "Question 2"],
  "relevantContext": ["Context snippet 1", "Context snippet 2"]
}
DO NOT include any other text outside the JSON.
</conscious_mode_contract>
`;
	}

	private estimateTokens(text: string, modelHint: string): number {
		return this.tokenCounter.count(text, modelHint);
	}

	private compileLegacy(options: CompileOptions): CompiledPrompt {
		const basePrompt =
			PROVIDER_PROMPT_MAP[options.provider] || HARD_SYSTEM_PROMPT;

		if (options.mode === "conscious") {
			const consciousPrompt = CONSCIOUS_MODE_PHASE_PROMPTS[options.phase];
			if (consciousPrompt) {
				return {
					systemPrompt: consciousPrompt,
					responseFormat: "json",
					estimatedTokens: this.estimateTokens(
						consciousPrompt,
						options.provider,
					),
				};
			}
		}

		return {
			systemPrompt: basePrompt,
			responseFormat: "markdown",
			estimatedTokens: this.estimateTokens(basePrompt, options.provider),
		};
	}

	clearCache(): void {
		this.cache.clear();
	}
}
