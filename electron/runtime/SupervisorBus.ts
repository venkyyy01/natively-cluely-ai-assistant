import type {
  SupervisorEvent,
  SupervisorEventAnyListener,
  SupervisorEventListener,
  SupervisorEventType,
} from './types';

type BusLogger = Pick<Console, 'error'>;
type InternalListener = (event: SupervisorEvent) => void | Promise<void>;

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
    const exactListeners = [...(this.listeners.get(event.type) ?? [])];
    const anyListeners = [...this.anyListeners];

    for (const listener of exactListeners) {
      await this.invokeListener(listener, event);
    }

    for (const listener of anyListeners) {
      await this.invokeListener(listener, event);
    }
  }

  private async invokeListener(
    listener: InternalListener | SupervisorEventAnyListener,
    event: SupervisorEvent,
  ): Promise<void> {
    try {
      await listener(event);
    } catch (error) {
      this.logger.error(`[SupervisorBus] Listener failed for event ${event.type}:`, error);
    }
  }
}
