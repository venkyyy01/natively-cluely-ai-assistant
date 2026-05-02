import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { fetchProviderModels } from "../utils/modelFetcher";

test("fetchProviderModels returns only chat-capable Cerebras models", async () => {
	const originalGet = axios.get;
	let seenUrl = "";
	let seenAuth = "";

	(axios as any).get = async (url: string, config: any) => {
		seenUrl = url;
		seenAuth = config?.headers?.Authorization || "";

		return {
			data: {
				data: [
					{ id: "gpt-oss-120b" },
					{ id: "qwen-3-32b" },
					{ id: "text-embedding-3-large" },
					{ id: "speech-realtime-preview" },
				],
			},
		};
	};

	try {
		const models = await fetchProviderModels("cerebras", "csk_test");

		assert.equal(seenUrl, "https://api.cerebras.ai/v1/models");
		assert.equal(seenAuth, "Bearer csk_test");
		assert.deepEqual(models, [
			{ id: "gpt-oss-120b", label: "gpt-oss-120b" },
			{ id: "qwen-3-32b", label: "qwen-3-32b" },
		]);
	} finally {
		(axios as any).get = originalGet;
	}
});

test("fetchProviderModels filters OpenAI models to modern chat and reasoning families", async () => {
	const originalGet = axios.get;

	(axios as any).get = async () => ({
		data: {
			data: [
				{ id: "gpt-4o-mini" },
				{ id: "gpt-5.4-mini" },
				{ id: "o3-mini" },
				{ id: "o1-audio-preview" },
				{ id: "text-embedding-3-large" },
			],
		},
	});

	try {
		const models = await fetchProviderModels("openai", "sk-test");
		assert.deepEqual(models, [
			{ id: "gpt-4o-mini", label: "gpt-4o-mini" },
			{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
			{ id: "o3-mini", label: "o3-mini" },
		]);
	} finally {
		(axios as any).get = originalGet;
	}
});

test("fetchProviderModels filters Groq non-chat models", async () => {
	const originalGet = axios.get;

	(axios as any).get = async () => ({
		data: {
			data: [
				{ id: "llama-3.3-70b-versatile" },
				{ id: "meta-llama/llama-4-scout" },
				{ id: "whisper-large-v3" },
				{ id: "playai-tts" },
			],
		},
	});

	try {
		const models = await fetchProviderModels("groq", "gsk_test");
		assert.deepEqual(models, [
			{ id: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile" },
			{ id: "meta-llama/llama-4-scout", label: "meta-llama/llama-4-scout" },
		]);
	} finally {
		(axios as any).get = originalGet;
	}
});

test("fetchProviderModels filters Anthropic models to Claude 3.5+", async () => {
	const originalGet = axios.get;

	(axios as any).get = async () => ({
		data: {
			data: [
				{ id: "claude-3-5-sonnet", display_name: "Claude 3.5 Sonnet" },
				{ id: "claude-4-opus", display_name: "Claude 4 Opus" },
				{ id: "claude-3-haiku", display_name: "Claude 3 Haiku" },
				{ id: "other-model", display_name: "Other" },
			],
		},
	});

	try {
		const models = await fetchProviderModels("claude", "sk-ant-test");
		assert.deepEqual(models, [
			{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
			{ id: "claude-4-opus", label: "Claude 4 Opus" },
		]);
	} finally {
		(axios as any).get = originalGet;
	}
});

test("fetchProviderModels filters Gemini models to generateContent-capable 2.5+ models", async () => {
	const originalGet = axios.get;

	(axios as any).get = async () => ({
		data: {
			models: [
				{
					name: "models/gemini-2.5-pro",
					displayName: "Gemini 2.5 Pro",
					supportedGenerationMethods: ["generateContent"],
				},
				{
					name: "models/gemini-3.0-flash",
					displayName: "Gemini 3 Flash",
					supportedGenerationMethods: ["generateContent"],
				},
				{
					name: "models/gemini-2.0-nano",
					displayName: "Gemini Nano",
					supportedGenerationMethods: ["generateContent"],
				},
				{
					name: "models/gemini-3.0-vision",
					displayName: "Gemini Vision",
					supportedGenerationMethods: ["generateContent"],
				},
				{
					name: "models/text-bison",
					displayName: "Text Bison",
					supportedGenerationMethods: ["embedContent"],
				},
			],
		},
	});

	try {
		const models = await fetchProviderModels("gemini", "AIza-test");
		assert.deepEqual(models, [
			{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
			{ id: "gemini-3.0-flash", label: "Gemini 3 Flash" },
		]);
	} finally {
		(axios as any).get = originalGet;
	}
});

test("fetchProviderModels rejects unknown providers", async () => {
	await assert.rejects(
		() => fetchProviderModels("unknown" as any, "key"),
		/Unknown provider: unknown/,
	);
});
