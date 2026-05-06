import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

async function loadLLMHelper() {
	const originalRequire = Module.prototype.require;
	Module.prototype.require = function patchedRequire(
		this: unknown,
		id: string,
	) {
		if (id === "electron") {
			return {
				app: {
					getPath: () => "/tmp",
					isPackaged: false,
				},
			};
		}
		return originalRequire.call(this, id);
	};

	try {
		return (await import("../LLMHelper")).LLMHelper;
	} finally {
		Module.prototype.require = originalRequire;
	}
}

test("joinPrompt preserves system prompt head under strict budget while trimming user content body", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;

	try {
		helper.tokenCounter = {
			count: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
			estimateCharacterBudget: (tokens: number) => Math.max(1, tokens * 4),
		};

		const systemPrompt = [
			"SYSTEM HEADER: NEVER DROP",
			"SCHEMA HEADER: REQUIRED CONTRACT",
			"EVIDENCE HEADER: MUST STAY",
		].join("\n");
		const hugeTranscriptTail = "tail ".repeat(2000);
		const userContent = `CONTEXT:\n${hugeTranscriptTail}\n\nUSER QUESTION:\nHow would you design this?`;

		const joined = helper.joinPrompt(systemPrompt, userContent, 220);

		assert.match(joined, /SYSTEM HEADER: NEVER DROP/);
		assert.match(joined, /SCHEMA HEADER: REQUIRED CONTRACT/);
		assert.match(joined, /EVIDENCE HEADER: MUST STAY/);
		assert.match(joined, /USER QUESTION:/);
		assert.match(joined, /\[middle truncated\]|\.\.\.\[truncated\]/);
	} finally {
		helper.scrubKeys();
	}
});

test("prepareUserContent keeps context head and tail with middle truncation under overflow", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;

	try {
		helper.tokenCounter = {
			count: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
			estimateCharacterBudget: (tokens: number) => Math.max(1, tokens * 4),
		};

		const head = "<conscious_evidence>KEEP_HEAD</conscious_evidence>";
		const tail = "[INTERVIEWER]: KEEP_TAIL_QUESTION";
		const filler = "middle-context ".repeat(3000);
		const context = `${head}\n${filler}\n${tail}`;

		const prepared = helper.prepareUserContent(
			"Please answer this",
			context,
			280,
		);

		assert.match(prepared, /CONTEXT:/);
		assert.match(
			prepared,
			/<conscious_evidence>KEEP_HEAD<\/conscious_evidence>/,
		);
		assert.match(prepared, /KEEP_TAIL_QUESTION/);
		assert.match(prepared, /\[middle truncated\]/);
	} finally {
		helper.scrubKeys();
	}
});
