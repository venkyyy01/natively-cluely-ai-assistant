import { CORE_IDENTITY, STRICT_BEHAVIOR_RULES, PHASE_GUIDANCE, PROVIDER_ADAPTERS } from './promptComponents';
import { InterviewPhase } from '../conscious/types';
import { isOptimizationActive } from '../config/optimizations';
import {
  HARD_SYSTEM_PROMPT,
  GROQ_SYSTEM_PROMPT,
  OPENAI_SYSTEM_PROMPT,
  CLAUDE_SYSTEM_PROMPT,
  UNIVERSAL_SYSTEM_PROMPT,
  CUSTOM_SYSTEM_PROMPT,
  CONSCIOUS_MODE_PHASE_PROMPTS,
  THOUGHTFLOW_CODING_PROMPT,
  isCodingQuestion,
} from './prompts';

export interface CompileOptions {
  provider: string;
  phase: InterviewPhase;
  mode: 'conscious' | 'standard';
  userQuestion?: string;
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

    // Route coding prompts to ThoughtFlow when optimization mode is enabled.
    // Keep behavior consistent with compileLegacy().
    if (options.mode === 'conscious' && options.userQuestion && isCodingQuestion(options.userQuestion)) {
      return {
        systemPrompt: THOUGHTFLOW_CODING_PROMPT,
        responseFormat: 'json',
        estimatedTokens: this.estimateTokens(THOUGHTFLOW_CODING_PROMPT),
      };
    }

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
      finalPrompt += `\n\n<recent_topics>${options.contextSnapshot.recentTopics.join(',')}</recent_topics>`;
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
  "mode": "reasoning_first",
  "openingReasoning": "1-3 concise setup sentences",
  "implementationPlan": ["Step 1", "Step 2"],
  "tradeoffs": ["Tradeoff 1", "Tradeoff 2"],
  "edgeCases": ["Edge case 1", "Edge case 2"],
  "scaleConsiderations": ["Scale note 1"],
  "pushbackResponses": ["If interviewer pushes back, say..."],
  "likelyFollowUps": ["Likely follow-up question"],
  "codeTransition": "If code is requested, bridge naturally with one sentence"
}
DO NOT include any other text outside the JSON.
</conscious_mode_contract>
`;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private compileLegacy(options: CompileOptions): CompiledPrompt {
    const basePrompt = PROVIDER_PROMPT_MAP[options.provider] || HARD_SYSTEM_PROMPT;
    
    if (options.mode === 'conscious') {
      // Route coding questions to ThoughtFlow prompt
      if (options.userQuestion && isCodingQuestion(options.userQuestion)) {
        return {
          systemPrompt: THOUGHTFLOW_CODING_PROMPT,
          responseFormat: 'json',
          estimatedTokens: this.estimateTokens(THOUGHTFLOW_CODING_PROMPT),
        };
      }
      
      const consciousPrompt = CONSCIOUS_MODE_PHASE_PROMPTS[options.phase];
      if (consciousPrompt) {
        return {
          systemPrompt: consciousPrompt,
          responseFormat: 'json',
          estimatedTokens: this.estimateTokens(consciousPrompt),
        };
      }
    }

    return {
      systemPrompt: basePrompt,
      responseFormat: 'markdown',
      estimatedTokens: this.estimateTokens(basePrompt),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
