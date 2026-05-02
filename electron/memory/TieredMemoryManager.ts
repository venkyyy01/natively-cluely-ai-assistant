import { Metrics } from "../runtime/Metrics";
import { SupervisorBus } from "../runtime/SupervisorBus";

// NAT-013 / audit R-1: even if `persistCold` succeeds, we used to leave the
// persisted entries on the in-memory `coldEntries` array forever. On a long
// session this is an unbounded leak. The fix is two-pronged:
//   1. After a successful persist, drop the persisted batch from memory.
//   2. As a defence in depth (e.g. `persistCold` is undefined or throws),
//      enforce a hard ceiling on how many cold rows we keep in RAM.
const MAX_COLD_IN_MEMORY = 1024;

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
	private readonly persistCold?: (
		entries: TieredMemoryEntry<TValue>[],
	) => Promise<void> | void;

	private hotEntries: TieredMemoryEntry<TValue>[] = [];
	private warmEntries: TieredMemoryEntry<TValue>[] = [];
	private coldEntries: TieredMemoryEntry<TValue>[] = [];

	constructor(options: TieredMemoryManagerOptions<TValue> = {}) {
		this.bus = options.bus ?? new SupervisorBus();
		this.hotCeilingBytes = options.hotCeilingBytes ?? 50 * 1024 * 1024;
		this.warmCeilingBytes = options.warmCeilingBytes ?? 100 * 1024 * 1024;
		this.persistCold = options.persistCold;

		this.bus.subscribe("budget:pressure", async (event) => {
			if (event.level === "critical") {
				await this.compact();
			}
		});
	}

	async addHotEntry(
		entry: Omit<TieredMemoryEntry<TValue>, "createdAt"> & {
			createdAt?: number;
		},
	): Promise<void> {
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
		const cold = [...this.coldEntries];
		Metrics.gauge("cold_tier.entries_in_memory", cold.length);
		return cold;
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
			let persisted = false;
			try {
				await this.persistCold?.(coldBatch);
				// We only evict from memory when a sink was actually configured.
				// Without a sink there is nowhere safe to drop these to, and the
				// hard cap below acts as the eventual safety net.
				persisted = this.persistCold !== undefined;
			} catch (error) {
				// Swallow and let the hard cap handle pressure on the next pass.
				// Logging is the only observability surface available here; the
				// SupervisorBus event union does not yet include a memory-persist
				// failure variant.
				console.warn(
					"[TieredMemoryManager] persistCold failed; relying on MAX_COLD_IN_MEMORY cap:",
					error instanceof Error ? error.message : error,
				);
			}

			if (persisted) {
				this.removeFromCold(coldBatch);
			}
		}

		// Hard cap: drop the oldest cold entries above MAX_COLD_IN_MEMORY no
		// matter what persistCold did. This guarantees `coldEntries.length`
		// is bounded across long sessions even if the sink is missing or slow.
		if (this.coldEntries.length > MAX_COLD_IN_MEMORY) {
			const overflow = this.coldEntries.length - MAX_COLD_IN_MEMORY;
			const dropped = this.coldEntries.splice(0, overflow);
			console.warn(
				`[TieredMemoryManager] dropped ${dropped.length} cold entries to honor MAX_COLD_IN_MEMORY=${MAX_COLD_IN_MEMORY}`,
			);
		}
	}

	private removeFromCold(batch: TieredMemoryEntry<TValue>[]): void {
		if (batch.length === 0) return;
		const persistedIds = new Set(batch.map((entry) => entry.id));
		this.coldEntries = this.coldEntries.filter(
			(entry) => !persistedIds.has(entry.id),
		);
	}

	private getTotalBytes(entries: TieredMemoryEntry<TValue>[]): number {
		return entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
	}
}
