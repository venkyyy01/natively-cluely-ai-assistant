import { isOptimizationActive } from '../config/optimizations';

export interface StreamChunk {
  text: string;
  index: number;
}

export interface StreamConfig {
  consciousMode?: boolean;
  onBackgroundTask?: (abortSignal: AbortSignal) => Promise<void>;
}

interface StreamConfigCallbacks {
  onToken: (token: string) => void;
  onPartialJson: (partial: unknown) => void;
  onComplete: (full: unknown) => void;
  onError: (error: Error) => void;
}

interface PartialJsonParser {
  tryParse: (text: string) => unknown | null;
}

interface BackgroundTaskInfo {
  task: Promise<void>;
  controller: AbortController;
  id: number;
}

class DefaultPartialJsonParser implements PartialJsonParser {
  tryParse(text: string): unknown | null {
    if (!text.includes('{') || !text.includes('}')) {
      return null;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    const jsonStr = text.substring(start, end + 1);

    try {
      return JSON.parse(jsonStr);
    } catch {
      try {
        const fixed = jsonStr.replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(fixed);
      } catch {
        return null;
      }
    }
  }
}

export class StreamManager {
  private jsonAccumulator: string = '';
  private pendingBuffer: string = '';
  private partialParser: PartialJsonParser = new DefaultPartialJsonParser();
  private callbacks: StreamConfigCallbacks;
  
  // HIGH RELIABILITY FIX: Proper background task management with AbortController
  private backgroundTasks: Map<number, BackgroundTaskInfo> = new Map();
  private nextTaskId: number = 0;
  private activeTasksCount: number = 0;
  private readonly maxConcurrency = 3;
  private readonly maxAccumulatorLength = 500000; // ~500kb limit
  private streamAbortController: AbortController | null = null;

  constructor(callbacks: StreamConfigCallbacks) {
    this.callbacks = callbacks;
  }

  async processStream(
    stream: AsyncIterable<StreamChunk>,
    config: StreamConfig
  ): Promise<void> {
    if (!isOptimizationActive('useStreamManager')) {
      await this.processStreamLegacy(stream, config);
      return;
    }

    // HIGH RELIABILITY FIX: Initialize stream-level abort controller
    this.streamAbortController = new AbortController();
    this.jsonAccumulator = '';
    this.pendingBuffer = '';
    this.activeTasksCount = 0;
    
    try {
      for await (const chunk of stream) {
        // Check if processing has been aborted
        if (this.streamAbortController.signal.aborted) {
          throw new Error("Stream processing aborted");
        }
        
        this.pendingBuffer += chunk.text;
        
        if (this.jsonAccumulator.length < this.maxAccumulatorLength) {
          this.jsonAccumulator += chunk.text;
        }

        if (this.isSemanticBoundary(this.pendingBuffer)) {
          this.callbacks.onToken(this.pendingBuffer);
          this.pendingBuffer = '';

          if (config.consciousMode) {
            const partial = this.partialParser.tryParse(this.jsonAccumulator);
            if (partial) {
              this.callbacks.onPartialJson(partial);

              if (config.onBackgroundTask && this.activeTasksCount < this.maxConcurrency) {
                this.startBackgroundTask(config.onBackgroundTask);
              }
            }
          }
        }
      }

      if (this.pendingBuffer.length > 0) {
        this.callbacks.onToken(this.pendingBuffer);
        this.pendingBuffer = '';
      }

      // HIGH RELIABILITY FIX: Properly wait for background tasks to complete or timeout
      if (this.backgroundTasks.size > 0) {
        await this.waitForBackgroundTasks();
      }

      if (config.consciousMode && this.jsonAccumulator) {
        try {
          const full = JSON.parse(this.jsonAccumulator);
          this.callbacks.onComplete(full);
        } catch {
          this.callbacks.onComplete({ raw: this.jsonAccumulator });
        }
      }

    } catch (error) {
      // HIGH RELIABILITY FIX: Properly cancel all background tasks on error
      this.cancelAllBackgroundTasks("Stream processing failed");
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // HIGH RELIABILITY FIX: Clean up resources
      this.cleanup();
    }
  }

  /**
   * HIGH RELIABILITY FIX: Start a background task with proper abort controller
   */
  private startBackgroundTask(taskFn: (abortSignal: AbortSignal) => Promise<void>): void {
    const taskId = this.nextTaskId++;
    const controller = new AbortController();
    
    this.activeTasksCount++;
    
    const task = taskFn(controller.signal)
      .catch((error) => {
        // Don't log abort errors as they're intentional
        if (error.name !== 'AbortError') {
          console.error(`[StreamManager] Background task ${taskId} failed:`, error);
        }
      })
      .finally(() => {
        this.activeTasksCount--;
        this.backgroundTasks.delete(taskId);
      });
    
    this.backgroundTasks.set(taskId, { task, controller, id: taskId });
  }

  /**
   * HIGH RELIABILITY FIX: Wait for all background tasks with timeout
   */
  private async waitForBackgroundTasks(timeoutMs: number = 10000): Promise<void> {
    const taskPromises = Array.from(this.backgroundTasks.values()).map(({ task }) => task);
    
    if (taskPromises.length === 0) return;

    try {
      // Wait for all tasks or timeout
      await Promise.race([
        Promise.allSettled(taskPromises),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Background tasks timeout')), timeoutMs)
        )
      ]);
    } catch (error) {
      console.warn('[StreamManager] Background tasks timed out, cancelling remaining tasks');
      this.cancelAllBackgroundTasks("Background tasks timeout");
    }
  }

  /**
   * HIGH RELIABILITY FIX: Cancel all background tasks with proper cleanup
   */
  private cancelAllBackgroundTasks(reason: string): void {
    const tasks = Array.from(this.backgroundTasks.entries());
    for (const [taskId, { controller }] of tasks) {
      try {
        controller.abort(new Error(reason));
      } catch (error) {
        console.warn(`[StreamManager] Failed to abort background task ${taskId}:`, error);
      }
    }
    this.backgroundTasks.clear();
    this.activeTasksCount = 0;
  }

  /**
   * HIGH RELIABILITY FIX: Comprehensive cleanup of resources
   */
  private cleanup(): void {
    if (this.streamAbortController) {
      this.streamAbortController.abort();
      this.streamAbortController = null;
    }
    this.cancelAllBackgroundTasks("Stream processing completed");
  }

  private isSemanticBoundary(text: string): boolean {
    // Flush on sentence boundaries or newlines.
    // Also flush if buffer exceeds 200 chars without punctuation to prevent
    // holding tokens for long unpunctuated sentences.
    return /[.?!]\s*$|\n$/.test(text) || text.length > 200;
  }

  private async processStreamLegacy(
    stream: AsyncIterable<StreamChunk>,
    _config: StreamConfig
  ): Promise<void> {
    try {
      let fullText = '';

      for await (const chunk of stream) {
        this.callbacks.onToken(chunk.text);
        fullText += chunk.text;
      }

      try {
        const parsed = JSON.parse(fullText);
        this.callbacks.onComplete(parsed);
      } catch {
        this.callbacks.onComplete({ text: fullText });
      }
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * HIGH RELIABILITY FIX: Enhanced reset with proper cleanup
   */
  reset(): void {
    this.jsonAccumulator = '';
    this.pendingBuffer = '';
    this.cancelAllBackgroundTasks("StreamManager reset");
  }

  /**
   * HIGH RELIABILITY FIX: Graceful shutdown method
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    try {
      await this.waitForBackgroundTasks(timeoutMs);
    } finally {
      this.cleanup();
    }
  }
}
