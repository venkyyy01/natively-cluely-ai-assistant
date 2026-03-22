// node-backend/rpc-handlers.ts

import { settings } from './settings.js';
import { llmClient } from './llm/LLMClient.js';
import { responseCache, embeddingCache } from './cache/EnhancedCache.js';
import { ParallelContextAssembler } from './context/ParallelContextAssembler.js';
import { PredictivePrefetcher } from './prefetch/PredictivePrefetcher.js';
import type { GenerateRequest } from './llm/LLMClient.js';
import type { ContextSource, AssembledContext } from './context/ParallelContextAssembler.js';
import type { PrefetchContext } from './prefetch/PredictivePrefetcher.js';

// Create singleton instances
const parallelContextAssembler = new ParallelContextAssembler();
const predictivePrefetcher = new PredictivePrefetcher();

interface JsonRpcServer {
  sendNotification(method: string, params: Record<string, unknown>): void;
}

export class RpcHandlers {
  private server: JsonRpcServer;

  constructor(server: JsonRpcServer) {
    this.server = server;

    // Configure LLM client from settings
    this.configureLLMClient();
  }

  private configureLLMClient(): void {
    const apiKeys = settings.get('apiKeys') || {};
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (key) {
        llmClient.setApiKey(provider, key as string);
      }
    }
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Convert method names like "settings:get" to "settings_get"
    const handlerName = method.replace(/[:.]/g, '_');
    const handler = (this as Record<string, unknown>)[handlerName];

    if (typeof handler === 'function') {
      return handler.call(this, params);
    }

