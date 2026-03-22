// node-backend/llm/StreamManager.ts

/**
 * StreamManager - Handles streaming responses from LLM providers.
 *
 * Features:
 * - Parallel streaming support (multiple providers)
 * - First-token latency optimization
 * - Stream merging and buffering
 * - Error handling and fallback
 * - Partial JSON parsing during stream
 */

export interface StreamRequest {
  /** Unique identifier for this stream */
  id: string;
  /** Provider name (openai, anthropic, etc.) */
  provider: string;
  /** Model identifier */
  model: string;
  /** Messages to send */
  messages: Array<{ role: string; content: string }>;
  /** Optional temperature */
  temperature?: number;
  /** Optional max tokens */
  maxTokens?: number;
  /** API key for the provider */
  apiKey: string;
  /** Base URL override (for proxies or compatible APIs) */
  baseUrl?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface StreamChunk {
  /** The stream request ID this chunk belongs to */
  requestId: string;
  /** Chunk type */
  type: 'token' | 'error' | 'complete';
  /** Text content (for token type) */
  text?: string;
  /** Error message (for error type) */
  error?: string;
  /** Full response (for complete type) */
  response?: string;
  /** Timestamp of this chunk */
  timestamp: number;
  /** Time since first token (ms) */
  latencyMs?: number;
}

export interface StreamConfig {
  /** Callback for each token */
  onToken?: (token: string, requestId: string) => void;
  /** Callback for errors */
  onError?: (error: Error, requestId: string) => void;
  /** Callback when stream completes */
  onComplete?: (response: string, requestId: string) => void;
  /** Buffer size before flushing (for batching) */
  bufferSize?: number;
  /** Buffer timeout in ms */
  bufferTimeout?: number;
}

interface ProviderStreamFn {
  (request: StreamRequest): AsyncIterable<string>;
}

export class StreamManager {
  private providers: Map<string, ProviderStreamFn> = new Map();
  private activeStreams: Map<string, AbortController> = new Map();

  constructor() {
    // Register default providers
    this.registerProvider('openai', this.streamOpenAI.bind(this));
    this.registerProvider('anthropic', this.streamAnthropic.bind(this));
    this.registerProvider('generic', this.streamGenericOpenAI.bind(this));
  }

  /**
   * Register a custom provider streaming function.
   */
  registerProvider(name: string, streamFn: ProviderStreamFn): void {
    this.providers.set(name, streamFn);
  }

