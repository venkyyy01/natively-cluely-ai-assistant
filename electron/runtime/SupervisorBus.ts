import type {
	SupervisorCoreEvent,
	SupervisorEvent,
	SupervisorEventAnyListener,
	SupervisorEventListener,
	SupervisorEventType,
} from "./types";

// Accept loggers that only implement `.error()` (existing call-sites do
// this) and fall back to `console.warn` for the new circuit-breaker
// notice when the supplied logger doesn't carry one.
type BusLogger = Pick<Console, "error"> & Partial<Pick<Console, "warn">>;
type InternalListener = (event: SupervisorEvent) => void | Promise<void>;

/**
 * NAT-020 / audit R-10: previously the bus would throw out of `emit()` if any
 * listener of a critical event (stealth:fault, lifecycle:meeting-starting,
 * lifecycle:meeting-stopping) failed. That meant a single buggy subscriber
 * could abort lifecycle progression for every other subscriber and leak the
 * exception into whatever was awaiting `emit()` (the supervisor itself, in
 * most cases — i.e., the entire startup/shutdown pipeline).
 *
 * The new contract:
 *
 *   - emit() never throws. Listener errors are logged, surfaced as a
 *     `bus:listener-error` synthetic event, and the next listener still
 *     runs.
 *   - A per-listener circuit breaker counts failures inside a sliding
 *     30-second window. Once a single listener crosses
 *     `LISTENER_FAILURE_THRESHOLD` failures inside that window, the bus
 *     auto-unsubscribes it and emits `bus:listener-circuit-open`. The
 *     listener does not get a chance to corrupt subsequent emissions.
 *   - The set of CRITICAL_EVENTS still exists, only as metadata on the
 *     synthetic `bus:listener-error` event so consumers can prioritize.
 */
const CRITICAL_EVENTS = new Set<SupervisorEventType>([
	"stealth:fault",
	"lifecycle:meeting-starting",
	"lifecycle:meeting-stopping",
]);

const LISTENER_FAILURE_THRESHOLD = 3;

export { LISTENER_FAILURE_THRESHOLD };
export const LISTENER_FAILURE_WINDOW_MS = 30_000;

interface ListenerEntry {
	fn: InternalListener;
	failures: number[]; // monotonic timestamps of recent failures
	tripped: boolean;
	trippedAt: number | null;
}

interface AnyListenerEntry {
	fn: SupervisorEventAnyListener;
	failures: number[];
	tripped: boolean;
	trippedAt: number | null;
}

const CIRCUIT_BREAKER_RESET_MS = 60_000;

export class SupervisorBus {
	private readonly listeners = new Map<SupervisorEventType, ListenerEntry[]>();
	private readonly anyListeners: AnyListenerEntry[] = [];
	private readonly logger: BusLogger;
	private readonly now: () => number;

	constructor(
		logger: BusLogger = console,
		now: () => number = () => Date.now(),
	) {
		this.logger = logger;
		this.now = now;
	}

	subscribe<TType extends SupervisorEventType>(
		type: TType,
		listener: SupervisorEventListener<TType>,
	): () => void {
		const entry: ListenerEntry = {
			fn: (event) =>
				listener(event as Extract<SupervisorEvent, { type: TType }>),
			failures: [],
			tripped: false,
			trippedAt: null,
		};
		const typedEntries = this.listeners.get(type) ?? [];
		typedEntries.push(entry);
		this.listeners.set(type, typedEntries);

		return () => {
			const current = this.listeners.get(type);
			if (!current) return;
			const next = current.filter((candidate) => candidate !== entry);
			if (next.length === 0) {
				this.listeners.delete(type);
				return;
			}
			this.listeners.set(type, next);
		};
	}

	subscribeAll(listener: SupervisorEventAnyListener): () => void {
		const entry: AnyListenerEntry = {
			fn: listener,
			failures: [],
			tripped: false,
			trippedAt: null,
		};
		this.anyListeners.push(entry);
		return () => {
			const index = this.anyListeners.indexOf(entry);
			if (index >= 0) {
				this.anyListeners.splice(index, 1);
			}
		};
	}

	/**
	 * NAT-020: never throws. Listener errors are logged, surfaced as a
	 * `bus:listener-error` synthetic event, and circuit-broken if a single
	 * listener trips the failure window threshold.
	 */
	async emit(event: SupervisorEvent): Promise<void> {
		await this.emitInternal(
			event,
			event.type !== "bus:listener-error" &&
				event.type !== "bus:listener-circuit-open",
		);
	}

