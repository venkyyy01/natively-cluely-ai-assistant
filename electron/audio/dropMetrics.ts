// electron/audio/dropMetrics.ts
//
// NAT-021 / audit R-11: every STT provider has a bounded buffer that
// silently drops audio under backpressure (ring-buffer overwrite, or
// `shift()` once the array exceeds a cap). Before this ticket none of
// those drops were visible — silent audio loss was a flat "WER got
// worse" symptom with no operator handle.
//
// This helper centralises the policy so each provider only has to:
//
//     this.dropMetric.recordDrop()
//
// at the overflow site and call `this.dropMetric.start(provider)` /
// `this.dropMetric.stop()` around the connection lifecycle. The metric
// emits a periodic (every 5 s by default) line of the form:
//
//     [stt.dropped_frames] provider=deepgram window=5s dropped=12 cumulative=347
//
// which is grep-able and stable for an observability collector to
// scrape. We deliberately do NOT push these drops out via SupervisorBus
// — they are noisy and provider-internal, and the bus already carries
// `stt:provider-exhausted` for the pivotal events.
//
// We capture references to setInterval/clearInterval at module-load
// time so existing STT lifecycle tests that mutate `global.setInterval`
// to spy on provider-internal timers (keep-alive, connection-guard,
// liveness watchdog) do not also capture the metric's flush timer.
// The metric is observability infrastructure and should not pollute
// other suites' timer counts.

import { Metrics } from '../runtime/Metrics';

const NATIVE_SET_INTERVAL: typeof setInterval = setInterval;
const NATIVE_CLEAR_INTERVAL: typeof clearInterval = clearInterval;

export interface DropFrameMetricOptions {
  /** Stable provider tag, e.g. 'deepgram', 'google', 'elevenlabs'. */
  provider: string;
  /** How often to flush the rolling counter to the log. Default: 5 s. */
  flushIntervalMs?: number;
  /** Logger (console by default). */
  logger?: Pick<Console, 'warn'>;
  /** Clock injection for tests. */
  now?: () => number;
  /** Timer factory injection for tests; defaults to setInterval. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class DropFrameMetric {
  private readonly provider: string;
  private readonly flushIntervalMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  private windowDropped = 0;
  private cumulativeDropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DropFrameMetricOptions) {
    this.provider = options.provider;
    this.flushIntervalMs = Math.max(100, options.flushIntervalMs ?? 5_000);
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? NATIVE_SET_INTERVAL;
    this.clearIntervalFn = options.clearInterval ?? NATIVE_CLEAR_INTERVAL;
  }

  /** Increment the rolling-window drop counter (and the cumulative one). */
  recordDrop(count = 1): void {
    if (count <= 0) return;
    this.windowDropped += count;
    this.cumulativeDropped += count;
    Metrics.counter('stt.dropped_frames', count, { provider: this.provider });
  }

  /**
   * Begin the periodic flush. Idempotent — calling twice is a no-op.
   * Should be called at provider connect-time and stopped on disconnect.
   */
  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => this.flush(false), this.flushIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop the periodic flush. Final flush is opt-in; default is true. */
  stop(finalFlush = true): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (finalFlush && this.windowDropped > 0) {
      this.flush(true);
    }
  }

  /**
   * Emit a single line if there were drops in the current window. Tests
   * call this directly; production uses the periodic timer.
   */
  flush(_force: boolean): void {
    if (this.windowDropped === 0) return;
    this.logger.warn(
      `[stt.dropped_frames] provider=${this.provider} window=${this.flushIntervalMs}ms dropped=${this.windowDropped} cumulative=${this.cumulativeDropped} ts=${this.now()}`,
    );
    this.windowDropped = 0;
  }

  /** Test/inspection accessor. */
  getCounters(): { windowDropped: number; cumulativeDropped: number } {
    return {
      windowDropped: this.windowDropped,
      cumulativeDropped: this.cumulativeDropped,
    };
  }
}
