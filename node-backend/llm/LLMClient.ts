// node-backend/llm/LLMClient.ts

/**
 * LLMClient - Unified client for LLM API calls.
 *
 * Features:
 * - OpenAI/Anthropic/compatible API support
 * - Uses PromptCompiler before sending
 * - Uses StreamManager for responses
 * - Uses EnhancedCache for caching
 * - Designed for OpenAI-compatible APIs (portability)
 */

import {
  PromptCompiler,
  promptCompiler,
  type Message,
  type CompileOptions,
} from './PromptCompiler.js';
import {
  StreamManager,
  streamManager,
  type StreamChunk,
  type StreamRequest,
} from './StreamManager.js';
import {
  EnhancedCache,
  generateCacheKey,
  responseCache,
  type CacheResult,
} from '../cache/EnhancedCache.js';

export interface GenerateRequest {
  /** Messages to send */
  messages: Message[];
  /** Model to use (e.g., 'gpt-4o', 'claude-3-opus-20240229') */
  model?: string;
  /** Provider (openai, anthropic, generic) */
  provider?: 'openai' | 'anthropic' | 'generic';
  /** API key (if not using default) */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens for response */
  maxTokens?: number;
  /** Enable caching */
  useCache?: boolean;
  /** Enable prompt compilation */
  useCompiler?: boolean;
  /** Prompt compiler options */
  compilerOptions?: CompileOptions;
  /** Embedding for semantic cache (optional) */
  embedding?: number[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface GenerateOptions {
  /** Default model */
  defaultModel?: string;
  /** Default provider */
  defaultProvider?: 'openai' | 'anthropic' | 'generic';
  /** API keys by provider */
  apiKeys?: Record<string, string>;
  /** Base URLs by provider */
  baseUrls?: Record<string, string>;
  /** Enable caching by default */
  enableCache?: boolean;
  /** Enable prompt compilation by default */
  enableCompiler?: boolean;
}

export interface GenerateResult {
  /** The generated response */
  response: string;
  /** Whether this was a cache hit */
  cached: boolean;
  /** Estimated tokens used */
  tokensUsed: number;
  /** Compression ratio if compiled */
  compressionRatio?: number;
  /** Time to first token (ms) */
  timeToFirstToken?: number;
  /** Total latency (ms) */
  latencyMs: number;
}

export class LLMClient {
  private compiler: PromptCompiler;
  private streamer: StreamManager;
  private cache: EnhancedCache<string, string>;
  private options: Required<GenerateOptions>;

  // Stats
  private stats = {
    totalRequests: 0,
    cacheHits: 0,
    totalTokensSaved: 0,
    totalLatencyMs: 0,
  };

  constructor(options?: GenerateOptions) {
    this.compiler = promptCompiler;
    this.streamer = streamManager;
    this.cache = responseCache;

    this.options = {
      defaultModel: options?.defaultModel || 'gpt-4o',
      defaultProvider: options?.defaultProvider || 'openai',
      apiKeys: options?.apiKeys || {},
      baseUrls: options?.baseUrls || {},
      enableCache: options?.enableCache ?? true,
      enableCompiler: options?.enableCompiler ?? true,
    };
  }

  /**
   * Generate a response (streaming).
   * Returns an async iterable that yields tokens.
   */
  async *generate(request: GenerateRequest): AsyncIterable<string> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    const model = request.model || this.options.defaultModel;
    const provider = request.provider || this.options.defaultProvider;
    const useCache = request.useCache ?? this.options.enableCache;
    const useCompiler = request.useCompiler ?? this.options.enableCompiler;

    // Check cache first
    if (useCache) {
      const cacheKey = generateCacheKey(request.messages, model);
      const cached = this.cache.get(cacheKey, request.embedding);

      if (cached) {
        this.stats.cacheHits++;
        // Yield cached response all at once (simulated streaming)
        yield cached.value;
        return;
      }
    }

    // Compile prompt if enabled
    let messages = request.messages;
    let compressionRatio = 0;

    if (useCompiler) {
      const compiled = this.compiler.compile(messages, request.compilerOptions);
      messages = compiled.messages as Message[];
      compressionRatio = compiled.compressionRatio;
      this.stats.totalTokensSaved += Math.floor(
        compiled.estimatedTokens * compressionRatio
      );
    }

    // Get API key
    const apiKey =
      request.apiKey ||
      this.options.apiKeys[provider] ||
      process.env[`${provider.toUpperCase()}_API_KEY`] ||
      '';

    if (!apiKey) {
      throw new Error(`No API key configured for provider: ${provider}`);
    }

    // Get base URL
    const baseUrl = request.baseUrl || this.options.baseUrls[provider];

    // Create stream request
    const streamRequest: StreamRequest = {
      id: `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      provider,
      model,
      messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      apiKey,
      baseUrl,
      signal: request.signal,
    };

    // Stream response
    let fullResponse = '';
    let firstTokenTime: number | null = null;

    for await (const chunk of this.streamer.stream(streamRequest)) {
      if (chunk.type === 'token' && chunk.text) {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now() - startTime;
        }
        fullResponse += chunk.text;
        yield chunk.text;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error);
      }
    }

    // Cache the response
    if (useCache && fullResponse) {
      const cacheKey = generateCacheKey(request.messages, model);
      this.cache.set(cacheKey, fullResponse, request.embedding);
    }

    this.stats.totalLatencyMs += Date.now() - startTime;
  }

  /**
   * Generate a response (non-streaming).
   * Returns the complete response.
   */
  async generateComplete(request: GenerateRequest): Promise<GenerateResult> {
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    let response = '';

    for await (const token of this.generate(request)) {
      if (firstTokenTime === null) {
        firstTokenTime = Date.now() - startTime;
      }
      response += token;
    }

    // Check if this was a cache hit
    const cacheKey = generateCacheKey(
      request.messages,
      request.model || this.options.defaultModel
    );
    const wasCached = this.cache.has(cacheKey);

    // Estimate tokens
    const tokensUsed = this.compiler.estimateTokens(response);

    // Get compression ratio
    let compressionRatio: number | undefined;
    if (request.useCompiler ?? this.options.enableCompiler) {
      const compiled = this.compiler.compile(
        request.messages,
        request.compilerOptions
      );
      compressionRatio = compiled.compressionRatio;
    }

    return {
      response,
      cached: wasCached,
      tokensUsed,
      compressionRatio,
      timeToFirstToken: firstTokenTime || undefined,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Generate with multiple providers/models in parallel.
   * Returns the first successful response.
   */
  async generateRace(
    requests: GenerateRequest[]
  ): Promise<{ response: string; provider: string; model: string }> {
    const streamRequests: StreamRequest[] = requests.map((req, i) => {
      const provider = req.provider || this.options.defaultProvider;
      const model = req.model || this.options.defaultModel;
      const apiKey =
        req.apiKey ||
        this.options.apiKeys[provider] ||
        process.env[`${provider.toUpperCase()}_API_KEY`] ||
        '';

      // Compile if enabled
      let messages = req.messages;
      if (req.useCompiler ?? this.options.enableCompiler) {
        const compiled = this.compiler.compile(messages, req.compilerOptions);
        messages = compiled.messages as Message[];
      }

      return {
        id: `race-${i}-${Date.now()}`,
        provider,
        model,
        messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        apiKey,
        baseUrl: req.baseUrl || this.options.baseUrls[provider],
        signal: req.signal,
      };
    });

    const result = await this.streamer.streamFirstWins(streamRequests);

    // Find the original request to get provider/model
    const winningRequest = streamRequests.find((r) => r.id === result.requestId);

    return {
      response: result.response,
      provider: winningRequest?.provider || 'unknown',
      model: winningRequest?.model || 'unknown',
    };
  }

  /**
   * Set API key for a provider.
   */
  setApiKey(provider: string, apiKey: string): void {
    this.options.apiKeys[provider] = apiKey;
  }

  /**
   * Set base URL for a provider.
   */
  setBaseUrl(provider: string, baseUrl: string): void {
    this.options.baseUrls[provider] = baseUrl;
  }

  /**
   * Clear the response cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Get client statistics.
   */
  getStats() {
    const cacheStats = this.cache.getStats();
    return {
      ...this.stats,
      cacheHitRate: cacheStats.hitRate,
      cacheSize: cacheStats.size,
      averageLatencyMs:
        this.stats.totalRequests > 0
          ? this.stats.totalLatencyMs / this.stats.totalRequests
          : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      totalTokensSaved: 0,
      totalLatencyMs: 0,
    };
  }
}

// Singleton instance
export const llmClient = new LLMClient();
