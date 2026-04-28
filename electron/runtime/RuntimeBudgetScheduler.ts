import { SupervisorBus } from './SupervisorBus';
import { WorkerPool } from './WorkerPool';
import {
  DEFAULT_LANE_BUDGETS,
  type LaneBudgetConfig,
  type RuntimeLane,
} from '../config/optimizations';

export type BudgetPressureLevel = 'warning' | 'critical';

export interface RuntimeBudgetLaneStatus {
  lane: RuntimeLane;
  running: number;
  queued: number;
  budget: LaneBudgetConfig;
  pressure: BudgetPressureLevel | null;
}

interface RuntimeBudgetSchedulerOptions {
  bus?: SupervisorBus;
  workerPool?: WorkerPool;
  laneBudgets?: Partial<Record<RuntimeLane, LaneBudgetConfig>>;
  maxQueueDepthByLane?: Partial<Record<RuntimeLane, number>>;
  memoryUsageReader?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface ScheduledLaneTask<T> {
  lane: RuntimeLane;
  priority: number;
  order: number;
  /** Absolute wall-clock ms — earlier deadline runs first (EDF) after priority (NAT-057). */
  budgetDeadlineMs?: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Sort key for queue ordering + cross-lane pickNext (exported for unit tests). */
export interface ScheduledLaneTaskSortKey {
  priority: number;
  order: number;
  budgetDeadlineMs?: number;
}

/** Higher priority first; then earlier `budgetDeadlineMs` (EDF); then FIFO `order`. */
export function compareScheduledLaneTasks(left: ScheduledLaneTaskSortKey, right: ScheduledLaneTaskSortKey): number {
  if (right.priority !== left.priority) {
    return right.priority - left.priority;
  }
  const ld = left.budgetDeadlineMs;
  const rd = right.budgetDeadlineMs;
  if (ld != null && rd != null && ld !== rd) {
    return ld - rd;
  }
  if (ld != null && rd == null) {
    return -1;
  }
  if (ld == null && rd != null) {
    return 1;
  }
  return left.order - right.order;
}

const LANE_PRIORITY: Record<RuntimeLane, number> = {
  realtime: 4,
  'local-inference': 3,
  semantic: 2,
  background: 1,
};

const DEFAULT_MAX_QUEUE_DEPTH_BY_LANE: Record<RuntimeLane, number> = {
  realtime: 64,
  'local-inference': 128,
  semantic: 256,
  background: 1024,
};

export class RuntimeBudgetScheduler {
  private readonly bus: SupervisorBus;
  private readonly workerPool: WorkerPool | null;
  private readonly laneBudgets: Record<RuntimeLane, LaneBudgetConfig>;
  private readonly maxQueueDepthByLane: Record<RuntimeLane, number>;
  private readonly memoryUsageReader: () => number;
  private readonly logger: Pick<Console, 'warn'>;

  private readonly queues = new Map<RuntimeLane, Array<ScheduledLaneTask<unknown>>>();
  private readonly runningCounts = new Map<RuntimeLane, number>();
  private readonly lastPressure = new Map<RuntimeLane, BudgetPressureLevel | null>();
  private sequence = 0;

  constructor(options: RuntimeBudgetSchedulerOptions = {}) {
    this.bus = options.bus ?? new SupervisorBus();
    this.workerPool = options.workerPool ?? null;
    this.laneBudgets = {
      ...DEFAULT_LANE_BUDGETS,
      ...options.laneBudgets,
    };
    this.maxQueueDepthByLane = {
      ...DEFAULT_MAX_QUEUE_DEPTH_BY_LANE,
      ...(options.maxQueueDepthByLane ?? {}),
    };
    this.memoryUsageReader = options.memoryUsageReader ?? (() => process.memoryUsage().heapUsed);
    this.logger = options.logger ?? console;

    for (const lane of this.getLaneOrder()) {
      this.queues.set(lane, []);
      this.runningCounts.set(lane, 0);
      this.lastPressure.set(lane, null);
    }
  }

  async submit<T>(
    lane: RuntimeLane,
    task: () => Promise<T> | T,
    options: { priority?: number; budgetDeadlineMs?: number } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(lane);
      if (!queue) {
        reject(new Error(`Unknown runtime lane: ${lane}`));
        return;
      }

      if (queue.length >= this.maxQueueDepthByLane[lane]) {
        reject(new Error(`runtime_lane_queue_full:${lane}`));
        return;
      }

      queue.push({
        lane,
        priority: options.priority ?? LANE_PRIORITY[lane],
        order: ++this.sequence,
        budgetDeadlineMs: options.budgetDeadlineMs,
        run: async () => await task(),
        resolve,
        reject,
      });

      queue.sort((left, right) => compareScheduledLaneTasks(left, right));
      this.updatePressure(lane);
      this.pump();
    });
  }

