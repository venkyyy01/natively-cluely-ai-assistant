import assert from "node:assert/strict";
import Module from "node:module";
import { ReadableStream } from "node:stream/web";
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

test("switching from cURL provider back to cloud model clears stale cURL routing state", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;

	helper.setModel("curl-provider", [
		{
			id: "curl-provider",
			name: "cURL",
			curlCommand: "curl https://example.com",
		},
	]);
	assert.equal(helper.getProviderCapabilityClass(), "non_streaming");

	helper.setModel("gemini", []);

	assert.notEqual(helper.getProviderCapabilityClass(), "non_streaming");
	assert.notEqual(helper.getCurrentModel(), "curl-provider");
	helper.scrubKeys();
});

test("selected OpenAI model ids pass through unchanged to the outbound request", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let seenModel = "";

	helper.setModel("gpt-5.4-nano", []);
	helper.openaiClient = {
		chat: {
			completions: {
				create: async (payload: any) => {
					seenModel = payload.model;
					return { choices: [{ message: { content: "ok" } }] };
				},
			},
		},
	};

	const result = await helper.generateWithOpenai("hello");

	assert.equal(result, "ok");
	assert.equal(seenModel, "gpt-5.4-nano");
	helper.scrubKeys();
});

test("selected Claude model ids pass through unchanged to the outbound request", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let seenModel = "";

	helper.setModel("claude-opus-5-2", []);
	helper.claudeClient = {
		messages: {
			create: async (payload: any) => {
				seenModel = payload.model;
				return { content: [{ type: "text", text: "ok" }] };
			},
		},
	};

	const result = await helper.chatWithGemini("hello claude model");

	assert.equal(result, "ok");
	assert.equal(seenModel, "claude-opus-5-2");
	helper.scrubKeys();
});

test("OpenAI model-not-found errors fall back to a safe discovered model", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const seenModels: string[] = [];
	const fallbackEvents: any[] = [];

	helper.setModel("gpt-5.4-nano", []);
	helper.resolveOpenAiFallbackModel = async () => "gpt-5.4-mini";
	helper.setModelFallbackHandler((event: any) => fallbackEvents.push(event));
	helper.openaiClient = {
		chat: {
			completions: {
				create: async (payload: any) => {
					seenModels.push(payload.model);
					if (payload.model === "gpt-5.4-nano") {
						const error: any = new Error(
							"The model `gpt-5.4-nano` does not exist or you do not have access to it.",
						);
						error.status = 404;
						throw error;
					}
					return { choices: [{ message: { content: "fallback ok" } }] };
				},
			},
		},
	};

	const result = await helper.generateWithOpenai("hello");

	assert.equal(result, "fallback ok");
	assert.deepEqual(seenModels, ["gpt-5.4-nano", "gpt-5.4-mini"]);
	assert.equal(helper.getCurrentModel(), "gpt-5.4-mini");
	assert.deepEqual(fallbackEvents, [
		{
			provider: "openai",
			previousModel: "gpt-5.4-nano",
			fallbackModel: "gpt-5.4-mini",
			reason: "model_not_found",
		},
	]);
	helper.scrubKeys();
});

test("fast response config routes text-only requests through Cerebras using the selected model", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let seenModel = "";
	let seenMessages: any[] = [];

	helper.cerebrasClient = {
		chat: {
			completions: {
				create: async (payload: any) => {
					seenModel = payload.model;
					seenMessages = payload.messages;
					return { choices: [{ message: { content: "cerebras fast ok" } }] };
				},
			},
		},
	};

	helper.setFastResponseConfig({
		enabled: true,
		provider: "cerebras",
		model: "gpt-oss-120b",
	});
	const result = await helper.chatWithGemini("hello from fast mode");

	assert.equal(result, "cerebras fast ok");
	assert.equal(seenModel, "gpt-oss-120b");
	assert.equal(seenMessages.at(-1)?.role, "user");
	assert.match(
		String(seenMessages.at(-1)?.content || ""),
		/hello from fast mode/i,
	);
	helper.scrubKeys();
});

test("fast response streaming falls back to the default Cerebras model when none is configured", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	let seenModel = "";

	helper.cerebrasClient = {
		chat: {
			completions: {
				create: async (payload: any) => {
					seenModel = payload.model;
					async function* stream() {
						yield { choices: [{ delta: { content: "fast " } }] };
						yield { choices: [{ delta: { content: "stream" } }] };
					}
					return stream();
				},
			},
		},
	};

	helper.setFastResponseConfig({
		enabled: true,
		provider: "cerebras",
		model: "",
	});

	let output = "";
	for await (const chunk of helper.streamChat("hello streaming fast mode")) {
		output += chunk;
	}

	assert.equal(seenModel, "gpt-oss-120b");
	assert.equal(output, "fast stream");
	helper.scrubKeys();
});

