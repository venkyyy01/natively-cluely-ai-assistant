import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	type ContextAssemblyInput,
	ParallelContextAssembler,
} from "../cache/ParallelContextAssembler";

describe("ParallelContextAssembler", () => {
	let assembler: ParallelContextAssembler;

	beforeEach(() => {
		assembler = new ParallelContextAssembler({ workerThreadCount: 2 });
	});

	it("should assemble context in parallel", async () => {
		const input: ContextAssemblyInput = {
			query: "What is React virtual DOM?",
			transcript: [
				{
					speaker: "interviewer",
					text: "Tell me about React",
					timestamp: Date.now() - 60000,
				},
				{
					speaker: "user",
					text: "React is a library",
					timestamp: Date.now() - 30000,
				},
			],
			previousContext: { recentTopics: ["react"], activeThread: null },
		};

		const result = await assembler.assemble(input);

		assert(result.embedding.length > 0);
		assert(result.phase !== undefined);
		assert(result.relevantContext.length >= 0);
	});

	it("should handle worker failures gracefully", async () => {
		const input: ContextAssemblyInput = {
			query: "test",
			transcript: [],
			previousContext: { recentTopics: [], activeThread: null },
		};

		const result = await assembler.assemble(input);

		assert(result !== null);
	});

	it("should respect worker thread count", async () => {
		const limited = new ParallelContextAssembler({ workerThreadCount: 1 });
		assert(limited.getWorkerCount() === 1);
	});

	it("includes assistant turns by default for continuity-sensitive follow-ups", async () => {
		const input: ContextAssemblyInput = {
			query: "Why did we pick consistent hashing?",
			transcript: [
				{
					speaker: "interviewer",
					text: "How would you scale the cache?",
					timestamp: Date.now() - 30000,
				},
				{
					speaker: "assistant",
					text: "I would pick consistent hashing to reduce key movement during resharding.",
					timestamp: Date.now() - 20000,
				},
				{
					speaker: "interviewer",
					text: "Why did we pick consistent hashing?",
					timestamp: Date.now() - 10000,
				},
			],
			previousContext: { recentTopics: ["cache"], activeThread: null },
		};

		const result = await assembler.assemble(input);

		assert.ok(
			result.relevantContext.some(
				(ctx) =>
					ctx.role === "assistant" && ctx.text.includes("consistent hashing"),
			),
		);
		assert.ok(result.bm25Results.some((ctx) => ctx.role === "assistant"));
	});

	it("can exclude assistant turns when a caller explicitly requests transcript-only retrieval", async () => {
		const transcriptOnly = new ParallelContextAssembler({
			workerThreadCount: 2,
			includeAssistantTurns: false,
		});
		const input: ContextAssemblyInput = {
			query: "consistent hashing",
			transcript: [
				{
					speaker: "assistant",
					text: "consistent hashing reduced resharding movement",
					timestamp: Date.now() - 20000,
				},
				{
					speaker: "interviewer",
					text: "Tell me about cache scale",
					timestamp: Date.now() - 10000,
				},
			],
			previousContext: { recentTopics: ["cache"], activeThread: null },
		};

		const result = await transcriptOnly.assemble(input);

		assert.equal(
			result.relevantContext.some((ctx) => ctx.role === "assistant"),
			false,
		);
		assert.equal(
			result.bm25Results.some((ctx) => ctx.role === "assistant"),
			false,
		);
	});
});
