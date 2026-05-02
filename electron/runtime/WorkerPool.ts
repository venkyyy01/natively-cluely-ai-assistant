import { Metrics } from './Metrics';
import { appleSiliconQoS, type AppleSiliconQoSClass, type AppleSiliconQoSHandle } from './AppleSiliconQoS';
import type { RuntimeLane } from '../config/optimizations';

export interface WorkerPoolStats {
  size: number;
  activeWorkers: number;
  queueDepth: number;
  saturation: number;
}

export interface WorkerPoolSubmitOptions {
  lane?: RuntimeLane;
  priority?: number;
  qosClass?: AppleSiliconQoSClass;
}

interface WorkerPoolOptions {
  size: number;
  qos?: AppleSiliconQoSHandle;
  logger?: Pick<Console, 'warn'>;
  /**
   * NAT-016 / audit R-4: hard cap on the unprocessed queue depth. A burst of
   * `submit()` calls that would push the queue past this cap is rejected
   * synchronously with `worker_pool_queue_full` rather than buffered without
   * bound (which silently grows resident memory and head-of-line latency).
   *
   * Default: 1024 tasks per pool. Lower for latency-critical lanes.
   */
  maxQueueDepth?: number;
}

export const WORKER_POOL_QUEUE_FULL_ERROR = 'worker_pool_queue_full';
const DEFAULT_MAX_QUEUE_DEPTH = 1024;

interface QueuedTask<T> {
  id: number;
  priority: number;
  lane: RuntimeLane;
  qosClass: AppleSiliconQoSClass;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_QOS_BY_LANE: Record<RuntimeLane, AppleSiliconQoSClass> = {
  realtime: 'USER_INTERACTIVE',
  'local-inference': 'USER_INTERACTIVE',
  semantic: 'USER_INITIATED',
  background: 'BACKGROUND',
};

export class WorkerPool {
  private readonly size: number;
  private readonly qos: AppleSiliconQoSHandle;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly queue: Array<QueuedTask<unknown>> = [];
  private readonly maxQueueDepth: number;
  private activeWorkers = 0;
  private sequence = 0;
  private highWaterMark = 0;
  private rejectedCount = 0;

  constructor(options: WorkerPoolOptions) {
    this.size = Math.max(1, options.size);
    this.qos = options.qos ?? appleSiliconQoS;
    this.logger = options.logger ?? console;
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH);
  }

  getStats(): WorkerPoolStats {
    return {
      size: this.size,
      activeWorkers: this.activeWorkers,
      queueDepth: this.queue.length,
      saturation: this.activeWorkers / this.size,
    };
  }

  /**
   * NAT-016: gauge for `worker_pool.queue_depth`. Returns the current depth,
   * the configured cap, the all-time high-water mark, and the count of
   * rejected admissions since pool construction. Logged via `getStats()` is
   * the per-call read; this gauge is what an observability sink would scrape.
   */
  getQueueGauge(): {
    queueDepth: number;
    maxQueueDepth: number;
    highWaterMark: number;
    rejected: number;
  } {
    return {
      queueDepth: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      highWaterMark: this.highWaterMark,
      rejected: this.rejectedCount,
    };
  }

  submit<T>(options: WorkerPoolSubmitOptions, task: () => Promise<T> | T): Promise<T> {
    const lane = options.lane ?? 'background';
    const qosClass = options.qosClass ?? DEFAULT_QOS_BY_LANE[lane];
    const priority = options.priority ?? 0;

    // NAT-016 / audit R-4: bounded queue with synchronous admission control.
    // A submission that would push the queue past `maxQueueDepth` is
    // rejected with a stable error string instead of being buffered
    // unbounded. Callers (WorkerPool consumers) must treat this as a
    // backpressure signal and shed load — the prior behaviour was to grow
    // resident memory and tail latency without bound until the event loop
    // was starved.
    if (this.queue.length >= this.maxQueueDepth) {
      this.rejectedCount += 1;
      this.logger.warn(
        `[WorkerPool] queue full on lane "${lane}" (depth=${this.queue.length}, cap=${this.maxQueueDepth}); rejecting submission`,
      );
      return Promise.reject(new Error(WORKER_POOL_QUEUE_FULL_ERROR));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: ++this.sequence,
        priority,
        lane,
        qosClass,
        run: async () => await task(),
        resolve,
        reject,
      });

      if (this.queue.length > this.highWaterMark) {
        this.highWaterMark = this.queue.length;
      }

      this.queue.sort((left, right) => (
        right.priority - left.priority
        || left.id - right.id
      ));
      Metrics.gauge('worker_pool.queue_depth', this.queue.length);
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeWorkers < this.size && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }

      this.activeWorkers += 1;
      Promise.resolve()
        .then(() => {
          try {
            this.qos.setCurrentThreadQoS(task.qosClass);
          } catch (error) {
            this.logger.warn(`[WorkerPool] QoS placement failed for lane "${task.lane}", continuing without QoS:`, error);
          }
          return task.run();
        })
        .then((value) => {
          task.resolve(value);
        })
        .catch((error) => {
          this.logger.warn(`[WorkerPool] Task failed on lane "${task.lane}":`, error);
          task.reject(error);
        })
        .finally(() => {
          this.activeWorkers -= 1;
          this.pump();
        });
    }
  }
}
