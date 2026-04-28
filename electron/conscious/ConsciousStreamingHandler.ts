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
  /**
   * NAT-008 / audit A-8: monotonic id of the stream that produced this event.
   * Bumped by every `start()` call. Handlers can use it to drop chunks from
   * a stream that was cancelled by a subsequent `start()` if they were
   * already mid-await when the cancel landed.
   */
  streamId?: number;
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
  /**
   * NAT-008 / audit A-8: monotonic id of the *current* stream. Bumped on
   * every `start()`. Each chunk-producing method captures this at its top,
   * and bails the moment the captured id doesn't match -- which is the
   * canonical "the world moved on while I was awaiting the next chunk emit"
   * signal for streaming UIs.
   */
  private currentStreamId = 0;
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
   * Emit event to all handlers. Always stamps `streamId` with the current
   * stream id so handlers can drop stale events.
   */
  private async emit(event: StreamEvent): Promise<void> {
    const stamped: StreamEvent = { ...event, streamId: event.streamId ?? this.currentStreamId };
    const promises = Array.from(this.handlers).map(async (handler) => {
      try {
        await handler(stamped);
      } catch (error) {
        console.error('[ConsciousStreamingHandler] Handler error:', error);
      }
    });
    await Promise.all(promises);
  }

  /**
   * Start a streaming session.
   *
   * NAT-008 / audit A-8: if a previous stream is still alive (controller
   * exists and is not already aborted), it is aborted FIRST and a
   * `cancelled` event for the *previous* stream id is awaited before the
   * new controller takes over. Without this, calling `start()` twice in
   * quick succession would leak the prior `AbortController`, leaving
   * in-flight chunk loops racing against the new stream and producing
   * cross-turn token interleaving in the renderer.
   */
  async start(): Promise<void> {
    if (this.abortController && !this.abortController.signal.aborted) {
      const previousStreamId = this.currentStreamId;
      this.abortController.abort();
      // Emit cancelled with the OLD streamId so handlers can attribute it
      // to the stream that was actually cancelled, not the one starting.
      await this.emit({
        type: 'cancelled',
        timestamp: Date.now(),
        streamId: previousStreamId,
      });
    }

    this.currentStreamId += 1;
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
  async abort(): Promise<void> {
    if (this.abortController && !this.abortController.signal.aborted) {
      const cancelledStreamId = this.currentStreamId;
      this.abortController.abort();
      await this.emit({
        type: 'cancelled',
        timestamp: Date.now(),
        streamId: cancelledStreamId,
      });
    }
  }

  /**
   * Check if stream is aborted
   */
  isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  /**
   * Returns true if the given streamId is no longer current (either the
   * controller was aborted or a new `start()` superseded it).
   */
  private isStaleStream(streamId: number): boolean {
    return this.isAborted() || streamId !== this.currentStreamId;
  }

  /**
   * Get the current stream id. Useful for tests and for handlers that
   * want to ignore events from a stream id they didn't subscribe to.
   */
  getCurrentStreamId(): number {
    return this.currentStreamId;
  }

  /**
   * Stream reasoning text progressively
   */
  async streamReasoning(reasoning: string): Promise<void> {
    const myStreamId = this.currentStreamId;
    if (this.isStaleStream(myStreamId)) return;

    const startTime = Date.now();
    await this.emit({ type: 'reasoning_start', timestamp: startTime, streamId: myStreamId });

    if (!this.config.enableProgressiveRendering) {
      await this.emit({
        type: 'reasoning_complete',
        timestamp: Date.now(),
        data: { reasoning },
        streamId: myStreamId,
      });
      return;
    }

    const chunks = this.splitIntoChunks(reasoning);
    let accumulated = '';

    for (const chunk of chunks) {
      if (this.isStaleStream(myStreamId)) return;

      accumulated += chunk;
      const chunkStart = Date.now();

      await this.emit({
        type: 'reasoning_chunk',
        timestamp: chunkStart,
        chunk,
        data: { accumulated, progress: accumulated.length / reasoning.length },
        streamId: myStreamId,
      });

      this.recordChunkLatency(Date.now() - chunkStart);
      await this.delay(this.config.chunkDelayMs);
    }

    if (this.isStaleStream(myStreamId)) return;
    await this.emit({
      type: 'reasoning_complete',
      timestamp: Date.now(),
      data: { reasoning: accumulated },
      latencyMs: Date.now() - startTime,
      streamId: myStreamId,
    });
  }

  /**
   * Stream implementation plan items
   */
  async streamImplementationPlan(items: string[]): Promise<void> {
    const myStreamId = this.currentStreamId;
    if (this.isStaleStream(myStreamId)) return;

    const startTime = Date.now();
    await this.emit({ type: 'plan_start', timestamp: startTime, streamId: myStreamId });

    for (let i = 0; i < items.length; i++) {
      if (this.isStaleStream(myStreamId)) return;

      await this.emit({
        type: 'plan_item',
        timestamp: Date.now(),
        item: items[i],
        data: {
          index: i,
          total: items.length,
          progress: (i + 1) / items.length,
        },
        streamId: myStreamId,
      });

      await this.delay(this.config.chunkDelayMs);
    }

    if (this.isStaleStream(myStreamId)) return;
    await this.emit({
      type: 'plan_complete',
      timestamp: Date.now(),
      data: { items },
      latencyMs: Date.now() - startTime,
      streamId: myStreamId,
    });
  }

  /**
   * Stream tradeoffs
   */
  async streamTradeoffs(tradeoffs: string[]): Promise<void> {
    await this.streamItems('tradeoffs_start', 'tradeoffs_item', 'tradeoffs_complete', tradeoffs, 'tradeoffs');
  }

  /**
   * Stream edge cases
   */
  async streamEdgeCases(edgeCases: string[]): Promise<void> {
    await this.streamItems('edge_cases_start', 'edge_cases_item', 'edge_cases_complete', edgeCases, 'edgeCases');
  }

  /**
   * Stream scale considerations
   */
  async streamScaleConsiderations(considerations: string[]): Promise<void> {
    await this.streamItems('scale_start', 'scale_item', 'scale_complete', considerations, 'considerations');
  }

  /**
   * Stream pushback responses
   */
  async streamPushbackResponses(pushbacks: string[]): Promise<void> {
    await this.streamItems('pushback_start', 'pushback_item', 'pushback_complete', pushbacks, 'pushbacks');
  }

  /**
   * Stream likely follow-ups
   */
  async streamLikelyFollowUps(followUps: string[]): Promise<void> {
    await this.streamItems('followups_start', 'followups_item', 'followups_complete', followUps, 'followUps');
  }

  private async streamItems(
    startType: StreamEventType,
    itemType: StreamEventType,
    completeType: StreamEventType,
    items: string[],
    completeKey: string,
  ): Promise<void> {
    const myStreamId = this.currentStreamId;
    if (this.isStaleStream(myStreamId)) return;

    const startTime = Date.now();
    await this.emit({ type: startType, timestamp: startTime, streamId: myStreamId });

    for (let i = 0; i < items.length; i++) {
      if (this.isStaleStream(myStreamId)) return;

      await this.emit({
        type: itemType,
        timestamp: Date.now(),
        item: items[i],
        data: { index: i, total: items.length },
        streamId: myStreamId,
      });

      await this.delay(this.config.chunkDelayMs / 2);
    }

    if (this.isStaleStream(myStreamId)) return;
    await this.emit({
      type: completeType,
      timestamp: Date.now(),
      data: { [completeKey]: items },
      streamId: myStreamId,
    });
  }

  /**
   * Stream code transition
   */
  async streamCodeTransition(code: string, language?: string): Promise<void> {
    const myStreamId = this.currentStreamId;
    if (this.isStaleStream(myStreamId)) return;

    const startTime = Date.now();
    await this.emit({
      type: 'code_start',
      timestamp: startTime,
      data: { language },
      streamId: myStreamId,
    });

    if (!this.config.enableProgressiveRendering) {
      await this.emit({
        type: 'code_complete',
        timestamp: Date.now(),
        data: { code, language },
        streamId: myStreamId,
      });
      return;
    }

    const lines = code.split('\n');
    let accumulated = '';

    for (const line of lines) {
      if (this.isStaleStream(myStreamId)) return;

      accumulated += line + '\n';
      await this.emit({
        type: 'code_chunk',
        timestamp: Date.now(),
        chunk: line + '\n',
        data: {
          accumulated,
          progress: accumulated.length / code.length,
        },
        streamId: myStreamId,
      });

      await this.delay(10); // Faster for code
    }

    if (this.isStaleStream(myStreamId)) return;
    await this.emit({
      type: 'code_complete',
      timestamp: Date.now(),
      data: { code: accumulated, language },
      streamId: myStreamId,
    });
  }

  /**
   * Stream complete structured response
   */
  async streamCompleteResponse(
    response: ConsciousModeStructuredResponse,
    phase?: InterviewPhase
  ): Promise<void> {
    await this.start();
    const myStreamId = this.currentStreamId;

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

      if (this.isStaleStream(myStreamId)) return;
      await this.emit({
        type: 'complete',
        timestamp: Date.now(),
        data: { response, phase },
        streamId: myStreamId,
      });
    } catch (error) {
      if (this.isStaleStream(myStreamId)) {
        if (this.config.abortOnError) throw error;
        return;
      }
      await this.emit({
        type: 'error',
        timestamp: Date.now(),
        data: { error: error instanceof Error ? error.message : String(error) },
        streamId: myStreamId,
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