test("chatWithGemini falls back to text-only screenshot routing when active cURL template has no image placeholders", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalChatWithCurl = helper.chatWithCurl;
	const originalExtractImageTextWithTesseract =
		helper.extractImageTextWithTesseract;
	const calls: Array<{
		userMessage: string;
		context: string;
		imageCount: number;
	}> = [];

	helper.setModel("curl-provider", [
		{
			id: "curl-provider",
			name: "cURL",
			curlCommand: 'curl https://example.com -d "{{TEXT}}"',
			responsePath: "choices[0].message.content",
		},
	]);

	helper.chatWithCurl = async (
		userMessage: string,
		_systemPrompt?: string,
		context: string = "",
		imagePaths?: string[],
	) => {
		calls.push({ userMessage, context, imageCount: imagePaths?.length || 0 });
		return "ok";
	};
	helper.extractImageTextWithTesseract = async () =>
		"deterministic screenshot fallback text";

	try {
		const imageOnly = await helper.chatWithGemini("", ["/tmp/image-only.png"]);
		const mixed = await helper.chatWithGemini(
			"hello",
			["/tmp/mixed.png"],
			"ctx",
		);

		assert.equal(imageOnly, "ok");
		assert.equal(mixed, "ok");
		assert.equal(calls.length, 2);
		assert.equal(calls[0].imageCount, 0);
		assert.equal(calls[1].imageCount, 0);
		assert.match(calls[0].userMessage, /SCREENSHOT_TEXT_FALLBACK:/);
		assert.match(calls[1].userMessage, /SCREENSHOT_TEXT_FALLBACK:/);
		assert.match(
			calls[0].userMessage,
			/deterministic screenshot fallback text/,
		);
		assert.match(
			calls[1].userMessage,
			/deterministic screenshot fallback text/,
		);
		assert.equal(calls[1].context, "ctx");
	} finally {
		helper.chatWithCurl = originalChatWithCurl;
		helper.extractImageTextWithTesseract =
			originalExtractImageTextWithTesseract;
		helper.scrubKeys();
	}
});

test("streamChat uses responsePath for active cURL providers", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;

	helper.setModel("curl-provider", [
		{
			id: "curl-provider",
			name: "cURL",
			curlCommand:
				"curl https://example.com -H 'Content-Type: application/json' -d '{\"messages\":{{OPENAI_MESSAGES}}}'",
			responsePath: "payload.answer",
		},
	]);

	const originalFetch = global.fetch;
	const payload = JSON.stringify({ payload: { answer: "from-response-path" } });
	global.fetch = async () =>
		({
			ok: true,
			status: 200,
			headers: {
				get: (header: string) =>
					header.toLowerCase() === "content-length"
						? String(Buffer.byteLength(payload))
						: null,
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(payload));
					controller.close();
				},
			}),
		}) as any;

	try {
		let output = "";
		for await (const chunk of helper.streamChat("hello")) {
			output += chunk;
		}

		assert.equal(output, "from-response-path");
	} finally {
		global.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("chatWithGemini falls back to fast response when the active cURL provider times out", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalChatWithCurl = helper.chatWithCurl;

	helper.setModel("curl-provider", [
		{
			id: "curl-provider",
			name: "cURL",
			curlCommand: "curl https://example.com",
			responsePath: "choices[0].message.content",
		},
	]);

	helper.cerebrasClient = {
		chat: {
			completions: {
				create: async () => ({
					choices: [{ message: { content: "fast fallback ok" } }],
				}),
			},
		},
	};
	helper.setFastResponseConfig({
		enabled: true,
		provider: "cerebras",
		model: "gpt-oss-120b",
	});
	helper.chatWithCurl = async () => {
		throw new Error("LLM API timeout after 60000ms");
	};

	try {
		const result = await helper.chatWithGemini("hello from slow curl provider");
		assert.equal(result, "fast fallback ok");
	} finally {
		helper.chatWithCurl = originalChatWithCurl;
		helper.scrubKeys();
	}
});

test("streamChat falls back to fast response when the active cURL provider fails", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalExecuteCustomProvider = helper.executeCustomProvider;

	helper.setModel("curl-provider", [
		{
			id: "curl-provider",
			name: "cURL",
			curlCommand: "curl https://example.com",
			responsePath: "choices[0].message.content",
		},
	]);

	helper.cerebrasClient = {
		chat: {
			completions: {
				create: async function* () {
					yield { choices: [{ delta: { content: "fast " } }] };
					yield { choices: [{ delta: { content: "fallback" } }] };
				},
			},
		},
	};
	helper.setFastResponseConfig({
		enabled: true,
		provider: "cerebras",
		model: "gpt-oss-120b",
	});
	helper.executeCustomProvider = async () => {
		throw new Error("LLM API timeout after 60000ms");
	};

	try {
		let output = "";
		for await (const chunk of helper.streamChat(
			"hello from curl stream timeout",
		)) {
			output += chunk;
		}

		assert.equal(output, "fast fallback");
	} finally {
		helper.executeCustomProvider = originalExecuteCustomProvider;
		helper.scrubKeys();
	}
});
