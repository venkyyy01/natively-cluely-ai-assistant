import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
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

test("executeCustomProvider throws on HTTP errors instead of treating them as model output", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async () =>
		new Response("bad gateway", { status: 502 })) as typeof fetch;

	try {
		await assert.rejects(
			() =>
				helper.executeCustomProvider(
					'curl https://example.com -H "Content-Type: application/json" -d "{}"',
					"hello",
					"",
					"hello",
					"",
				),
			/Custom Provider HTTP 502: bad gateway/,
		);
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("executeCustomProvider rejects oversized response bodies before parsing", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async () =>
		new Response("ok", {
			status: 200,
			headers: { "content-length": String(3 * 1024 * 1024) },
		})) as typeof fetch;

	try {
		await assert.rejects(
			() =>
				helper.executeCustomProvider(
					'curl https://example.com -H "Content-Type: application/json" -d "{}"',
					"hello",
					"",
					"hello",
					"",
				),
			/Provider response exceeded/,
		);
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("executeCustomProvider injects image arrays and counts for multimodal templates", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	const imagePathA = "/tmp/custom-provider-image-a.png";
	const imagePathB = "/tmp/custom-provider-image-b.png";
	await Promise.all([
		fsPromises.writeFile(imagePathA, Buffer.from("a-image")),
		fsPromises.writeFile(imagePathB, Buffer.from("b-image")),
	]);

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"images":{{IMAGE_BASE64S}},"count":"{{IMAGE_COUNT}}","user":"{{USER_MESSAGE}}","context":"{{CONTEXT}}"}'`,
			"combined text",
			"system text",
			"user text",
			"ctx text",
			[imagePathA, imagePathB],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.deepEqual(Array.isArray(parsed.images), true);
		assert.equal(parsed.images.length, 2);
		assert.equal(parsed.count, "2");
		assert.equal(parsed.user, "user text");
		assert.equal(parsed.context, "ctx text");
	} finally {
		globalThis.fetch = originalFetch;
		await Promise.allSettled([
			fsPromises.unlink(imagePathA),
			fsPromises.unlink(imagePathB),
		]);
		helper.scrubKeys();
	}
});

test("executeCustomProvider supports unescaped JSON templates from curl export tools", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			'curl https://example.com -H "Content-Type: application/json" -d "{\\"messages\\":{{OPENAI_MESSAGES}}}"',
			"combined",
			"system",
			"user text",
			"ctx",
			[],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.deepEqual(Array.isArray(parsed.messages), true);
		assert.equal(parsed.messages.length > 0, true);
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("executeCustomProvider prunes empty inline image blocks from rigid multimodal templates", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":[{"type":"text","text":"{{TEXT}}"},{"type":"image_url","image_url":{"url":"data:image/png;base64,{{IMAGE_BASE64}}"}}]}]}'`,
			"combined text",
			"system text",
			"user text",
			"ctx text",
			[],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.equal(parsed.messages[0]?.content, "combined text");
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("executeCustomProvider collapses text-only OpenAI content arrays for provider compatibility", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":{{OPENAI_USER_CONTENT}}}]}'`,
			"combined",
			"system",
			"user text",
			"ctx",
			[],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.equal(
			parsed.messages[0]?.content,
			"CONTEXT:\nctx\n\nUSER QUESTION:\nuser text",
		);
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});

test("executeCustomProvider preserves multimodal OpenAI content arrays when an image is present", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	const imagePath = "/tmp/custom-provider-openai-compatible.png";
	await fsPromises.writeFile(
		imagePath,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k1x8AAAAASUVORK5CYII=",
			"base64",
		),
	);

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":{{OPENAI_USER_CONTENT}}}]}'`,
			"combined",
			"system",
			"user text",
			"ctx",
			[imagePath],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.deepEqual(Array.isArray(parsed.messages[0]?.content), true);
		assert.equal(
			parsed.messages[0].content.some(
				(part: { type: string }) => part.type === "image_url",
			),
			true,
		);
	} finally {
		globalThis.fetch = originalFetch;
		await Promise.allSettled([fsPromises.unlink(imagePath)]);
		helper.scrubKeys();
	}
});

test("executeCustomProvider prunes empty text parts when an image-only multimodal template is used", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	const imagePath = "/tmp/custom-provider-image-only.png";
	await fsPromises.writeFile(
		imagePath,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k1x8AAAAASUVORK5CYII=",
			"base64",
		),
	);

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":[{"type":"text","text":"{{TEXT}}"},{"type":"image_url","image_url":{"url":"data:image/png;base64,{{IMAGE_BASE64}}"}}]}]}'`,
			"",
			"system",
			"",
			"",
			[imagePath],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.deepEqual(Array.isArray(parsed.messages[0]?.content), true);
		assert.equal(parsed.messages[0].content.length, 1);
		assert.equal(parsed.messages[0].content[0]?.type, "image_url");
	} finally {
		globalThis.fetch = originalFetch;
		await Promise.allSettled([fsPromises.unlink(imagePath)]);
		helper.scrubKeys();
	}
});

test("executeCustomProvider normalizes multiline JSON string templates to valid JSON bodies", async () => {
	const LLMHelper = await loadLLMHelper();
	const helper = new LLMHelper() as any;
	const originalFetch = globalThis.fetch;

	let seenBody = "";
	globalThis.fetch = (async (_url, init) => {
		seenBody = String(init?.body || "");
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	try {
		const response = await helper.executeCustomProvider(
			`curl https://example.com -H "Content-Type: application/json" -d '{"messages":[{"role":"system","content":"Line one
Line two"},{"role":"user","content":"{{USER_MESSAGE}}"}]}'`,
			"combined",
			"system",
			"user text",
			"ctx",
			[],
		);

		assert.equal(response, "ok");
		const parsed = JSON.parse(seenBody);
		assert.equal(parsed.messages[0]?.content, "Line one\nLine two");
		assert.equal(parsed.messages[1]?.content, "user text");
	} finally {
		globalThis.fetch = originalFetch;
		helper.scrubKeys();
	}
});
