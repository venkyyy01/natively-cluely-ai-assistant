import type { RuntimeLane } from '../config/optimizations';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';

/**
 * A handler registered with the StealthTickCoordinator.
 * Dispatched every (cadence × baseTickMs) milliseconds on the specified lane.
 */
export interface TickHandler {
  /** Unique identifier for this handler */
  id: string;
  /** Cadence as a multiple of 250ms base tick (1-240) */
  cadence: number;
  /** Target lane for execution */
  lane: RuntimeLane;
  /** The function to execute */
  fn: () => Promise<void> | void;
}

export interface StealthTickCoordinatorOptions {
  /** RuntimeBudgetScheduler for lane-aware dispatch */
  budgetScheduler: RuntimeBudgetScheduler;
  /** Base tick interval in ms (default: 250) */
  baseTickMs?: number;
  /** Logger */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** Minimum valid cadence value */
const MIN_CADENCE = 1;
/** Maximum valid cadence value */
const MAX_CADENCE = 240;

/**
 * Central tick coordinator that replaces independent setInterval calls
 * with a single 250ms base-tick scheduler. Handlers are dispatched at
 * their configured cadences via the RuntimeBudgetScheduler.
 */
export class StealthTickCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private readonly handlers: Map<string, TickHandler> = new Map();
  private readonly executing: Set<string> = new Set();
  private readonly pendingRegistrations: TickHandler[] = [];
  private readonly pendingDeregistrations: string[] = [];
  private dispatching = false;
  private started = false;

  private readonly budgetScheduler: RuntimeBudgetScheduler;
  private readonly baseTickMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(options: StealthTickCoordinatorOptions) {
    this.budgetScheduler = options.budgetScheduler;
    this.baseTickMs = options.baseTickMs ?? 250;
    this.logger = options.logger ?? console;
  }

  /**
   * Register a handler. Rejects if cadence is outside [1, 240].
   * Safe to call during a dispatch cycle — deferred until dispatch completes.
   */
  register(handler: TickHandler): void {
    if (handler.cadence < MIN_CADENCE || handler.cadence > MAX_CADENCE) {
      throw new RangeError(
        `Invalid cadence ${handler.cadence}: must be between ${MIN_CADENCE} and ${MAX_CADENCE}`,
      );
    }

    if (this.dispatching) {
      this.pendingRegistrations.push(handler);
      return;
    }

    this.handlers.set(handler.id, handler);
  }

  /**
   * Deregister a handler by id.
   * Safe to call during a dispatch cycle — deferred until dispatch completes.
   */
  deregister(id: string): void {
    if (this.dispatching) {
      this.pendingDeregistrations.push(id);
      return;
    }

    this.handlers.delete(id);
    this.executing.delete(id);
  }

  /** Start the base tick timer. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => this.tick(), this.baseTickMs);
  }

  /** Stop the base tick timer. Idempotent. Completes current dispatch. */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns true if the coordinator is running */
  isRunning(): boolean {
    return this.started;
  }

  /** Returns the current tick count (for testing) */
  getTickCount(): number {
    return this.tickCount;
  }

  /** Returns registered handler count (for testing) */
  getHandlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Core tick dispatch. Called every baseTickMs.
   * Dispatches handlers sequentially within a tick (Property 14):
   * no two handlers from the same tick execute concurrently.
   */
  private tick(): void {
    this.tickCount++;
    this.dispatching = true;

    try {
      // Collect handlers due for this tick
      const dueHandlers: TickHandler[] = [];
      for (const handler of this.handlers.values()) {
        if (this.tickCount % handler.cadence === 0) {
          dueHandlers.push(handler);
        }
      }

      // Sequential dispatch within a tick (Property 14)
      // Chain handler executions so they run one after another
      let chain: Promise<void> = Promise.resolve();

      for (const handler of dueHandlers) {
        // Per-id serialization: skip if already executing (Property 2)
        if (this.executing.has(handler.id)) {
          continue;
        }

        // Check handler is still registered
        if (!this.handlers.has(handler.id)) {
          continue;
        }

        // Mark as executing before submission (atomic flag, Property 1B.5)
        this.executing.add(handler.id);

        const handlerId = handler.id;
        const handlerFn = handler.fn;
        const handlerLane = handler.lane;

        chain = chain.then(() =>
          this.budgetScheduler
            .submit(handlerLane, async () => {
              try {
                await handlerFn();
              } catch (err) {
                // Error isolation: log and continue (Property 4)
                this.logger.error(
                  `[StealthTickCoordinator] Handler "${handlerId}" threw:`,
                  err,
                );
              } finally {
                // Release per-id lock
                this.executing.delete(handlerId);
              }
            })
            .catch((err) => {
              // Lane submission failure — release lock and log
              this.executing.delete(handlerId);
              this.logger.error(
                `[StealthTickCoordinator] Lane submission failed for "${handlerId}":`,
                err,
              );
            }),
        );
      }

      // After all handlers in this tick complete, flush pending mutations
      void chain.then(() => {
        this.dispatching = false;
        this.flushPendingMutations();
      });
    } catch {
      this.dispatching = false;
      this.flushPendingMutations();
    }
  }

  /**
   * Apply pending registrations and deregistrations that occurred during dispatch.
   */
  private flushPendingMutations(): void {
    // Process deregistrations first to avoid re-registering then immediately removing
    while (this.pendingDeregistrations.length > 0) {
      const id = this.pendingDeregistrations.shift()!;
      this.handlers.delete(id);
      this.executing.delete(id);
    }

    // Process registrations
    while (this.pendingRegistrations.length > 0) {
      const handler = this.pendingRegistrations.shift()!;
      this.handlers.set(handler.id, handler);
    }
  }
}
