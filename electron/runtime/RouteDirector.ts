/** Per-turn identity for stale guards (NAT-057). */
export interface Turn {
	turnId: string;
	transcriptRevision: number;
	/** Absolute wall-clock ms — soft budget for runTurn (checked after execute completes). */
	deadlineMs: number;
	abortSignal: AbortSignal;
}

export interface RouteDirectorRunTurnInput {
	turnId: string;
	transcriptRevision: number;
	deadlineMs: number;
	abortSignal: AbortSignal;
	getCurrentTranscriptRevision: () => number;
}

export interface ParallelCandidate<T> {
	id: string;
	run: (signal: AbortSignal) => Promise<T>;
}

export class RouteDirector {
	/**
	 * Single entry point for a turn: runs `execute`, then enforces abort + transcript revision
	 * before returning a result to the caller (no stale token commits).
	 */
	async runTurn<T>(
		input: RouteDirectorRunTurnInput,
		execute: () => Promise<T>,
	): Promise<T | null> {
		const result = await execute();

		if (input.abortSignal.aborted) {
			return null;
		}
		if (input.getCurrentTranscriptRevision() !== input.transcriptRevision) {
			return null;
		}
		if (Date.now() > input.deadlineMs) {
			return null;
		}
		return result;
	}

	/**
	 * First valid result wins; losers receive `AbortSignal` abort and must finish within
	 * `cancelLoserWithinMs` (default 500).
	 */
	async raceParallelCandidates<T>(
		candidates: ParallelCandidate<T>[],
		options: {
			parentSignal: AbortSignal;
			cancelLoserWithinMs?: number;
			isValid?: (value: T) => boolean;
		},
	): Promise<{ winnerId: string; value: T }> {
		if (candidates.length === 0) {
			throw new Error("raceParallelCandidates: empty candidates");
		}

		const cancelLoserWithinMs = options.cancelLoserWithinMs ?? 500;
		const isValid = options.isValid ?? (() => true);
		const controllers = candidates.map(() => new AbortController());

		const onParentAbort = (): void => {
			for (const c of controllers) {
				c.abort();
			}
		};
		options.parentSignal.addEventListener("abort", onParentAbort);

		const indexed = candidates.map((c, i) => {
			const promise = c
				.run(controllers[i].signal)
				.then((value) => ({ kind: "ok" as const, i, value }))
				.catch((reason: unknown) => ({ kind: "err" as const, i, reason }));
			return { c, i, promise };
		});

		try {
			let pool = indexed.map((x) => x.promise);
			while (pool.length > 0) {
				const settled = await Promise.race(pool);
				if (settled.kind === "err") {
					pool = pool.filter((p) => p !== indexed[settled.i].promise);
					continue;
				}
				if (!isValid(settled.value)) {
					pool = pool.filter((p) => p !== indexed[settled.i].promise);
					continue;
				}

				const winIndex = settled.i;
				for (let j = 0; j < controllers.length; j++) {
					if (j !== winIndex) {
						controllers[j].abort();
					}
				}

				const loserPromises = indexed
					.filter((x) => x.i !== winIndex)
					.map((x) => x.promise);
				await Promise.race([
					Promise.allSettled(loserPromises),
					new Promise<void>((resolve) =>
						setTimeout(resolve, cancelLoserWithinMs),
					),
				]);

				return { winnerId: candidates[winIndex].id, value: settled.value };
			}

			throw new Error("raceParallelCandidates: no valid candidate");
		} finally {
			options.parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}

let shared: RouteDirector | null = null;

export function getRouteDirector(): RouteDirector {
	if (!shared) {
		shared = new RouteDirector();
	}
	return shared;
}
