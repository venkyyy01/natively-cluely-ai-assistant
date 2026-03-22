import { isOptimizationActive } from '../config/optimizations';

export interface StreamChunk {
  text: string;
  index: number;
}

export interface StreamConfig {
  consciousMode?: boolean;
  onBackgroundTask?: () => Promise<void>;
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
  private backgroundTasks: Promise<void>[] = [];
  private activeTasksCount: number = 0;
  private readonly maxConcurrency = 3;
  private readonly maxAccumulatorLength = 500000; // ~500kb limit

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

    this.jsonAccumulator = '';
    this.pendingBuffer = '';
    this.backgroundTasks = [];
    this.activeTasksCount = 0;

    try {
      for await (const chunk of stream) {
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
                this.activeTasksCount++;
                const task = config.onBackgroundTask().finally(() => {
                  this.activeTasksCount--;
                  const index = this.backgroundTasks.indexOf(task);
                  if (index > -1) this.backgroundTasks.splice(index, 1);
                });
                this.backgroundTasks.push(task);
              }
            }
          }
        }
      }

      if (this.pendingBuffer.length > 0) {
        this.callbacks.onToken(this.pendingBuffer);
        this.pendingBuffer = '';
      }

      if (this.backgroundTasks.length > 0) {
        await Promise.allSettled(this.backgroundTasks);
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
      this.backgroundTasks = [];
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private isSemanticBoundary(text: string): boolean {
    return /[.?!]\s*$|\n$/.test(text);
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

  reset(): void {
    this.jsonAccumulator = '';
    this.pendingBuffer = '';
    this.backgroundTasks = [];
  }
}
