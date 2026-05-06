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

test("system prompt cache reuses identical mapped prompts", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let builds = 0;

	const first = await helper.withSystemPromptCache(
		"openai",
		"gpt-5.4-chat",
		"base-prompt",
		async () => {
			builds += 1;
			return "mapped-prompt";
		},
	);
	const second = await helper.withSystemPromptCache(
		"openai",
		"gpt-5.4-chat",
		"base-prompt",
		async () => {
			builds += 1;
			return "mapped-prompt";
		},
	);
	const third = await helper.withSystemPromptCache(
		"claude",
		"claude-sonnet-4-6",
		"base-prompt",
		async () => {
			builds += 1;
			return "mapped-prompt";
		},
	);

	assert.equal(first, "mapped-prompt");
	assert.equal(second, "mapped-prompt");
	assert.equal(third, "mapped-prompt");
	assert.equal(builds, 2);
	helper.scrubKeys();
});

test("final payload cache reuses identical assembly work and returns safe clones", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let builds = 0;

	const first = await helper.withFinalPayloadCache(
		"openai",
		"gpt-5.4-chat",
		"sys-hash",
		"payload-hash",
		async () => {
			builds += 1;
			return { messages: [{ role: "user", content: "hello" }] };
		},
	);

	first.messages[0].content = "mutated";

	const second = await helper.withFinalPayloadCache(
		"openai",
		"gpt-5.4-chat",
		"sys-hash",
		"payload-hash",
		async () => {
			builds += 1;
			return { messages: [{ role: "user", content: "hello" }] };
		},
	);

	assert.equal(builds, 1);
	assert.deepEqual(second, { messages: [{ role: "user", content: "hello" }] });
	helper.scrubKeys();
});

test("response cache dedupes identical in-flight requests and reuses short ttl hits", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let calls = 0;

	helper.delay = async (ms: number) => {
		if (ms > 0) {
			await new Promise((resolve) => setTimeout(resolve, ms));
		}
	};

	const execute = () =>
		helper.withResponseCache(
			"openai",
			"gpt-5.4-chat",
			"sys-hash",
			"payload-hash",
			async () => {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "cached-answer";
			},
			50,
		);

	const [first, second] = await Promise.all([execute(), execute()]);
	const third = await execute();

	assert.equal(first, "cached-answer");
	assert.equal(second, "cached-answer");
	assert.equal(third, "cached-answer");
	assert.equal(calls, 1);

	await helper.delay(60);
	const fourth = await execute();
	assert.equal(fourth, "cached-answer");
	assert.equal(calls, 2);
	helper.scrubKeys();
});