  /**
   * Stream a single request.
   */
  async *stream(request: StreamRequest): AsyncIterable<StreamChunk> {
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    let fullResponse = '';

    // Create abort controller if not provided
    const controller = new AbortController();
    if (request.signal) {
      request.signal.addEventListener('abort', () => controller.abort());
    }
    this.activeStreams.set(request.id, controller);

    try {
      const providerFn =
        this.providers.get(request.provider) || this.providers.get('generic');

      if (!providerFn) {
        throw new Error(`Unknown provider: ${request.provider}`);
      }

      const stream = providerFn({
        ...request,
        signal: controller.signal,
      });

      for await (const token of stream) {
        if (controller.signal.aborted) {
          break;
        }

        const now = Date.now();
        if (firstTokenTime === null) {
          firstTokenTime = now;
        }

        fullResponse += token;

        yield {
          requestId: request.id,
          type: 'token',
          text: token,
          timestamp: now,
          latencyMs: now - startTime,
        };
      }

      yield {
        requestId: request.id,
        type: 'complete',
        response: fullResponse,
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      yield {
        requestId: request.id,
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime,
      };
    } finally {
      this.activeStreams.delete(request.id);
    }
  }

  /**
   * Stream multiple requests in parallel, yielding chunks as they arrive.
   * Useful for racing multiple providers or models.
   */
  async *streamParallel(requests: StreamRequest[]): AsyncIterable<StreamChunk> {
    const streams = requests.map((req) => this.stream(req));
    const iterators = streams.map((s) => s[Symbol.asyncIterator]());

    // Track which iterators are still active
    const active = new Set(iterators.map((_, i) => i));
    const pending = new Map<
      number,
      Promise<{ index: number; result: IteratorResult<StreamChunk> }>
    >();

    // Initialize pending promises
    for (const [index, iterator] of iterators.entries()) {
      pending.set(
        index,
        iterator.next().then((result) => ({ index, result }))
      );
    }

    while (active.size > 0) {
      // Wait for any stream to produce a chunk
      const promises = Array.from(pending.values());
      const { index, result } = await Promise.race(promises);

      if (result.done) {
        active.delete(index);
        pending.delete(index);
      } else {
        yield result.value;

        // Queue next chunk from this iterator
        if (active.has(index)) {
          const iterator = iterators[index];
          pending.set(
            index,
            iterator.next().then((r) => ({ index, result: r }))
          );
        }
      }
    }
  }

  /**
   * Stream with first-wins semantics.
   * Starts multiple requests and returns the first successful completion.
   */
  async streamFirstWins(
    requests: StreamRequest[],
    config?: StreamConfig
  ): Promise<{
    requestId: string;
    response: string;
    latencyMs: number;
  }> {
    return new Promise((resolve, reject) => {
      const controllers: AbortController[] = [];
      const completions: Map<
        string,
        { response: string; latencyMs: number }
      > = new Map();
      let resolved = false;

      const cleanup = () => {
        for (const ctrl of controllers) {
          try {
            ctrl.abort();
          } catch {
            // Ignore abort errors
          }
        }
      };

      const processStream = async (request: StreamRequest) => {
        const controller = new AbortController();
        controllers.push(controller);

        let response = '';

        try {
          for await (const chunk of this.stream({
            ...request,
            signal: controller.signal,
          })) {
            if (resolved) return;

            if (chunk.type === 'token' && chunk.text) {
              response += chunk.text;
              config?.onToken?.(chunk.text, request.id);
            } else if (chunk.type === 'complete') {
              completions.set(request.id, {
                response: chunk.response || response,
                latencyMs: chunk.latencyMs || 0,
              });

              if (!resolved) {
                resolved = true;
                cleanup();
                config?.onComplete?.(chunk.response || response, request.id);
                resolve({
                  requestId: request.id,
                  response: chunk.response || response,
                  latencyMs: chunk.latencyMs || 0,
                });
              }
            } else if (chunk.type === 'error') {
              config?.onError?.(new Error(chunk.error), request.id);
            }
          }
        } catch (error) {
          if (!resolved) {
            config?.onError?.(
              error instanceof Error ? error : new Error(String(error)),
              request.id
            );
          }
        }
      };

      // Start all streams in parallel
      Promise.allSettled(requests.map(processStream)).then((results) => {
        if (!resolved) {
          // All streams failed
          const errors = results
            .filter((r) => r.status === 'rejected')
            .map((r) => (r as PromiseRejectedResult).reason);

          reject(
            new Error(
              `All streams failed: ${errors.map((e) => e.message).join(', ')}`
            )
          );
        }
      });
    });
  }

  /**
   * Cancel an active stream.
   */
  cancelStream(requestId: string): boolean {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
      return true;
    }
    return false;
  }

  /**
   * Cancel all active streams.
   */
  cancelAll(): void {
    for (const [id, controller] of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();
  }

  /**
   * Get count of active streams.
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  // Provider implementations

  /**
   * Stream from OpenAI-compatible API.
   */
  private async *streamOpenAI(request: StreamRequest): AsyncIterable<string> {
    const baseUrl = request.baseUrl || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stream from Anthropic API.
   */
  private async *streamAnthropic(request: StreamRequest): AsyncIterable<string> {
    const baseUrl = request.baseUrl || 'https://api.anthropic.com/v1';

    // Convert messages to Anthropic format
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const otherMessages = request.messages.filter((m) => m.role !== 'system');

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        system: systemMessage?.content,
        messages: otherMessages,
        max_tokens: request.maxTokens || 4096,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            if (json.type === 'content_block_delta') {
              const text = json.delta?.text;
              if (text) {
                yield text;
              }
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stream from generic OpenAI-compatible API.
   * Works with Ollama, Together AI, Groq, etc.
   */
  private async *streamGenericOpenAI(
    request: StreamRequest
  ): AsyncIterable<string> {
    // Use the same implementation as OpenAI
    yield* this.streamOpenAI(request);
  }
}

// Singleton instance
export const streamManager = new StreamManager();
