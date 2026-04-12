// electron/conscious/ConsciousStreamingHandler.ts
// Real-time streaming response handler with progressive rendering

import type { ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { InterviewPhase } from './types';

export type StreamEventType =
  | 'reasoning_start'
  | 'reasoning_chunk'
  | 'reasoning_complete'
  | 'plan_start'
  | 'plan_item'
  | 'plan_complete'
  | 'tradeoffs_start'
  | 'tradeoffs_item'
  | 'tradeoffs_complete'
  | 'edge_cases_start'
  | 'edge_cases_item'
  | 'edge_cases_complete'
  | 'scale_start'
  | 'scale_item'
  | 'scale_complete'
  | 'pushback_start'
  | 'pushback_item'
  | 'pushback_complete'
  | 'followups_start'
  | 'followups_item'
  | 'followups_complete'
  | 'code_start'
  | 'code_chunk'
  | 'code_complete'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface StreamEvent {
  type: StreamEventType;
  timestamp: number;
  data?: unknown;
  chunk?: string;
  item?: string;
  progress?: number;
  latencyMs?: number;
}

export type StreamHandler = (event: StreamEvent) => void | Promise<void>;

export interface StreamingConfig {
  enableProgressiveRendering: boolean;
  chunkDelayMs: number;
  maxChunkSize: number;
  bufferSize: number;
  abortOnError: boolean;
  timeoutMs: number;
}

const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  enableProgressiveRendering: true,
  chunkDelayMs: 50,
  maxChunkSize: 100,
  bufferSize: 10,
  abortOnError: true,
  timeoutMs: 30000,
};

export interface StreamingMetrics {
  startTime: number;
  firstChunkTime: number | null;
  completeTime: number | null;
  totalChunks: number;
  totalBytes: number;
  avgChunkLatencyMs: number;
  estimatedTimeRemainingMs: number | null;
}

export class ConsciousStreamingHandler {
  private config: StreamingConfig;
  private handlers: Set<StreamHandler> = new Set();
  private abortController: AbortController | null = null;
  private metrics: StreamingMetrics = {
    startTime: 0,
    firstChunkTime: null,
    completeTime: null,
    totalChunks: 0,
    totalBytes: 0,
    avgChunkLatencyMs: 0,
    estimatedTimeRemainingMs: null,
  };
  private chunkLatencies: number[] = [];

  constructor(config: Partial<StreamingConfig> = {}) {
    this.config = { ...DEFAULT_STREAMING_CONFIG, ...config };
  }

