/**
 * RateLimiter - Token bucket rate limiter for LLM API calls
 * Prevents 429 errors on free-tier API plans by queuing requests
 * when the bucket is empty.
 */
export class RateLimiter {
	private tokens: number;
	private readonly maxTokens: number;
	private readonly refillRatePerSecond: number;
	private lastRefillTime: number;
	private waitQueue: Array<() => void> = [];
	private refillTimer: ReturnType<typeof setInterval> | null = null;
	private readonly maxQueueSize: number;

	/**
	 * @param maxTokens - Maximum burst capacity (e.g. 30 for Groq free tier)
	 * @param refillRatePerSecond - Tokens added per second (e.g. 0.5 = 30/min)
	 */
	constructor(
		maxTokens: number,
		refillRatePerSecond: number,
		maxQueueSize: number = 100,
	) {
		this.maxTokens = maxTokens;
		this.tokens = maxTokens;
		this.refillRatePerSecond = refillRatePerSecond;
		this.lastRefillTime = Date.now();
		this.maxQueueSize = maxQueueSize;

		// Refill tokens periodically
		this.refillTimer = setInterval(() => this.refill(), 1000);
	}

	/**
	 * Acquire a token. Resolves immediately if available, otherwise waits.
	 */
	public async acquire(timeoutMs: number = 30000): Promise<void> {
		this.refill();

		if (this.tokens >= 1) {
			this.tokens -= 1;
			return;
		}

		// Wait for a token to become available
		if (this.waitQueue.length >= this.maxQueueSize) {
			throw new Error("Rate limiter queue is full");
		}

		return new Promise<void>((resolve, reject) => {
			const wrapped = () => {
				clearTimeout(timeoutHandle);
				resolve();
			};
			const timeoutHandle = setTimeout(() => {
				const index = this.waitQueue.indexOf(wrapped);
				if (index !== -1) {
					this.waitQueue.splice(index, 1);
				}
				reject(new Error("Rate limiter timeout"));
			}, timeoutMs);

			this.waitQueue.push(wrapped);
		});
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefillTime) / 1000;
		const newTokens = elapsed * this.refillRatePerSecond;

		if (newTokens >= 1) {
			this.tokens = Math.min(
				this.maxTokens,
				this.tokens + Math.floor(newTokens),
			);
			this.lastRefillTime = now;

			// Wake up waiting requests
			while (this.waitQueue.length > 0 && this.tokens >= 1) {
				this.tokens -= 1;
				const resolve = this.waitQueue.shift()!;
				resolve();
			}
		}
	}

	public destroy(): void {
		if (this.refillTimer) {
			clearInterval(this.refillTimer);
			this.refillTimer = null;
		}
		// Release all waiting requests
		while (this.waitQueue.length > 0) {
			const resolve = this.waitQueue.shift()!;
			resolve();
		}
	}
}

/**
 * Pre-configured rate limiters for known providers.
 * These match documented free-tier limits.
 */
export function createProviderRateLimiters() {
	return {
		groq: new RateLimiter(20, 0.5), // 30 req/min with burst room
		cerebras: new RateLimiter(120, 2.0), // Similar shared-endpoint budget to other cloud providers
		gemini: new RateLimiter(120, 2.0), // 120 req/min
		openai: new RateLimiter(120, 2.0), // 120 req/min
		claude: new RateLimiter(120, 2.0), // 120 req/min
	};
}
