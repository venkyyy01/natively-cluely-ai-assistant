import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

test("loadStoredCredentials restores saved keys and fast response config at startup", async () => {
	const originalLoad = (Module as any)._load;
	const llmCalls: Array<{ method: string; value: unknown }> = [];
	const ragCalls: string[] = [];
	let initializeCount = 0;

	class FakeLLMHelper {
		constructor() {}

		setModelFallbackHandler() {}
		setApiKey(value: string) {
			llmCalls.push({ method: "setApiKey", value });
		}
		setGroqApiKey(value: string) {
			llmCalls.push({ method: "setGroqApiKey", value });
		}
		setCerebrasApiKey(value: string) {
			llmCalls.push({ method: "setCerebrasApiKey", value });
		}
		setOpenaiApiKey(value: string) {
			llmCalls.push({ method: "setOpenaiApiKey", value });
		}
		setClaudeApiKey(value: string) {
			llmCalls.push({ method: "setClaudeApiKey", value });
		}
		setFastResponseConfig(value: unknown) {
			llmCalls.push({ method: "setFastResponseConfig", value });
		}
		setModel(value: string) {
			llmCalls.push({ method: "setModel", value });
		}
		setSttLanguage(value: string) {
			llmCalls.push({ method: "setSttLanguage", value });
		}
		setAiResponseLanguage(value: string) {
			llmCalls.push({ method: "setAiResponseLanguage", value });
		}
		async initModelVersionManager() {
			llmCalls.push({ method: "initModelVersionManager", value: true });
		}
	}

	const credentialsManager = {
		getGeminiApiKey: () => "gemini-key",
		getGroqApiKey: () => "groq-key",
		getCerebrasApiKey: () => "cerebras-key",
		getOpenaiApiKey: () => "openai-key",
		getClaudeApiKey: () => "claude-key",
		getFastResponseConfig: () => ({
			enabled: true,
			provider: "cerebras",
			model: "gpt-oss-120b",
		}),
		getDefaultModel: () => "gpt-5.4-mini",
		getCustomProviders: (): any[] => [],
		getCurlProviders: (): any[] => [],
		getSttLanguage: () => "english-us",
		getAiResponseLanguage: () => "English",
	};

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return {
				app: { isPackaged: false },
				BrowserWindow: { getAllWindows: (): any[] => [] },
			};
		}

		if (request === "./LLMHelper") {
			return { LLMHelper: FakeLLMHelper };
		}

		if (request === "./services/CredentialsManager") {
			return { CredentialsManager: { getInstance: () => credentialsManager } };
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		const modulePath = require.resolve("../ProcessingHelper");
		delete require.cache[modulePath];
		const { ProcessingHelper } = await import("../ProcessingHelper");

		const appState = {
			getIntelligenceManager: () => ({
				initializeLLMs: () => {
					initializeCount += 1;
				},
			}),
			getRAGManager: (): any => ({
				initializeEmbeddings: () => {
					ragCalls.push("initializeEmbeddings");
				},
				retryPendingEmbeddings: async () => {
					ragCalls.push("retryPendingEmbeddings");
				},
				ensureDemoMeetingProcessed: async () => {
					ragCalls.push("ensureDemoMeetingProcessed");
				},
				cleanupStaleQueueItems: () => {
					ragCalls.push("cleanupStaleQueueItems");
				},
			}),
		};

		const helper = new ProcessingHelper(appState as any);
		helper.loadStoredCredentials();

		assert.equal(initializeCount, 1);
		assert.deepEqual(
			llmCalls.filter((call) => call.method !== "initModelVersionManager"),
			[
				{ method: "setApiKey", value: "gemini-key" },
				{ method: "setGroqApiKey", value: "groq-key" },
				{ method: "setCerebrasApiKey", value: "cerebras-key" },
				{ method: "setOpenaiApiKey", value: "openai-key" },
				{ method: "setClaudeApiKey", value: "claude-key" },
				{ method: "setModel", value: "gpt-5.4-mini" },
				{
					method: "setFastResponseConfig",
					value: { enabled: true, provider: "cerebras", model: "gpt-oss-120b" },
				},
				{ method: "setSttLanguage", value: "english-us" },
				{ method: "setAiResponseLanguage", value: "English" },
			],
		);
		assert.deepEqual(ragCalls, [
			"initializeEmbeddings",
			"retryPendingEmbeddings",
			"ensureDemoMeetingProcessed",
			"cleanupStaleQueueItems",
		]);
	} finally {
		(Module as any)._load = originalLoad;
	}
});

test("loadStoredCredentials skips optional startup branches when credentials and services are absent", async () => {
	const originalLoad = (Module as any)._load;
	const llmCalls: Array<{ method: string; value: unknown }> = [];
	let initializeCount = 0;

	class FakeLLMHelper {
		constructor() {}

		setModelFallbackHandler() {}
		setApiKey(value: string) {
			llmCalls.push({ method: "setApiKey", value });
		}
		setGroqApiKey(value: string) {
			llmCalls.push({ method: "setGroqApiKey", value });
		}
		setCerebrasApiKey(value: string) {
			llmCalls.push({ method: "setCerebrasApiKey", value });
		}
		setOpenaiApiKey(value: string) {
			llmCalls.push({ method: "setOpenaiApiKey", value });
		}
		setClaudeApiKey(value: string) {
			llmCalls.push({ method: "setClaudeApiKey", value });
		}
		setFastResponseConfig(value: unknown) {
			llmCalls.push({ method: "setFastResponseConfig", value });
		}
		setModel(value: string) {
			llmCalls.push({ method: "setModel", value });
		}
		setSttLanguage(value: string) {
			llmCalls.push({ method: "setSttLanguage", value });
		}
		setAiResponseLanguage(value: string) {
			llmCalls.push({ method: "setAiResponseLanguage", value });
		}
		async initModelVersionManager() {
			llmCalls.push({ method: "initModelVersionManager", value: true });
		}
	}

	const credentialsManager = {
		getGeminiApiKey: () => "",
		getGroqApiKey: () => "",
		getCerebrasApiKey: () => "",
		getOpenaiApiKey: () => "",
		getClaudeApiKey: () => "",
		getFastResponseConfig: () => ({
			enabled: false,
			provider: "groq",
			model: "",
		}),
		getDefaultModel: () => "",
		getCustomProviders: (): any[] => [],
		getCurlProviders: (): any[] => [],
		getSttLanguage: () => "",
		getAiResponseLanguage: () => "",
	};

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return {
				app: { isPackaged: false },
				BrowserWindow: { getAllWindows: (): any[] => [] },
			};
		}

		if (request === "./LLMHelper") {
			return { LLMHelper: FakeLLMHelper };
		}

		if (request === "./services/CredentialsManager") {
			return { CredentialsManager: { getInstance: () => credentialsManager } };
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		const modulePath = require.resolve("../ProcessingHelper");
		delete require.cache[modulePath];
		const { ProcessingHelper } = await import("../ProcessingHelper");

		const appState = {
			getIntelligenceManager: () => ({
				initializeLLMs: () => {
					initializeCount += 1;
				},
			}),
			getRAGManager: (): any => null,
		};

		const helper = new ProcessingHelper(appState as any);
		helper.loadStoredCredentials();

		assert.equal(initializeCount, 1);
		assert.deepEqual(
			llmCalls.filter((call) => call.method !== "initModelVersionManager"),
			[
				{
					method: "setFastResponseConfig",
					value: { enabled: false, provider: "groq", model: "" },
				},
			],
		);
	} finally {
		(Module as any)._load = originalLoad;
	}
});
