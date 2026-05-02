import { EventEmitter } from "node:events";

export type Speaker = "interviewer" | "user";
export type ProviderHealthState = "healthy" | "degraded" | "down";

export interface ProviderHealthSnapshot {
	state: ProviderHealthState;
	retryCount: number;
	recentErrorCount: number;
	cooldownRemainingMs: number;
}

interface STTReconnectorOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	errorWindowMs?: number;
	requiredErrorCount?: number;
	cooldownMs?: number;
	now?: () => number;
	setTimeoutFn?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (timeout: ReturnType<typeof setTimeout>) => void;
}

export class STTReconnector extends EventEmitter {
	private readonly maxRetries: number;
	private readonly baseDelayMs: number;
	private readonly errorWindowMs: number;
	private readonly requiredErrorCount: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private readonly setTimeoutFn: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	private readonly clearTimeoutFn: (
		timeout: ReturnType<typeof setTimeout>,
	) => void;
	private readonly retryCounts = new Map<Speaker, number>();
	private readonly errorTimestamps = new Map<Speaker, number[]>();
	private readonly timeouts = new Map<Speaker, ReturnType<typeof setTimeout>>();
	private readonly cooldownUntil = new Map<Speaker, number>();
	private readonly healthStates = new Map<Speaker, ProviderHealthState>([
		["interviewer", "healthy"],
		["user", "healthy"],
	]);

	constructor(
		private readonly reconnectFn: (speaker: Speaker) => Promise<void> | void,
		options: STTReconnectorOptions = {},
	) {
		super();
		this.maxRetries = options.maxRetries ?? 3;
		this.baseDelayMs = options.baseDelayMs ?? 1000;
		this.errorWindowMs = options.errorWindowMs ?? 30_000;
		this.requiredErrorCount = options.requiredErrorCount ?? 1;
		this.cooldownMs = options.cooldownMs ?? 30_000;
		this.now = options.now ?? Date.now;
		this.setTimeoutFn =
			options.setTimeoutFn ??
			((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimeoutFn =
			options.clearTimeoutFn ?? ((timeout) => clearTimeout(timeout));
	}

	public onError(speaker: Speaker): void {
		const now = this.now();
		if (this.isCoolingDown(speaker, now)) {
			return;
		}

		const recent = (this.errorTimestamps.get(speaker) ?? []).filter(
			(timestamp) => now - timestamp <= this.errorWindowMs,
		);
		recent.push(now);
		this.errorTimestamps.set(speaker, recent);

		if (recent.length < this.requiredErrorCount || this.timeouts.has(speaker)) {
			return;
		}

		this.setHealthState(speaker, "degraded");
		this.scheduleReconnect(speaker);
	}

	public reset(speaker: Speaker): void {
		this.retryCounts.set(speaker, 0);
		this.errorTimestamps.delete(speaker);
		this.cooldownUntil.delete(speaker);
		this.setHealthState(speaker, "healthy");
		const timeout = this.timeouts.get(speaker);
		if (timeout) {
			this.clearTimeoutFn(timeout);
			this.timeouts.delete(speaker);
		}
	}

	public stopAll(): void {
		for (const timeout of this.timeouts.values()) {
			this.clearTimeoutFn(timeout);
		}
		this.timeouts.clear();
		this.retryCounts.clear();
		this.errorTimestamps.clear();
		this.cooldownUntil.clear();
		this.setHealthState("interviewer", "healthy");
		this.setHealthState("user", "healthy");
	}

	public getProviderHealth(speaker: Speaker): ProviderHealthSnapshot {
		const now = this.now();
		const cooldownRemainingMs = Math.max(
			0,
			(this.cooldownUntil.get(speaker) ?? 0) - now,
		);
		const recentErrorCount = (this.errorTimestamps.get(speaker) ?? []).filter(
			(timestamp) => now - timestamp <= this.errorWindowMs,
		).length;

		return {
			state: this.healthStates.get(speaker) ?? "healthy",
			retryCount: this.retryCounts.get(speaker) ?? 0,
			recentErrorCount,
			cooldownRemainingMs,
		};
	}

	private scheduleReconnect(speaker: Speaker): void {
		const retryCount = this.retryCounts.get(speaker) ?? 0;
		if (retryCount >= this.maxRetries) {
			this.markProviderDown(speaker, retryCount);
			return;
		}

		const attempt = retryCount + 1;
		const delayMs = this.baseDelayMs * 2 ** retryCount;
		this.retryCounts.set(speaker, attempt);
		this.emit("reconnecting", { speaker, attempt, delayMs });

		const timeout = this.setTimeoutFn(async () => {
			this.timeouts.delete(speaker);
			try {
				await this.reconnectFn(speaker);
				this.errorTimestamps.delete(speaker);
				this.retryCounts.set(speaker, 0);
				this.cooldownUntil.delete(speaker);
				this.setHealthState(speaker, "healthy");
				this.emit("reconnected", { speaker, attempt });
			} catch (error) {
				if (attempt >= this.maxRetries) {
					this.markProviderDown(speaker, attempt, error);
					return;
				}

				this.setHealthState(speaker, "degraded");
				this.scheduleReconnect(speaker);
			}
		}, delayMs);

		this.timeouts.set(speaker, timeout);
	}

	private markProviderDown(
		speaker: Speaker,
		attempts: number,
		error?: unknown,
	): void {
		const now = this.now();
		const cooldownUntil = now + this.cooldownMs;
		this.cooldownUntil.set(speaker, cooldownUntil);
		this.retryCounts.set(speaker, 0);
		this.errorTimestamps.delete(speaker);
		this.setHealthState(speaker, "down");
		this.emit("exhausted", { speaker, attempts, error, cooldownUntil });
	}

	private isCoolingDown(speaker: Speaker, now: number): boolean {
		const cooldownUntil = this.cooldownUntil.get(speaker);
		if (!cooldownUntil) {
			return false;
		}

		if (cooldownUntil <= now) {
			this.cooldownUntil.delete(speaker);
			return false;
		}

		return true;
	}

	private setHealthState(speaker: Speaker, state: ProviderHealthState): void {
		const previous = this.healthStates.get(speaker) ?? "healthy";
		if (previous === state) {
			return;
		}

		this.healthStates.set(speaker, state);
		this.emit("health-changed", { speaker, from: previous, to: state });
	}
}
