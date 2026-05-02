// electron/streaming/StreamTokenBatcher.ts
//
// NAT-019 / audit R-7: micro-batcher for the per-token IPC path.
// Extracted as a pure helper so the policy is unit-testable without
// standing up an Electron browser-window. The IPC handler in
// `electron/ipcHandlers.ts` re-implements the same logic inline against
// `event.sender.send` for brevity, but if you change the policy here
// please update the inline copy at the same time.
//
// Policy:
//   - Buffer tokens until either MAX_TOKENS have accumulated OR
//     INTERVAL_MS has elapsed since the last flush.
//   - Every flush checks an `isDestroyed()` callback first; on destroyed,
//     the batcher transitions to `aborted` and refuses further work.
//   - The cap (1000 / 16 ms = 62.5 sends/sec) is the audit's stated
//     ceiling of <= 64 IPC sends per second per stream.

export interface StreamTokenBatcherOptions {
	/** Max time (ms) a token can sit in the buffer before forcing a flush. */
	intervalMs?: number;
	/** Max tokens the buffer holds before forcing a flush. */
	maxTokens?: number;
	/** Sink that receives a coalesced batch (one IPC send per call). */
	send: (chunk: string) => void;
	/** Returns true if the downstream sink is gone (e.g., renderer destroyed). */
	isDestroyed: () => boolean;
	/** Optional clock injection for deterministic tests. */
	now?: () => number;
}

export interface StreamTokenBatcherStats {
	tokens: number;
	sends: number;
	aborted: boolean;
}

export const STREAM_TOKEN_BATCHER_DEFAULTS = Object.freeze({
	INTERVAL_MS: 16,
	MAX_TOKENS: 32,
});

export class StreamTokenBatcher {
	private readonly intervalMs: number;
	private readonly maxTokens: number;
	private readonly send: (chunk: string) => void;
	private readonly isDestroyed: () => boolean;
	private readonly now: () => number;

	private buffer = "";
	private bufferedTokens = 0;
	private lastFlushAt: number;
	private sendCount = 0;
	private tokenCount = 0;
	private aborted = false;

	constructor(opts: StreamTokenBatcherOptions) {
		this.intervalMs = Math.max(
			1,
			opts.intervalMs ?? STREAM_TOKEN_BATCHER_DEFAULTS.INTERVAL_MS,
		);
		this.maxTokens = Math.max(
			1,
			opts.maxTokens ?? STREAM_TOKEN_BATCHER_DEFAULTS.MAX_TOKENS,
		);
		this.send = opts.send;
		this.isDestroyed = opts.isDestroyed;
		this.now = opts.now ?? (() => Date.now());
		this.lastFlushAt = this.now();
	}

	/**
	 * Push the next token into the buffer. Returns `true` if the consumer
	 * loop should continue, `false` if the sink has been destroyed.
	 */
	push(token: string): boolean {
		if (this.aborted) return false;
		if (this.isDestroyed()) {
			this.aborted = true;
			return false;
		}
		this.buffer += token;
		this.bufferedTokens += 1;
		this.tokenCount += 1;
		if (
			this.bufferedTokens >= this.maxTokens ||
			this.now() - this.lastFlushAt >= this.intervalMs
		) {
			return this.flush();
		}
		return true;
	}

	/** Force a flush of any buffered tokens. Returns false if aborted. */
	flush(): boolean {
		if (this.aborted) return false;
		if (this.buffer.length === 0) return true;
		if (this.isDestroyed()) {
			this.aborted = true;
			return false;
		}
		this.send(this.buffer);
		this.buffer = "";
		this.bufferedTokens = 0;
		this.lastFlushAt = this.now();
		this.sendCount += 1;
		return true;
	}

	isAborted(): boolean {
		return this.aborted;
	}

	getStats(): StreamTokenBatcherStats {
		return {
			tokens: this.tokenCount,
			sends: this.sendCount,
			aborted: this.aborted,
		};
	}
}
