/**
 * AsyncMutex - A proper async mutex implementation for preventing race conditions
 *
 * Unlike simple boolean flags, this provides true mutual exclusion for async operations
 * with proper queuing and timeout support.
 */

interface AsyncMutexOptions {
	timeout?: number; // Max time to wait for lock in ms
	name?: string; // For debugging/logging
}

interface QueuedOperation {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	timeout?: NodeJS.Timeout;
	timestamp: number;
}

export class AsyncMutex {
	private locked = false;
	private queue: QueuedOperation[] = [];
	private readonly options: Required<AsyncMutexOptions>;

	constructor(options: AsyncMutexOptions = {}) {
		this.options = {
			timeout: options.timeout || 30000, // 30 second default timeout
			name: options.name || "AsyncMutex",
		};
	}

	/**
	 * Acquire the mutex lock. Returns a release function that must be called.
	 *
	 * @returns Promise<() => void> - The release function
	 * @throws Error if timeout is reached or mutex is destroyed
	 */
	async acquire(): Promise<() => void> {
		return new Promise((resolve, reject) => {
			const operation: QueuedOperation = {
				resolve,
				reject,
				timestamp: Date.now(),
			};

			// Set up timeout
			if (this.options.timeout > 0) {
				operation.timeout = setTimeout(() => {
					this.removeFromQueue(operation);
					reject(
						new Error(
							`${this.options.name} acquire timeout after ${this.options.timeout}ms`,
						),
					);
				}, this.options.timeout);
			}

			this.queue.push(operation);
			this.processQueue();
		});
	}

	/**
	 * Try to acquire the lock without waiting. Returns null if already locked.
	 *
	 * @returns (() => void) | null - The release function or null if locked
	 */
	tryAcquire(): (() => void) | null {
		if (this.locked) {
			return null;
		}

		this.locked = true;
		let released = false;

		return () => {
			if (released) {
				console.warn(`${this.options.name}: Release called multiple times`);
				return;
			}
			released = true;
			this.locked = false;
			this.processQueue();
		};
	}

	/**
	 * Execute a function while holding the mutex lock
	 *
	 * @param fn - Function to execute
	 * @returns Promise<T> - Result of the function
	 */
	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * Check if the mutex is currently locked
	 */
	isLocked(): boolean {
		return this.locked;
	}

	/**
	 * Get the number of operations waiting in the queue
	 */
	getQueueLength(): number {
		return this.queue.length;
	}

	/**
	 * Get statistics about the mutex
	 */
	getStats() {
		const now = Date.now();
		return {
			isLocked: this.locked,
			queueLength: this.queue.length,
			oldestWaiting: this.queue.length > 0 ? now - this.queue[0].timestamp : 0,
			name: this.options.name,
		};
	}

	/**
	 * Cancel all waiting operations and clear the queue
	 */
	destroy(reason = "Mutex destroyed") {
		while (this.queue.length > 0) {
			const operation = this.queue.shift()!;
			if (operation.timeout) {
				clearTimeout(operation.timeout);
			}
			operation.reject(new Error(`${this.options.name}: ${reason}`));
		}
		this.locked = false;
	}

	private processQueue() {
		if (this.locked || this.queue.length === 0) {
			return;
		}

		const operation = this.queue.shift()!;

		if (operation.timeout) {
			clearTimeout(operation.timeout);
		}

		this.locked = true;
		let released = false;

		const release = () => {
			if (released) {
				console.warn(`${this.options.name}: Release called multiple times`);
				return;
			}
			released = true;
			this.locked = false;

			// Process next operation in queue
			setImmediate(() => this.processQueue());
		};

		operation.resolve(release);
	}

	private removeFromQueue(targetOperation: QueuedOperation) {
		const index = this.queue.indexOf(targetOperation);
		if (index !== -1) {
			this.queue.splice(index, 1);
			if (targetOperation.timeout) {
				clearTimeout(targetOperation.timeout);
			}
		}
	}
}

/**
 * Utility function to create a named mutex with common options
 */
export function createMutex(name: string, timeout = 30000): AsyncMutex {
	return new AsyncMutex({ name, timeout });
}

/**
 * Decorator for methods that should run exclusively
 */
export function exclusive(mutex: AsyncMutex) {
	return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: any[]) {
			return mutex.runExclusive(() => originalMethod.apply(this, args));
		};

		return descriptor;
	};
}
