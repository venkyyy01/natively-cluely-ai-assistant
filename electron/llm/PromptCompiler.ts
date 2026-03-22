import { CORE_IDENTITY, STRICT_BEHAVIOR_RULES, PHASE_GUIDANCE, PROVIDER_ADAPTERS } from './promptComponents';
import { InterviewPhase } from '../conscious/types';
import { isOptimizationActive } from '../config/optimizations';

export interface CompileOptions {
  provider: string;
  phase: InterviewPhase;
  mode: 'conscious' | 'standard';
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

export class PromptCompiler {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  async compile(options: CompileOptions): Promise<CompiledPrompt> {
    if (!isOptimizationActive('usePromptCompiler')) {
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
    return `${options.provider}:${options.phase}:${options.mode}`;
  }

  private async assemble(options: CompileOptions): Promise<CompiledPrompt> {
    const adapter = PROVIDER_ADAPTERS[options.provider] || PROVIDER_ADAPTERS.custom;
    const phaseGuidance = PHASE_GUIDANCE[options.phase] || '';

    const components = [
      CORE_IDENTITY,
      STRICT_BEHAVIOR_RULES,
      phaseGuidance,
    ];

    if (options.mode === 'conscious') {
      components.push(this.getConsciousModeContract());
    }

    const basePrompt = components.filter(Boolean).join('\n\n');

    let finalPrompt = basePrompt;
    if (options.contextSnapshot?.activeThread) {
      finalPrompt += `\n\n<active_thread>${options.contextSnapshot.activeThread}</active_thread>`;
    }
    if (options.contextSnapshot?.recentTopics?.length) {
      finalPrompt += `\n\n<recent_topics>${options.contextSnapshot.recentTopics.join(', ')}</recent_topics>`;
    }

    const systemPrompt = adapter.systemPromptWrapper(finalPrompt);
    const estimatedTokens = this.estimateTokens(systemPrompt) * adapter.tokenBudgetMultiplier;

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

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async compileLegacy(options: CompileOptions): Promise<CompiledPrompt> {
    return {
      systemPrompt: 'Legacy prompt compilation - using existing prompts.ts',
      responseFormat: 'markdown',
      estimatedTokens: 4000,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
