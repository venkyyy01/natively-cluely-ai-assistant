type ShutdownHook = () => Promise<void>;

class GracefulShutdownManager {
	private static instance: GracefulShutdownManager | null = null;
	private hooks: Array<{ name: string; fn: ShutdownHook }> = [];
	private shuttingDown = false;
	private shutdownPromise: Promise<never> | null = null;

	static getInstance(): GracefulShutdownManager {
		if (!GracefulShutdownManager.instance) {
			GracefulShutdownManager.instance = new GracefulShutdownManager();
		}
		return GracefulShutdownManager.instance;
	}

	/**
	 * Register a cleanup hook. Hooks run in registration order.
	 * Each hook has 2s to complete before it is abandoned.
	 */
	register(name: string, fn: ShutdownHook): void {
		this.hooks.push({ name, fn });
	}

	/**
	 * Run all hooks then exit. Safe to call multiple times — only
	 * the first call executes; subsequent calls wait for the first.
	 */
	async shutdown(code: number, reason: string): Promise<never> {
		if (this.shuttingDown) {
			if (this.shutdownPromise) {
				return this.shutdownPromise;
			}
			// Fallback: hard exit after 5s
			await new Promise((r) => setTimeout(r, 5000));
			process.exit(code);
		}
		this.shuttingDown = true;
		this.shutdownPromise = this._runShutdown(code, reason);
		return this.shutdownPromise;
	}

	private async _runShutdown(code: number, reason: string): Promise<never> {
		console.error(`[GracefulShutdown] Initiating (code=${code}): ${reason}`);

		const HOOK_TIMEOUT_MS = 2000;
		for (const hook of this.hooks) {
			try {
				await Promise.race([
					hook.fn(),
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error("timeout")), HOOK_TIMEOUT_MS),
					),
				]);
				console.log(`[GracefulShutdown] Hook "${hook.name}" done`);
			} catch (err) {
				console.error(
					`[GracefulShutdown] Hook "${hook.name}" failed/timed-out:`,
					err,
				);
			}
		}

		console.error(`[GracefulShutdown] Exiting with code ${code}`);
		process.exit(code);
	}
}

export const gracefulShutdown = GracefulShutdownManager.getInstance();
