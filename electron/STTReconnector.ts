import { EventEmitter } from 'node:events';

type Speaker = 'interviewer' | 'user';

export class STTReconnector extends EventEmitter {
  private readonly maxRetries = 5;
  private readonly baseDelayMs = 1000;
  private readonly errorWindowMs = 30_000;
  private readonly requiredErrorCount = 3;
  private readonly retryCounts = new Map<Speaker, number>();
  private readonly errorTimestamps = new Map<Speaker, number[]>();
  private readonly timeouts = new Map<Speaker, NodeJS.Timeout>();

  constructor(private readonly reconnectFn: (speaker: Speaker) => Promise<void> | void) {
    super();
  }

  public onError(speaker: Speaker): void {
    const now = Date.now();
    const recent = (this.errorTimestamps.get(speaker) ?? []).filter((timestamp) => now - timestamp <= this.errorWindowMs);
    recent.push(now);
    this.errorTimestamps.set(speaker, recent);

    if (recent.length < this.requiredErrorCount || this.timeouts.has(speaker)) {
      return;
    }

    this.scheduleReconnect(speaker);
  }

  public reset(speaker: Speaker): void {
    this.retryCounts.set(speaker, 0);
    this.errorTimestamps.delete(speaker);
    const timeout = this.timeouts.get(speaker);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(speaker);
    }
  }

  public stopAll(): void {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.retryCounts.clear();
    this.errorTimestamps.clear();
  }

  private scheduleReconnect(speaker: Speaker): void {
    const retryCount = this.retryCounts.get(speaker) ?? 0;
    if (retryCount >= this.maxRetries) {
      this.emit('exhausted', { speaker, attempts: retryCount });
      return;
    }

    const attempt = retryCount + 1;
    const delayMs = this.baseDelayMs * (2 ** retryCount);
    this.retryCounts.set(speaker, attempt);
    this.emit('reconnecting', { speaker, attempt, delayMs });

    const timeout = setTimeout(async () => {
      this.timeouts.delete(speaker);
      try {
        await this.reconnectFn(speaker);
        this.errorTimestamps.delete(speaker);
        this.retryCounts.set(speaker, 0);
        this.emit('reconnected', { speaker, attempt });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          this.emit('exhausted', { speaker, attempts: attempt, error });
          return;
        }

        this.scheduleReconnect(speaker);
      }
    }, delayMs);

    this.timeouts.set(speaker, timeout);
  }
}
