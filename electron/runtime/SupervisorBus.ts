import type {
  SupervisorEvent,
  SupervisorEventAnyListener,
  SupervisorEventListener,
  SupervisorEventType,
} from './types';

type BusLogger = Pick<Console, 'error'>;
type InternalListener = (event: SupervisorEvent) => void | Promise<void>;
const CRITICAL_EVENTS = new Set<SupervisorEventType>([
  'stealth:fault',
  'lifecycle:meeting-starting',
  'lifecycle:meeting-stopping',
]);

export class SupervisorBus {
  private readonly listeners = new Map<SupervisorEventType, InternalListener[]>();
  private readonly anyListeners: SupervisorEventAnyListener[] = [];
  private readonly logger: BusLogger;

  constructor(logger: BusLogger = console) {
    this.logger = logger;
  }

  subscribe<TType extends SupervisorEventType>(
    type: TType,
    listener: SupervisorEventListener<TType>,
  ): () => void {
    const typedListeners = this.listeners.get(type) ?? [];
    const internalListener: InternalListener = (event) => listener(event as Extract<SupervisorEvent, { type: TType }>);
    typedListeners.push(internalListener);
    this.listeners.set(type, typedListeners);

    return () => {
      const currentListeners = this.listeners.get(type);
      if (!currentListeners) {
        return;
      }

      const nextListeners = currentListeners.filter(
        (candidate) => candidate !== internalListener,
      );

      if (nextListeners.length === 0) {
        this.listeners.delete(type);
        return;
      }

      this.listeners.set(type, nextListeners);
    };
  }

  subscribeAll(listener: SupervisorEventAnyListener): () => void {
    this.anyListeners.push(listener);

    return () => {
      const index = this.anyListeners.indexOf(listener);
      if (index >= 0) {
        this.anyListeners.splice(index, 1);
      }
    };
  }

  async emit(event: SupervisorEvent): Promise<void> {
    await this.emitInternal(event, event.type !== 'bus:listener-error');
  }

  private async emitInternal(event: SupervisorEvent, emitFailureMetaEvent: boolean): Promise<void> {
    const exactListeners = [...(this.listeners.get(event.type) ?? [])];
    const anyListeners = [...this.anyListeners];
    const errors: unknown[] = [];
    const isCriticalEvent = CRITICAL_EVENTS.has(event.type);

    for (const listener of exactListeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error(`[SupervisorBus] Listener failed for event ${event.type}:`, error);
        errors.push(error);
      }
    }

    for (const listener of anyListeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error(`[SupervisorBus] Global listener failed for event ${event.type}:`, error);
        errors.push(error);
      }
    }

    if (errors.length > 0 && emitFailureMetaEvent) {
      const sourceEventType = event.type as Exclude<SupervisorEventType, 'bus:listener-error'>;
      await this.emitInternal({
        type: 'bus:listener-error',
        sourceEventType,
        failureCount: errors.length,
        messages: errors.map((error) => error instanceof Error ? error.message : String(error)),
        critical: isCriticalEvent,
      }, false);
    }

    if (errors.length > 0 && isCriticalEvent) {
      throw new Error(
        `Critical SupervisorBus event "${event.type}" had listener failures: ${errors
          .map((error) => error instanceof Error ? error.message : String(error))
          .join(', ')}`,
      );
    }
  }
}