    throw new Error(`Unknown method: ${method}`);
  }

  // MARK: - Ping/Pong

  async ping(_params: Record<string, unknown>): Promise<string> {
    return 'pong';
  }

  // MARK: - Settings

  async settings_get(params: { key: string }): Promise<unknown> {
    return settings.get(params.key as 'isUndetectable' | 'disguiseMode' | 'overlayBounds' | 'selectedModel' | 'apiKeys' | 'featureFlags');
  }

  async settings_set(params: { key: string; value: unknown }): Promise<boolean> {
    settings.set(
      params.key as 'isUndetectable' | 'disguiseMode' | 'overlayBounds' | 'selectedModel' | 'apiKeys' | 'featureFlags',
      params.value as never
    );

    // Reconfigure LLM client if API keys changed
    if (params.key === 'apiKeys') {
      this.configureLLMClient();
    }

    return true;
  }

  async settings_getAll(_params: Record<string, unknown>): Promise<unknown> {
    return settings.getAll();
  }

  // MARK: - App State

  async app_getState(_params: Record<string, unknown>): Promise<unknown> {
    return {
      isUndetectable: settings.get('isUndetectable'),
      disguiseMode: settings.get('disguiseMode'),
      selectedModel: settings.get('selectedModel'),
    };
  }

  async app_setUndetectable(params: { enabled: boolean }): Promise<boolean> {
    settings.set('isUndetectable', params.enabled);
    this.server.sendNotification('app:stateChanged', {
      isUndetectable: params.enabled,
    });
    return true;
  }

  // MARK: - LLM

  async llm_generate(params: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    model?: string;
    provider?: 'openai' | 'anthropic' | 'generic';
    temperature?: number;
    maxTokens?: number;
    useCache?: boolean;
    useCompiler?: boolean;
    stream?: boolean;
  }): Promise<unknown> {
    const featureFlags = settings.get('featureFlags') || {};

    const request: GenerateRequest = {
      messages: params.messages,
      model: params.model || settings.get('selectedModel') || 'gpt-4o',
      provider: params.provider || 'openai',
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      useCache: params.useCache ?? featureFlags.useEnhancedCache ?? true,
      useCompiler: params.useCompiler ?? featureFlags.usePromptCompiler ?? true,
    };

    // Stream mode: send tokens via notifications
    if (params.stream !== false) {
      let fullResponse = '';
      let tokenCount = 0;

      for await (const token of llmClient.generate(request)) {
        fullResponse += token;
        tokenCount++;
        this.server.sendNotification('llm:token', { 
          text: token,
          tokenIndex: tokenCount,
        });
      }

      return {
        response: fullResponse,
        tokenCount,
        cached: llmClient.getCacheStats().hitRate > 0,
      };
    }

    // Non-stream mode: return complete response
    const result = await llmClient.generateComplete(request);
    return {
      response: result.response,
      cached: result.cached,
      tokensUsed: result.tokensUsed,
      compressionRatio: result.compressionRatio,
      latencyMs: result.latencyMs,
      timeToFirstToken: result.timeToFirstToken,
    };
  }

  async llm_generateComplete(params: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    model?: string;
    provider?: 'openai' | 'anthropic' | 'generic';
    temperature?: number;
    maxTokens?: number;
  }): Promise<unknown> {
    return this.llm_generate({ ...params, stream: false });
  }

  async llm_clearCache(_params: Record<string, unknown>): Promise<boolean> {
    llmClient.clearCache();
    return true;
  }

  async llm_getStats(_params: Record<string, unknown>): Promise<unknown> {
    return llmClient.getStats();
  }

  // MARK: - Cache

  async cache_getStats(_params: Record<string, unknown>): Promise<unknown> {
    return {
      response: responseCache.getStats(),
      embedding: embeddingCache.getStats(),
      llm: llmClient.getCacheStats(),
    };
  }

  async cache_clear(params: { type?: 'response' | 'embedding' | 'all' }): Promise<boolean> {
    const type = params.type || 'all';

    if (type === 'response' || type === 'all') {
      responseCache.clear();
    }
    if (type === 'embedding' || type === 'all') {
      embeddingCache.clear();
    }
    if (type === 'all') {
      llmClient.clearCache();
    }

    return true;
  }

  async cache_resetStats(_params: Record<string, unknown>): Promise<boolean> {
    responseCache.resetStats();
    embeddingCache.resetStats();
    llmClient.resetStats();
    return true;
  }

  // MARK: - Embedding

  async embedding_generate(params: { text: string }): Promise<unknown> {
    // Check embedding cache first
    const cached = embeddingCache.get(params.text);
    if (cached) {
      return { 
        embedding: cached.value, 
        latencyMs: 0,
        cached: true,
      };
    }

    // This would be delegated to Swift/ANE in production
    // For now, return a placeholder
    const startTime = Date.now();

    // Placeholder: In production, this would call Swift via IPC
    // await ipcBridge.call('embedding:generate', { text: params.text })
    const embedding: number[] = [];

    const latencyMs = Date.now() - startTime;

    // Cache the result
    embeddingCache.set(params.text, embedding);

    return { 
      embedding, 
      latencyMs,
      cached: false,
    };
  }

  // MARK: - Context Assembly

  async context_assemble(params: {
    sources: Array<{
      type: 'transcript' | 'knowledge' | 'conversation' | 'system';
      priority: number;
      data?: unknown;
    }>;
    budget: number;
    query?: string;
  }): Promise<unknown> {
    const sources: ContextSource[] = params.sources.map(source => ({
      type: source.type,
      priority: source.priority,
      maxChunks: 10,
      fetch: async () => {
        // Mock implementation - in production, this would fetch real data
        return [{
          id: `mock-${source.type}-1`,
          content: `Mock content for ${source.type}`,
          type: source.type,
          timestamp: Date.now(),
          tokenCount: 50,
        }];
      },
    }));

    const query = params.query || 'default query';
    const assembled = await parallelContextAssembler.assemble(sources, params.budget, query);
    return assembled;
  }

  // MARK: - Predictive Prefetching

  async prefetch_predict(params: PrefetchContext): Promise<unknown> {
    const questions = predictivePrefetcher.predictNextQuestions(params);
    return { questions };
  }

  async prefetch_warm(params: {
    questions: string[];
    context?: PrefetchContext;
  }): Promise<unknown> {
    const startTime = Date.now();
    await predictivePrefetcher.prefetchResponses(params.questions);
    const latencyMs = Date.now() - startTime;
    
    return { 
      warmed: params.questions.length,
      latencyMs,
    };
  }

  async prefetch_getStats(_params: Record<string, unknown>): Promise<unknown> {
    return {
      cache: predictivePrefetcher.getCacheStats(),
      predictions: {
        totalPredictions: 0, // Would track in production
        successfulPrefetches: 0,
        cacheHits: 0,
      },
    };
  }
}
