import assert from "node:assert/strict";
import test from "node:test";
import {
	ParallelContextAssembler,
	setEmbeddingProvider,
} from "../cache/ParallelContextAssembler";
import {
	DEFAULT_OPTIMIZATION_FLAGS,
	setOptimizationFlagsForTesting,
} from "../config/optimizations";

/**
 * NAT-054: embedding runs in parallel with BM25 + phase (Promise.all), not sequentially.
 * Instrument embedding vs BM25 with deterministic delays and assert time-window overlap.
 */
test("NAT-054: assemble awaits embedding, bm25, and phase in one Promise.all wave", async () => {
	setOptimizationFlagsForTesting({
		accelerationEnabled: true,
		useParallelContext: true,
	});

	try {
		let embedStart = 0;
		let embedEnd = 0;
		let bm25Start = 0;
		let bm25End = 0;

		setEmbeddingProvider({
			isInitialized: () => true,
			embed: async (_q: string) => {
				embedStart = Date.now();
				await new Promise((r) => setTimeout(r, 35));
				embedEnd = Date.now();
				return new Array(384).fill(0.1);
			},
		});

		const asm = new ParallelContextAssembler({ workerThreadCount: 2 });
		const origRun = (
			asm as unknown as {
				runInWorker: (t: string, p: unknown) => Promise<unknown>;
			}
		).runInWorker.bind(asm);
		(
			asm as unknown as {
				runInWorker: (t: string, p: unknown) => Promise<unknown>;
			}
		).runInWorker = async (type: string, payload: unknown) => {
			if (type === "bm25") {
				bm25Start = Date.now();
				await new Promise((r) => setTimeout(r, 35));
				bm25End = Date.now();
				return [];
			}
			return origRun(type, payload);
		};

		await asm.assemble({
			query: "test query about design",
			transcript: [
				{
					speaker: "interviewer",
					text: "hello world design architecture",
					timestamp: 1,
				},
			],
			previousContext: { recentTopics: [], activeThread: null },
		});

		assert.ok(
			embedStart > 0 && bm25Start > 0,
			"both embedding and bm25 paths should have started",
		);
		const windowsOverlap =
			Math.max(embedStart, bm25Start) < Math.min(embedEnd, bm25End);
		assert.ok(
			windowsOverlap,
			"expected bm25 and embedding time windows to overlap (parallel)",
		);
	} finally {
		setEmbeddingProvider(null);
		setOptimizationFlagsForTesting(DEFAULT_OPTIMIZATION_FLAGS);
	}
});
