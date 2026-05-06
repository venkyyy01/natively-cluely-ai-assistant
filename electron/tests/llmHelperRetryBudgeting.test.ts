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

test("model-specific budgeting gives larger context windows to larger-context providers", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	try {
		const message = "m".repeat(4_000);
		const context = "c".repeat(400_000);

		const groqContent = helper.prepareUserContentForModel(
			"groq",
			"llama-3.3-70b-versatile",
			message,
			context,
		);
		const claudeContent = helper.prepareUserContentForModel(
			"claude",
			"claude-sonnet-4-6",
			message,
			context,
		);

		assert.ok(claudeContent.length > groqContent.length);
		assert.match(groqContent, /\.\.\.\[(?:middle )?truncated\]/);
		assert.match(claudeContent, /USER QUESTION:/);
	} finally {
		helper.scrubKeys();
	}
});

test("retry normalization treats provider status objects consistently", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;

	assert.equal(
		helper.isRetryableError({ status: 429, message: "rate limited" }),
		true,
	);
	assert.equal(
		helper.isRetryableError({
			response: { status: 503 },
			message: "unavailable",
		}),
		true,
	);
	assert.equal(
		helper.isRetryableError({ code: "ECONNRESET", message: "socket hang up" }),
		true,
	);
	assert.equal(
		helper.isRetryableError({ status: 400, message: "bad request" }),
		false,
	);
	helper.scrubKeys();
});

test("withRetry normalizes exhausted retryable failures and preserves non-retryable failures", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	helper.delay = async () => {};

	let retryableCalls = 0;
	await assert.rejects(
		() =>
			helper.withRetry(async () => {
				retryableCalls += 1;
				throw { status: 429, message: "rate limited" };
			}, 2),
		/Model busy, try again/,
	);
	assert.equal(retryableCalls, 2);

	let nonRetryableCalls = 0;
	const badRequestError = { status: 400, message: "bad request" };
	await assert.rejects(
		() =>
			helper.withRetry(async () => {
				nonRetryableCalls += 1;
				throw badRequestError;
			}, 3),
		(error: any) => error === badRequestError,
	);
	assert.equal(nonRetryableCalls, 1);
	helper.scrubKeys();
});
