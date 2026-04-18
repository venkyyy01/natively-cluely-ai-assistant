import { SupervisorBus } from '../runtime/SupervisorBus';

export interface TieredMemoryEntry<TValue = unknown> {
  id: string;
  sizeBytes: number;
  value: TValue;
  createdAt: number;
}

export interface TieredMemorySnapshot<TValue = unknown> {
  hot: TieredMemoryEntry<TValue>[];
  warm: TieredMemoryEntry<TValue>[];
  cold: TieredMemoryEntry<TValue>[];
}

interface TieredMemoryManagerOptions<TValue> {
  bus?: SupervisorBus;
  hotCeilingBytes?: number;
  warmCeilingBytes?: number;
  persistCold?: (entries: TieredMemoryEntry<TValue>[]) => Promise<void> | void;
}

export class TieredMemoryManager<TValue = unknown> {
  private readonly bus: SupervisorBus;
  private readonly hotCeilingBytes: number;
  private readonly warmCeilingBytes: number;
  private readonly persistCold?: (entries: TieredMemoryEntry<TValue>[]) => Promise<void> | void;

  private hotEntries: TieredMemoryEntry<TValue>[] = [];
  private warmEntries: TieredMemoryEntry<TValue>[] = [];
  private coldEntries: TieredMemoryEntry<TValue>[] = [];

  constructor(options: TieredMemoryManagerOptions<TValue> = {}) {
    this.bus = options.bus ?? new SupervisorBus();
    this.hotCeilingBytes = options.hotCeilingBytes ?? 50 * 1024 * 1024;
    this.warmCeilingBytes = options.warmCeilingBytes ?? 100 * 1024 * 1024;
    this.persistCold = options.persistCold;

    this.bus.subscribe('budget:pressure', async (event) => {
      if (event.level === 'critical') {
        await this.compact();
      }
    });
  }

  async addHotEntry(entry: Omit<TieredMemoryEntry<TValue>, 'createdAt'> & { createdAt?: number }): Promise<void> {
    this.hotEntries.push({
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
    });
    await this.enforceCeilings();
  }

  getHotState(): TieredMemoryEntry<TValue>[] {
    return [...this.hotEntries];
  }

  getWarmState(): TieredMemoryEntry<TValue>[] {
    return [...this.warmEntries];
  }

  getColdState(): TieredMemoryEntry<TValue>[] {
    return [...this.coldEntries];
  }

  async compact(): Promise<void> {
    await this.enforceCeilings(true);
  }

  getSnapshot(): TieredMemorySnapshot<TValue> {
    return {
      hot: this.getHotState(),
      warm: this.getWarmState(),
      cold: this.getColdState(),
    };
  }

  private async enforceCeilings(force = false): Promise<void> {
    while (this.getTotalBytes(this.hotEntries) > this.hotCeilingBytes) {
      const demoted = this.hotEntries.shift();
      if (!demoted) {
        break;
      }

      this.warmEntries.push(demoted);
    }

    if (force && this.hotEntries.length > 1) {
      while (this.hotEntries.length > 1) {
        const demoted = this.hotEntries.shift();
        if (!demoted) {
          break;
        }
        this.warmEntries.push(demoted);
      }
    }

    const coldBatch: TieredMemoryEntry<TValue>[] = [];
    while (this.getTotalBytes(this.warmEntries) > this.warmCeilingBytes) {
      const demoted = this.warmEntries.shift();
      if (!demoted) {
        break;
      }

      this.coldEntries.push(demoted);
      coldBatch.push(demoted);
    }

    if (coldBatch.length > 0) {
      await this.persistCold?.(coldBatch);
    }
  }

  private getTotalBytes(entries: TieredMemoryEntry<TValue>[]): number {
    return entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  }
}