  getLaneStatus(lane: RuntimeLane): RuntimeBudgetLaneStatus {
    const queue = this.queues.get(lane) ?? [];
    return {
      lane,
      running: this.runningCounts.get(lane) ?? 0,
      queued: queue.length,
      budget: this.laneBudgets[lane],
      pressure: this.lastPressure.get(lane) ?? null,
    };
  }

  hasHeadroom(lane: RuntimeLane): boolean {
    const status = this.getLaneStatus(lane);
    const heapUsedMb = this.memoryUsageReader() / (1024 * 1024);
    return (
      status.running < status.budget.maxConcurrent
      && status.queued === 0
      && heapUsedMb < status.budget.memoryCeilingMb * 0.8
    );
  }

  shouldAdmitSpeculation(probability: number, valueOfPrefetch: number, costOfCompute: number): boolean {
    if (!this.hasHeadroom('background')) {
      return false;
    }

    return probability * valueOfPrefetch > costOfCompute;
  }

  private pump(): void {
    for (;;) {
      const next = this.pickNextRunnableTask();
      if (!next) {
        return;
      }

      const queue = this.queues.get(next.lane);
      if (!queue) {
        return;
      }

      queue.shift();
      this.runningCounts.set(next.lane, (this.runningCounts.get(next.lane) ?? 0) + 1);
      this.updatePressure(next.lane);

      const run = async () => {
        try {
          const result = this.workerPool
            ? await this.workerPool.submit({ lane: next.lane, priority: next.priority }, next.run)
            : await next.run();
          next.resolve(result);
        } catch (error) {
          this.logger.warn(`[RuntimeBudgetScheduler] Lane "${next.lane}" task failed:`, error);
          next.reject(error);
        } finally {
          this.runningCounts.set(next.lane, Math.max(0, (this.runningCounts.get(next.lane) ?? 1) - 1));
          this.updatePressure(next.lane);
          this.pump();
        }
      };

      void run();
    }
  }

  private pickNextRunnableTask(): ScheduledLaneTask<unknown> | null {
    let best: ScheduledLaneTask<unknown> | null = null;

    for (const lane of this.getLaneOrder()) {
      const queue = this.queues.get(lane);
      if (!queue || queue.length === 0) {
        continue;
      }

      const budget = this.laneBudgets[lane];
      const running = this.runningCounts.get(lane) ?? 0;
      if (running >= budget.maxConcurrent) {
        continue;
      }

      const candidate = queue[0];
      if (!best || compareScheduledLaneTasks(candidate, best) < 0) {
        best = candidate;
      }
    }

    return best;
  }

  private updatePressure(lane: RuntimeLane): void {
    const nextPressure = this.computePressure(lane);
    const previousPressure = this.lastPressure.get(lane) ?? null;

    if (previousPressure === nextPressure) {
      return;
    }

    this.lastPressure.set(lane, nextPressure);
    if (!nextPressure) {
      return;
    }

    const criticalForegroundLane = this.getCriticalForegroundLane();
    if (nextPressure === 'critical' && lane !== 'background') {
      this.shedBackgroundQueue(`critical pressure on ${lane}`);
    } else if (lane === 'background' && criticalForegroundLane) {
      this.shedBackgroundQueue(`critical pressure on ${criticalForegroundLane}`);
    }

    void this.bus.emit({
      type: 'budget:pressure',
      lane,
      level: nextPressure,
    });
  }

  private computePressure(lane: RuntimeLane): BudgetPressureLevel | null {
    const budget = this.laneBudgets[lane];
    const running = this.runningCounts.get(lane) ?? 0;
    const queued = this.queues.get(lane)?.length ?? 0;
    const heapUsedMb = this.memoryUsageReader() / (1024 * 1024);
    const utilization = budget.memoryCeilingMb > 0 ? heapUsedMb / budget.memoryCeilingMb : 0;

    if (utilization >= 0.8 || (queued > 0 && running >= budget.maxConcurrent && lane !== 'background')) {
      return 'critical';
    }

    if (utilization >= 0.7 || queued > 0) {
      return 'warning';
    }

    return null;
  }

  private shedBackgroundQueue(reason: string): void {
    const backgroundQueue = this.queues.get('background');
    if (!backgroundQueue || backgroundQueue.length === 0) {
      return;
    }

    const drained = backgroundQueue.splice(0, backgroundQueue.length);
    const error = new Error(`background work shed due to ${reason}`);
    for (const task of drained) {
      task.reject(error);
    }
  }

  private getLaneOrder(): RuntimeLane[] {
    return ['realtime', 'local-inference', 'semantic', 'background'];
  }

  private getCriticalForegroundLane(): RuntimeLane | null {
    for (const lane of this.getLaneOrder()) {
      if (lane === 'background') {
        continue;
      }

      if (this.lastPressure.get(lane) === 'critical') {
        return lane;
      }
    }

    return null;
  }
}
