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
}

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
  private activeWorkers = 0;
  private sequence = 0;

  constructor(options: WorkerPoolOptions) {
    this.size = Math.max(1, options.size);
    this.qos = options.qos ?? appleSiliconQoS;
    this.logger = options.logger ?? console;
  }

  getStats(): WorkerPoolStats {
    return {
      size: this.size,
      activeWorkers: this.activeWorkers,
      queueDepth: this.queue.length,
      saturation: this.activeWorkers / this.size,
    };
  }

  submit<T>(options: WorkerPoolSubmitOptions, task: () => Promise<T> | T): Promise<T> {
    const lane = options.lane ?? 'background';
    const qosClass = options.qosClass ?? DEFAULT_QOS_BY_LANE[lane];
    const priority = options.priority ?? 0;

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

      this.queue.sort((left, right) => (
        right.priority - left.priority
        || left.id - right.id
      ));
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
          this.qos.setCurrentThreadQoS(task.qosClass);
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