  /**
   * Subscribe to stream events
   */
  on(handler: StreamHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Emit event to all handlers
   */
  private async emit(event: StreamEvent): Promise<void> {
    const promises = Array.from(this.handlers).map(async (handler) => {
      try {
        await handler(event);
      } catch (error) {
        console.error('[ConsciousStreamingHandler] Handler error:', error);
      }
    });
    await Promise.all(promises);
  }

  /**
   * Start streaming session
   */
  start(): void {
    this.abortController = new AbortController();
    this.metrics = {
      startTime: Date.now(),
      firstChunkTime: null,
      completeTime: null,
      totalChunks: 0,
      totalBytes: 0,
      avgChunkLatencyMs: 0,
      estimatedTimeRemainingMs: null,
    };
    this.chunkLatencies = [];
  }

  /**
   * Abort current stream
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.emit({ type: 'cancelled', timestamp: Date.now() });
    }
  }

  /**
   * Check if stream is aborted
   */
  isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  /**
   * Stream reasoning text progressively
   */
  async streamReasoning(reasoning: string): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'reasoning_start', timestamp: startTime });

    if (!this.config.enableProgressiveRendering) {
      await this.emit({
        type: 'reasoning_complete',
        timestamp: Date.now(),
        data: { reasoning },
      });
      return;
    }

    // Split into chunks and stream
    const chunks = this.splitIntoChunks(reasoning);
    let accumulated = '';

    for (const chunk of chunks) {
      if (this.isAborted()) break;

      accumulated += chunk;
      const chunkStart = Date.now();

      await this.emit({
        type: 'reasoning_chunk',
        timestamp: chunkStart,
        chunk,
        data: { accumulated, progress: accumulated.length / reasoning.length },
      });

      this.recordChunkLatency(Date.now() - chunkStart);
      await this.delay(this.config.chunkDelayMs);
    }

    await this.emit({
      type: 'reasoning_complete',
      timestamp: Date.now(),
      data: { reasoning: accumulated },
      latencyMs: Date.now() - startTime,
    });
  }

  /**
   * Stream implementation plan items
   */
  async streamImplementationPlan(items: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'plan_start', timestamp: startTime });

    for (let i = 0; i < items.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'plan_item',
        timestamp: Date.now(),
        item: items[i],
        data: {
          index: i,
          total: items.length,
          progress: (i + 1) / items.length,
        },
      });

      await this.delay(this.config.chunkDelayMs);
    }

    await this.emit({
      type: 'plan_complete',
      timestamp: Date.now(),
      data: { items },
      latencyMs: Date.now() - startTime,
    });
  }

  /**
   * Stream tradeoffs
   */
  async streamTradeoffs(tradeoffs: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'tradeoffs_start', timestamp: startTime });

    for (let i = 0; i < tradeoffs.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'tradeoffs_item',
        timestamp: Date.now(),
        item: tradeoffs[i],
        data: { index: i, total: tradeoffs.length },
      });

      await this.delay(this.config.chunkDelayMs / 2); // Faster for tradeoffs
    }

    await this.emit({
      type: 'tradeoffs_complete',
      timestamp: Date.now(),
      data: { tradeoffs },
    });
  }

  /**
   * Stream edge cases
   */
  async streamEdgeCases(edgeCases: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'edge_cases_start', timestamp: startTime });

    for (let i = 0; i < edgeCases.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'edge_cases_item',
        timestamp: Date.now(),
        item: edgeCases[i],
        data: { index: i, total: edgeCases.length },
      });

      await this.delay(this.config.chunkDelayMs / 2);
    }

    await this.emit({
      type: 'edge_cases_complete',
      timestamp: Date.now(),
      data: { edgeCases },
    });
  }

  /**
   * Stream scale considerations
   */
  async streamScaleConsiderations(considerations: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'scale_start', timestamp: startTime });

    for (let i = 0; i < considerations.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'scale_item',
        timestamp: Date.now(),
        item: considerations[i],
        data: { index: i, total: considerations.length },
      });

      await this.delay(this.config.chunkDelayMs / 2);
    }

    await this.emit({
      type: 'scale_complete',
      timestamp: Date.now(),
      data: { considerations },
    });
  }

  /**
   * Stream pushback responses
   */
  async streamPushbackResponses(pushbacks: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'pushback_start', timestamp: startTime });

    for (let i = 0; i < pushbacks.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'pushback_item',
        timestamp: Date.now(),
        item: pushbacks[i],
        data: { index: i, total: pushbacks.length },
      });

      await this.delay(this.config.chunkDelayMs / 2);
    }

    await this.emit({
      type: 'pushback_complete',
      timestamp: Date.now(),
      data: { pushbacks },
    });
  }

  /**
   * Stream likely follow-ups
   */
  async streamLikelyFollowUps(followUps: string[]): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'followups_start', timestamp: startTime });

    for (let i = 0; i < followUps.length; i++) {
      if (this.isAborted()) break;

      await this.emit({
        type: 'followups_item',
        timestamp: Date.now(),
        item: followUps[i],
        data: { index: i, total: followUps.length },
      });

      await this.delay(this.config.chunkDelayMs / 2);
    }

    await this.emit({
      type: 'followups_complete',
      timestamp: Date.now(),
      data: { followUps },
    });
  }

  /**
   * Stream code transition
   */
  async streamCodeTransition(code: string, language?: string): Promise<void> {
    if (this.isAborted()) return;

    const startTime = Date.now();
    await this.emit({ type: 'code_start', timestamp: startTime, data: { language } });

    if (!this.config.enableProgressiveRendering) {
      await this.emit({
        type: 'code_complete',
        timestamp: Date.now(),
        data: { code, language },
      });
      return;
    }

    // Stream code line by line for better readability
    const lines = code.split('\n');
    let accumulated = '';

    for (const line of lines) {
      if (this.isAborted()) break;

      accumulated += line + '\n';
      await this.emit({
        type: 'code_chunk',
        timestamp: Date.now(),
        chunk: line + '\n',
        data: {
          accumulated,
          progress: accumulated.length / code.length,
        },
      });

      await this.delay(10); // Faster for code
    }

    await this.emit({
      type: 'code_complete',
      timestamp: Date.now(),
      data: { code: accumulated, language },
    });
  }

  /**
   * Stream complete structured response
   */
  async streamCompleteResponse(
    response: ConsciousModeStructuredResponse,
    phase?: InterviewPhase
  ): Promise<void> {
    this.start();

    try {
      // Stream reasoning first
      if (response.openingReasoning) {
        await this.streamReasoning(response.openingReasoning);
      }

      // Stream implementation plan
      if (response.implementationPlan?.length) {
        await this.streamImplementationPlan(response.implementationPlan);
      }

      // Stream tradeoffs
      if (response.tradeoffs?.length) {
        await this.streamTradeoffs(response.tradeoffs);
      }

      // Stream edge cases
      if (response.edgeCases?.length) {
        await this.streamEdgeCases(response.edgeCases);
      }

      // Stream scale considerations
      if (response.scaleConsiderations?.length) {
        await this.streamScaleConsiderations(response.scaleConsiderations);
      }

      // Stream pushback responses
      if (response.pushbackResponses?.length) {
        await this.streamPushbackResponses(response.pushbackResponses);
      }

      // Stream follow-ups
      if (response.likelyFollowUps?.length) {
        await this.streamLikelyFollowUps(response.likelyFollowUps);
      }

      // Stream code transition
      if (response.codeTransition) {
        await this.streamCodeTransition(response.codeTransition);
      }

      // Complete
      await this.emit({
        type: 'complete',
        timestamp: Date.now(),
        data: { response, phase },
      });
    } catch (error) {
      await this.emit({
        type: 'error',
        timestamp: Date.now(),
        data: { error: error instanceof Error ? error.message : String(error) },
      });

      if (this.config.abortOnError) {
        throw error;
      }
    }
  }

  /**
   * Split text into chunks
   */
  private splitIntoChunks(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      const chunkSize = Math.min(remaining.length, this.config.maxChunkSize);
      // Try to break at word boundary
      let breakPoint = chunkSize;
      if (chunkSize < remaining.length) {
        const lastSpace = remaining.lastIndexOf(' ', chunkSize);
        if (lastSpace > chunkSize * 0.5) {
          breakPoint = lastSpace;
        }
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Record chunk latency
   */
  private recordChunkLatency(latencyMs: number): void {
    this.chunkLatencies.push(latencyMs);
    if (this.chunkLatencies.length > 10) {
      this.chunkLatencies.shift();
    }

    this.metrics.totalChunks++;
    this.metrics.avgChunkLatencyMs =
      this.chunkLatencies.reduce((a, b) => a + b, 0) / this.chunkLatencies.length;

    if (this.metrics.firstChunkTime === null) {
      this.metrics.firstChunkTime = Date.now();
    }
  }

  /**
   * Get streaming metrics
   */
  getMetrics(): StreamingMetrics {
    return { ...this.metrics };
  }

  /**
   * Update streaming config
   */
  updateConfig(config: Partial<StreamingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Remove all handlers
   */
  dispose(): void {
    this.handlers.clear();
    this.abortController = null;
  }
}