	private async emitInternal(
		event: SupervisorEvent,
		emitFailureMetaEvent: boolean,
	): Promise<void> {
		const exactEntries = [...(this.listeners.get(event.type) ?? [])];
		const anyEntries = [...this.anyListeners];
		const errors: unknown[] = [];
		const isCriticalEvent = CRITICAL_EVENTS.has(event.type);
		const tripped: Array<{
			scope: "exact" | "any";
			entry: ListenerEntry | AnyListenerEntry;
			lastError: string;
		}> = [];

		const now = this.now();

		for (const entry of exactEntries) {
			if (entry.tripped) {
				// Half-open: allow single test call after reset window
				if (
					entry.trippedAt &&
					now - entry.trippedAt >= CIRCUIT_BREAKER_RESET_MS
				) {
					entry.tripped = false;
					entry.trippedAt = null;
					entry.failures = [];
					const warn =
						this.logger.warn?.bind(this.logger) ?? console.warn.bind(console);
					warn(`[SupervisorBus] Circuit breaker reset for ${event.type}`);
				} else {
					continue;
				}
			}
			try {
				await entry.fn(event);
			} catch (error) {
				const message = errorMessage(error);
				this.logger.error(
					`[SupervisorBus] Listener failed for event ${event.type}:`,
					error,
				);
				errors.push(error);
				if (this.recordFailure(entry, now)) {
					tripped.push({ scope: "exact", entry, lastError: message });
				}
			}
		}

		for (const entry of anyEntries) {
			if (entry.tripped) {
				// Half-open: allow single test call after reset window
				if (
					entry.trippedAt &&
					now - entry.trippedAt >= CIRCUIT_BREAKER_RESET_MS
				) {
					entry.tripped = false;
					entry.trippedAt = null;
					entry.failures = [];
					const warn =
						this.logger.warn?.bind(this.logger) ?? console.warn.bind(console);
					warn(`[SupervisorBus] Circuit breaker reset for global listener`);
				} else {
					continue;
				}
			}
			try {
				await entry.fn(event);
			} catch (error) {
				const message = errorMessage(error);
				this.logger.error(
					`[SupervisorBus] Global listener failed for event ${event.type}:`,
					error,
				);
				errors.push(error);
				if (this.recordFailure(entry, now)) {
					tripped.push({ scope: "any", entry, lastError: message });
				}
			}
		}

		if (errors.length > 0 && emitFailureMetaEvent) {
			const sourceEventType = event.type as Exclude<
				SupervisorEventType,
				"bus:listener-error" | "bus:listener-circuit-open"
			>;
			// Synthetic event must NOT itself rethrow; pass false to suppress recursion.
			await this.emitInternal(
				{
					type: "bus:listener-error",
					sourceEventType,
					failureCount: errors.length,
					messages: errors.map(errorMessage),
					critical: isCriticalEvent,
				},
				false,
			);
		}

		for (const item of tripped) {
			this.unsubscribeTrippedListener(item.scope, item.entry, event.type);
			const sourceEventType =
				event.type === "bus:listener-error" ||
				event.type === "bus:listener-circuit-open"
					? ("any" as const)
					: (event.type as SupervisorCoreEvent["type"]);
			const warn =
				this.logger.warn?.bind(this.logger) ?? console.warn.bind(console);
			warn(
				`[SupervisorBus] Circuit open: listener for ${event.type} unsubscribed after ${LISTENER_FAILURE_THRESHOLD} failures in ${LISTENER_FAILURE_WINDOW_MS}ms`,
			);
			// Fire-and-forget — never block the original emit on the meta event.
			void this.emitInternal(
				{
					type: "bus:listener-circuit-open",
					sourceEventType,
					failureCount: LISTENER_FAILURE_THRESHOLD,
					lastErrorMessage: item.lastError,
				},
				false,
			);
		}
	}

	private recordFailure(
		entry: ListenerEntry | AnyListenerEntry,
		ts: number,
	): boolean {
		const cutoff = ts - LISTENER_FAILURE_WINDOW_MS;
		entry.failures = entry.failures.filter((t) => t >= cutoff);
		entry.failures.push(ts);
		if (entry.failures.length >= LISTENER_FAILURE_THRESHOLD) {
			entry.tripped = true;
			entry.trippedAt = ts;
			return true;
		}
		return false;
	}

	private unsubscribeTrippedListener(
		scope: "exact" | "any",
		entry: ListenerEntry | AnyListenerEntry,
		eventType: SupervisorEventType,
	): void {
		if (scope === "any") {
			const idx = this.anyListeners.indexOf(entry as AnyListenerEntry);
			if (idx >= 0) this.anyListeners.splice(idx, 1);
			return;
		}
		const current = this.listeners.get(eventType);
		if (!current) return;
		const next = current.filter((candidate) => candidate !== entry);
		if (next.length === 0) {
			this.listeners.delete(eventType);
		} else {
			this.listeners.set(eventType, next);
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
