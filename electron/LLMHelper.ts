import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import curl2Json from "@bany/curl-to-json";
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import Groq from "groq-sdk";
import OpenAI from "openai";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import type { FastResponseConfig, FastResponseProvider } from "../shared/ipc";
import {
	classifyProviderCapability,
	type ProviderCapabilityClass,
} from "./latency/providerCapability";
import {
	logValidationMetrics,
	validateResponseQuality,
} from "./llm/postProcessor";
import {
	CLAUDE_SYSTEM_PROMPT,
	CORE_IDENTITY,
	CUSTOM_ANSWER_PROMPT,
	CUSTOM_ASSIST_PROMPT,
	CUSTOM_FOLLOW_UP_QUESTIONS_PROMPT,
	CUSTOM_FOLLOWUP_PROMPT,
	CUSTOM_RECAP_PROMPT,
	CUSTOM_SYSTEM_PROMPT,
	CUSTOM_WHAT_TO_ANSWER_PROMPT,
	GROQ_SYSTEM_PROMPT,
	HARD_SYSTEM_PROMPT,
	OPENAI_SYSTEM_PROMPT,
	SCREENSHOT_EVENT_PROMPT,
	UNIVERSAL_ANSWER_PROMPT,
	UNIVERSAL_ANTI_DUMP_RULES,
	UNIVERSAL_ASSIST_PROMPT,
	UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT,
	UNIVERSAL_FOLLOWUP_PROMPT,
	UNIVERSAL_RECAP_PROMPT,
	UNIVERSAL_SYSTEM_PROMPT,
	UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
} from "./llm/prompts";
import {
	generateWithCerebras as _generateWithCerebras,
	streamWithCerebras as _streamWithCerebras,
} from "./llm/providers/cerebrasProvider";
import {
	streamWithClaude as _streamWithClaude,
	streamWithClaudeMultimodal as _streamWithClaudeMultimodal,
} from "./llm/providers/claudeProvider";
import {
	chatWithGemini as _chatWithGemini,
	generateWithFlash as _generateWithFlash,
	generateWithPro as _generateWithPro,
	streamChatWithGemini as _streamChatWithGemini,
	streamWithGeminiModel as _streamWithGeminiModel,
	streamWithGeminiParallelRace as _streamWithGeminiParallelRace,
} from "./llm/providers/geminiProvider";
import {
	generateWithGroq as _generateWithGroq,
	streamWithGroq as _streamWithGroq,
	streamWithGroqMultimodal as _streamWithGroqMultimodal,
} from "./llm/providers/groqProvider";
import {
	streamWithOpenai as _streamWithOpenai,
	streamWithOpenaiMultimodal as _streamWithOpenaiMultimodal,
	streamWithOpenaiMultimodalUsingModel as _streamWithOpenaiMultimodalUsingModel,
	streamWithOpenaiUsingModel as _streamWithOpenaiUsingModel,
} from "./llm/providers/openaiProvider";
import type {
	CurlProvider,
	CustomProvider,
} from "./services/CredentialsManager";
import {
	classifyTextModel,
	compareVersions,
	ModelFamily,
	ModelVersionManager,
	parseModelVersion,
	TextModelFamily,
	type TieredModels,
} from "./services/ModelVersionManager";
import { createProviderRateLimiters } from "./services/RateLimiter";
import { TokenCounter } from "./shared/TokenCounter";
import { deepVariableReplacer, getByPath } from "./utils/curlUtils";

const execAsync = promisify(exec);

/** Default timeout for LLM API calls in milliseconds */
export const LLM_API_TIMEOUT_MS = 30000; // 30 seconds
const CURL_PROVIDER_TIMEOUT_MS = 60000; // Some cURL providers are materially slower
const CUSTOM_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Create an AbortSignal that times out after the specified duration
 */
function createTimeoutSignal(
	timeoutMs: number = LLM_API_TIMEOUT_MS,
): AbortSignal {
	if (typeof AbortSignal.timeout === "function") {
		return AbortSignal.timeout(timeoutMs);
	}
	const controller = new AbortController();
	const timeoutHandle = setTimeout(
		() => controller.abort(new Error(`LLM API timeout after ${timeoutMs}ms`)),
		timeoutMs,
	);
	controller.signal.addEventListener(
		"abort",
		() => clearTimeout(timeoutHandle),
		{ once: true },
	);
	return controller.signal;
}

export function createRequestAbortController(
	timeoutMs: number = LLM_API_TIMEOUT_MS,
	externalSignal?: AbortSignal,
): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timeoutHandle = setTimeout(
		() => controller.abort(new Error(`LLM API timeout after ${timeoutMs}ms`)),
		timeoutMs,
	);

	const abortFromExternal = () => {
		controller.abort(externalSignal?.reason);
	};

	if (externalSignal) {
		if (externalSignal.aborted) {
			abortFromExternal();
		} else {
			externalSignal.addEventListener("abort", abortFromExternal, {
				once: true,
			});
		}
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutHandle);
			if (externalSignal) {
				externalSignal.removeEventListener("abort", abortFromExternal);
			}
		},
	};
}

/**
 * Wrap a promise with a timeout
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number = LLM_API_TIMEOUT_MS,
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error(`LLM API timeout after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function summarizeResponseBody(body: string, maxChars: number = 200): string {
	return body.trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function looksLikeJsonPayload(body: string): boolean {
	const trimmed = body.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function readFetchBodyWithLimit(
	response: Response,
	maxBytes: number = CUSTOM_PROVIDER_MAX_RESPONSE_BYTES,
): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw new Error(`Provider response exceeded ${maxBytes} bytes`);
		}
	}

	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let output = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		if (!value) {
			continue;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Provider response exceeded ${maxBytes} bytes`);
		}

		output += decoder.decode(value, { stream: true });
	}

	output += decoder.decode();
	return output;
}

/**
 * Sanitize error objects to remove sensitive data before logging
 */
function sanitizeError(error: unknown): string {
	if (error instanceof Error) {
		// Only return message and stack, not the full error object which may contain headers
		return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
	}
	if (typeof error === "object" && error !== null) {
		// Remove potentially sensitive fields
		const sanitized = { ...error } as Record<string, unknown>;
		delete sanitized.config;
		delete sanitized.request;
		delete sanitized.headers;
		const response = sanitized.response as Record<string, unknown> | undefined;
		if (response) {
			delete response.config;
			delete response.request;
		}
		try {
			return JSON.stringify(sanitized, null, 2);
		} catch {
			return String(error);
		}
	}
	return String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new Error("Operation aborted");
	}
}

interface OllamaResponse {
	response: string;
	done: boolean;
}

// Model constant for Gemini 3 Flash
const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview";
export const GROQ_MODEL = "llama-3.3-70b-versatile";
const CEREBRAS_FAST_MODEL = "gpt-oss-120b";
const OPENAI_MODEL = "gpt-5.4-chat";
export const CLAUDE_MODEL = "claude-sonnet-4-6";
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
export const MAX_OUTPUT_TOKENS = 8192;
export const CLAUDE_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_INPUT_TOKEN_BUDGET = 24000;
const SUMMARY_INPUT_TOKEN_BUDGET = 100000;
const OPENAI_INPUT_TOKEN_BUDGET = 32000;
const GEMINI_FLASH_INPUT_TOKEN_BUDGET = 28000;
const GEMINI_PRO_INPUT_TOKEN_BUDGET = 48000;
const CLAUDE_INPUT_TOKEN_BUDGET = 60000;
const GROQ_INPUT_TOKEN_BUDGET = 24000;
const CEREBRAS_INPUT_TOKEN_BUDGET = 32000;
const LOCAL_INPUT_TOKEN_BUDGET = 16000;
const SYSTEM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
const FINAL_PAYLOAD_CACHE_TTL_MS = 15 * 1000;
const RESPONSE_CACHE_TTL_MS = 1500;
const SYSTEM_PROMPT_CACHE_MAX = 50;
const FINAL_PAYLOAD_CACHE_MAX = 20;
const RESPONSE_CACHE_MAX = 100;
const IN_FLIGHT_RESPONSE_CACHE_MAX = 10;

// Simple prompt for image analysis (not interview copilot - kept separate)
const IMAGE_ANALYSIS_PROMPT = `Analyze concisely. Be direct. No markdown formatting. Return plain text only.`;
const INDIAN_ENGLISH_STYLE_INSTRUCTION = `CRITICAL STYLE: Write in natural Indian English.
- Keep the flow conversational and human.
- Use Indian English phrasing and rhythm naturally while staying professional.
- Slight filler words are okay when they sound natural (for example: "yeah so", "right", "honestly"), but do not overdo.
- Avoid over-westernized slang/idioms and avoid robotic corporate wording.
- Be concrete, clear, concise, and complete.
- No text walls or unnecessary fluff.`;
type Provider = "gemini" | "groq" | "openai" | "claude";

type StreamQualityTier = "fast" | "quality" | "verify";

interface StreamChatOptions {
	skipKnowledgeInterception?: boolean;
	abortSignal?: AbortSignal;
	qualityTier?: StreamQualityTier;
}

const SCREENSHOT_FALLBACK_TEXT_LIMIT_CHARS = 8000;

interface ScreenshotEventRoutingInput {
	message: string;
	context?: string;
	imagePaths: string[];
	signal?: AbortSignal;
	forceTextFallback?: boolean;
}

export interface ScreenshotEventRoutingResult {
	userMessage: string;
	context?: string;
	systemPrompt: string;
	imagePaths?: string[];
}

interface StreamKnowledgeInterceptionResult {
	introResponse?: string;
	contextBlock?: string;
	systemPromptInjection?: string;
}

const DEFAULT_FAST_RESPONSE_CONFIG: FastResponseConfig = {
	enabled: false,
	provider: "groq",
	model: GROQ_MODEL,
};

export interface ModelFallbackEvent {
	provider: Provider;
	previousModel: string;
	fallbackModel: string;
	reason: string;
}

export class LLMHelper {
	public static __testAxios: null | ((config: any) => Promise<any>) = null;
	public client: GoogleGenAI | null = null;
	public groqClient: Groq | null = null;
	public cerebrasClient: OpenAI | null = null;
	public openaiClient: OpenAI | null = null;
	public claudeClient: Anthropic | null = null;
	private apiKey: string | null = null;
	private groqApiKey: string | null = null;
	private cerebrasApiKey: string | null = null;
	private openaiApiKey: string | null = null;
	private claudeApiKey: string | null = null;
	public useOllama: boolean = false;
	private ollamaModel: string = "llama3.2";
	private ollamaUrl: string = "http://localhost:11434";
	private geminiModel: string = GEMINI_FLASH_MODEL;
	public customProvider: CustomProvider | null = null;
	public activeCurlProvider: CurlProvider | null = null;
	private deepMode = false;
	private fastResponseConfig: FastResponseConfig = {
		...DEFAULT_FAST_RESPONSE_CONFIG,
	};
	public knowledgeOrchestrator: any = null;
	private aiResponseLanguage: string = "English";
	private shouldEnforceValidation: boolean =
		process.env.ENFORCE_RESPONSE_VALIDATION === "true";
	private systemPromptCache = new Map<
		string,
		{ expiresAt: number; value: string }
	>();
	private finalPayloadCache = new Map<
		string,
		{ expiresAt: number; value: any }
	>();
	private responseCache = new Map<
		string,
		{ expiresAt: number; value: string }
	>();
	private inFlightResponseCache = new Map<string, Promise<string>>();
	private modelFallbackHandler: ((event: ModelFallbackEvent) => void) | null =
		null;
	private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;
	private readonly tokenCounter = new TokenCounter();

	// Rate limiters per provider to prevent 429 errors on free tiers
	public rateLimiters: ReturnType<typeof createProviderRateLimiters>;

	// Self-improving model version manager for vision analysis
	public modelVersionManager: ModelVersionManager;

	constructor(
		apiKey?: string,
		useOllama: boolean = false,
		ollamaModel?: string,
		ollamaUrl?: string,
		groqApiKey?: string,
		openaiApiKey?: string,
		claudeApiKey?: string,
		cerebrasApiKey?: string,
	) {
		this.useOllama = useOllama;

		// Initialize rate limiters
		this.rateLimiters = createProviderRateLimiters();

		// Initialize model version manager
		this.modelVersionManager = new ModelVersionManager();
		this.cacheCleanupInterval = setInterval(
			() => this.cleanupExpiredCaches(),
			60_000,
		);
		this.cacheCleanupInterval.unref?.();

		// Initialize Groq client if API key provided
		if (groqApiKey) {
			this.groqApiKey = groqApiKey;
			this.groqClient = new Groq({ apiKey: groqApiKey });
			console.log(
				`[LLMHelper] Groq client initialized with model: ${GROQ_MODEL}`,
			);
		}

		if (cerebrasApiKey) {
			this.cerebrasApiKey = cerebrasApiKey;
			this.cerebrasClient = new OpenAI({
				apiKey: cerebrasApiKey,
				baseURL: CEREBRAS_BASE_URL,
			});
			console.log(
				`[LLMHelper] Cerebras client initialized with model: ${CEREBRAS_FAST_MODEL}`,
			);
		}

		// Initialize OpenAI client if API key provided
		if (openaiApiKey) {
			this.openaiApiKey = openaiApiKey;
			this.openaiClient = new OpenAI({ apiKey: openaiApiKey });
			console.log(
				`[LLMHelper] OpenAI client initialized with model: ${OPENAI_MODEL}`,
			);
		}

		// Initialize Claude client if API key provided
		if (claudeApiKey) {
			this.claudeApiKey = claudeApiKey;
			this.claudeClient = new Anthropic({ apiKey: claudeApiKey });
			console.log(
				`[LLMHelper] Claude client initialized with model: ${CLAUDE_MODEL}`,
			);
		}

		if (useOllama) {
			this.ollamaUrl = ollamaUrl || "http://localhost:11434";
			this.ollamaModel = ollamaModel || "gemma:latest"; // Default fallback
			// console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)

			// Auto-detect and use first available model if specified model doesn't exist
			this.initializeOllamaModel();
		} else if (apiKey) {
			this.apiKey = apiKey;
			// Initialize with v1alpha API version for Gemini 3 support
			this.client = new GoogleGenAI({
				apiKey: apiKey,
				httpOptions: { apiVersion: "v1alpha" },
			});
			// console.log(`[LLMHelper] Using Google Gemini 3 with model: ${this.geminiModel} (v1alpha API)`)
		} else {
			console.warn(
				"[LLMHelper] No API key provided. Client will be uninitialized until key is set.",
			);
		}
	}

	public setApiKey(apiKey: string) {
		this.apiKey = apiKey || null;
		this.client = apiKey
			? new GoogleGenAI({
					apiKey: apiKey,
					httpOptions: { apiVersion: "v1alpha" },
				})
			: null;
		console.log("[LLMHelper] Gemini API Key updated.");
	}

	public setGroqApiKey(apiKey: string) {
		this.groqApiKey = apiKey || null;
		this.groqClient = apiKey ? new Groq({ apiKey }) : null;
		console.log("[LLMHelper] Groq API Key updated.");
	}

	public setCerebrasApiKey(apiKey: string) {
		this.cerebrasApiKey = apiKey || null;
		this.cerebrasClient = apiKey
			? new OpenAI({ apiKey, baseURL: CEREBRAS_BASE_URL })
			: null;
		console.log("[LLMHelper] Cerebras API Key updated.");
	}

	public setOpenaiApiKey(apiKey: string) {
		this.openaiApiKey = apiKey || null;
		this.openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
		console.log("[LLMHelper] OpenAI API Key updated.");
	}

	public setClaudeApiKey(apiKey: string) {
		this.claudeApiKey = apiKey || null;
		this.claudeClient = apiKey ? new Anthropic({ apiKey }) : null;
		console.log("[LLMHelper] Claude API Key updated.");
	}

	/**
	 * Initialize the self-improving model version manager.
	 * Should be called after all API keys are configured.
	 * Triggers initial model discovery and starts background scheduler.
	 */
	public async initModelVersionManager(): Promise<void> {
		this.modelVersionManager.setApiKeys({
			openai: this.openaiApiKey,
			gemini: this.apiKey,
			claude: this.claudeApiKey,
			groq: this.groqApiKey,
		});
		await this.modelVersionManager.initialize();
		console.log(this.modelVersionManager.getSummary());
	}

	/**
	 * Scrub all API keys from memory to minimize exposure window.
	 * Called on app quit.
	 */
	public scrubKeys(): void {
		this.apiKey = null;
		this.groqApiKey = null;
		this.cerebrasApiKey = null;
		this.openaiApiKey = null;
		this.claudeApiKey = null;
		this.client = null;
		this.groqClient = null;
		this.cerebrasClient = null;
		this.openaiClient = null;
		this.claudeClient = null;
		// Destroy rate limiters and null reference
		if (this.rateLimiters) {
			Object.values(this.rateLimiters).forEach((rl) => rl.destroy());
			this.rateLimiters = null as any;
		}
		if (this.cacheCleanupInterval) {
			clearInterval(this.cacheCleanupInterval);
			this.cacheCleanupInterval = null;
		}
		this.systemPromptCache.clear();
		this.finalPayloadCache.clear();
		this.responseCache.clear();
		this.inFlightResponseCache.clear();
		// Stop model version manager background scheduler and null reference
		(this.modelVersionManager as ModelVersionManager | null)?.stopScheduler?.();
		this.modelVersionManager = null as any;
		console.log("[LLMHelper] Keys scrubbed from memory");
	}

	public setFastResponseConfig(config: FastResponseConfig) {
		this.fastResponseConfig = {
			enabled: config.enabled === true,
			provider: config.provider === "cerebras" ? "cerebras" : "groq",
			model:
				config.model ||
				(config.provider === "cerebras" ? CEREBRAS_FAST_MODEL : GROQ_MODEL),
		};
		console.log(
			`[LLMHelper] Fast Response Mode: ${this.fastResponseConfig.enabled} via ${this.fastResponseConfig.provider} (${this.fastResponseConfig.model})`,
		);
	}

	public getFastResponseConfig(): FastResponseConfig {
		return { ...this.fastResponseConfig };
	}

	private getDefaultFastModel(provider: FastResponseProvider): string {
		return provider === "cerebras" ? CEREBRAS_FAST_MODEL : GROQ_MODEL;
	}

	public getConfiguredFastModel(provider: FastResponseProvider): string {
		if (
			this.fastResponseConfig.provider === provider &&
			this.fastResponseConfig.model.trim()
		) {
			return this.fastResponseConfig.model.trim();
		}

		return this.getDefaultFastModel(provider);
	}

	public getActiveFastResponseTarget(
		qualityTier: StreamQualityTier = "quality",
	): { provider: FastResponseProvider; model: string } | null {
		if (!this.fastResponseConfig.enabled) {
			return null;
		}

		if (qualityTier === "verify") {
			return null;
		}

		const provider = this.fastResponseConfig.provider;
		if (provider === "cerebras") {
			if (!this.cerebrasClient) return null;
			return { provider, model: this.getConfiguredFastModel(provider) };
		}

		if (!this.groqClient) return null;
		return { provider: "groq", model: this.getConfiguredFastModel("groq") };
	}

	public getAiResponseLanguage(): string {
		return this.aiResponseLanguage;
	}

	// --- Model Type Checkers ---
	public isOpenAiModel(modelId: string): boolean {
		return (
			modelId.startsWith("gpt-") ||
			modelId.startsWith("o1-") ||
			modelId.startsWith("o3-") ||
			modelId.includes("openai")
		);
	}

	public isClaudeModel(modelId: string): boolean {
		return modelId.startsWith("claude-");
	}

	public isGroqModel(modelId: string): boolean {
		return (
			modelId.startsWith("llama-") ||
			modelId.startsWith("mixtral-") ||
			modelId.startsWith("gemma-")
		);
	}

	private isGeminiModel(modelId: string): boolean {
		return modelId.startsWith("gemini-") || modelId.startsWith("models/");
	}
	// ---------------------------

	public currentModelId: string = GEMINI_FLASH_MODEL;

	private prioritizeTierEntries<T extends { family: string }>(
		entries: T[],
		preferredFamily: string | null,
	): T[] {
		if (!preferredFamily) {
			return entries;
		}

		const selected = entries.find((entry) => entry.family === preferredFamily);
		if (!selected) {
			return entries;
		}

		return [
			selected,
			...entries.filter((entry) => entry.family !== preferredFamily),
		];
	}

	private getSelectedTextFamily(): TextModelFamily | null {
		if (this.isOpenAiModel(this.currentModelId)) return TextModelFamily.OPENAI;
		if (this.isClaudeModel(this.currentModelId)) return TextModelFamily.CLAUDE;
		if (this.isGroqModel(this.currentModelId)) return TextModelFamily.GROQ;
		if (
			this.currentModelId.includes("gemini") &&
			this.currentModelId.includes("pro")
		)
			return TextModelFamily.GEMINI_PRO;
		if (this.isGeminiModel(this.currentModelId))
			return TextModelFamily.GEMINI_FLASH;
		return null;
	}

	private getOrderedTextTiers(): Array<
		{ family: TextModelFamily } & TieredModels
	> {
		return this.prioritizeTierEntries(
			this.modelVersionManager.getAllTextTiers(),
			this.getSelectedTextFamily(),
		);
	}

	private getSelectedVisionFamily(): ModelFamily | null {
		if (this.isOpenAiModel(this.currentModelId)) return ModelFamily.OPENAI;
		if (this.isClaudeModel(this.currentModelId)) return ModelFamily.CLAUDE;
		if (this.isGroqModel(this.currentModelId)) return ModelFamily.GROQ_LLAMA;
		if (
			this.currentModelId.includes("gemini") &&
			this.currentModelId.includes("pro")
		)
			return ModelFamily.GEMINI_PRO;
		if (this.isGeminiModel(this.currentModelId))
			return ModelFamily.GEMINI_FLASH;
		return null;
	}

	private getOrderedVisionTiers(): Array<
		{ family: ModelFamily } & TieredModels
	> {
		return this.prioritizeTierEntries(
			this.modelVersionManager.getAllVisionTiers(),
			this.getSelectedVisionFamily(),
		);
	}

	public setModel(
		modelId: string,
		customProviders: (CustomProvider | CurlProvider)[] = [],
	) {
		// Map UI short codes to internal Model IDs
		let targetModelId = modelId;
		if (modelId === "gemini") targetModelId = GEMINI_FLASH_MODEL;
		if (modelId === "gemini-pro") targetModelId = GEMINI_PRO_MODEL;
		if (modelId === "gpt-4o") targetModelId = OPENAI_MODEL;
		if (modelId === "claude") targetModelId = CLAUDE_MODEL;
		if (modelId === "llama") targetModelId = GROQ_MODEL;

		if (targetModelId.startsWith("ollama-")) {
			this.useOllama = true;
			this.ollamaModel = targetModelId.replace("ollama-", "");
			this.customProvider = null;
			this.activeCurlProvider = null;
			console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel}`);
			return;
		}

		const custom = customProviders.find((p) => p.id === targetModelId);
		if (custom) {
			this.useOllama = false;
			this.customProvider = null;
			// Treat text-only custom providers as CurlProviders (responsePath optional)
			this.activeCurlProvider = custom as CurlProvider;
			console.log(`[LLMHelper] Switched to cURL Provider: ${custom.name}`);
			return;
		}

		// Standard Cloud Models
		this.useOllama = false;
		this.customProvider = null;
		this.activeCurlProvider = null;
		this.currentModelId = targetModelId;

		// Update specific model props if needed
		if (targetModelId === GEMINI_PRO_MODEL) this.geminiModel = GEMINI_PRO_MODEL;
		if (targetModelId === GEMINI_FLASH_MODEL)
			this.geminiModel = GEMINI_FLASH_MODEL;

		console.log(`[LLMHelper] Switched to Cloud Model: ${targetModelId}`);
	}

	public setModelFallbackHandler(
		handler: ((event: ModelFallbackEvent) => void) | null,
	): void {
		this.modelFallbackHandler = handler;
	}

	public getActiveOpenAiModel(): string {
		return this.isOpenAiModel(this.currentModelId)
			? this.currentModelId
			: OPENAI_MODEL;
	}

	public isModelNotFoundError(error: any): boolean {
		const status = error?.status || error?.response?.status;
		const message = String(
			error?.response?.data?.error?.message || error?.message || "",
		).toLowerCase();
		return (
			status === 404 ||
			message.includes("does not exist") ||
			message.includes("do not have access") ||
			message.includes("not found")
		);
	}

	private chooseBestAvailableOpenAiModel(
		availableModels: string[],
		failedModel: string,
	): string | null {
		const viable = availableModels
			.filter((id) => id !== failedModel)
			.filter((id) => this.isOpenAiModel(id))
			.filter((id) => classifyTextModel(id) === TextModelFamily.OPENAI);

		if (viable.length === 0) return null;

		try {
			const { CredentialsManager } = require("./services/CredentialsManager");
			const preferred =
				CredentialsManager.getInstance().getPreferredModel("openai");
			if (preferred && viable.includes(preferred)) {
				return preferred;
			}
		} catch {
			// ignore credentials lookup failures during fallback ranking
		}

		return (
			[...viable].sort((a, b) => {
				const aVersion = parseModelVersion(a);
				const bVersion = parseModelVersion(b);
				if (aVersion && bVersion) {
					return compareVersions(bVersion, aVersion);
				}
				if (aVersion) return -1;
				if (bVersion) return 1;
				return a.localeCompare(b);
			})[0] || null
		);
	}

	public async resolveOpenAiFallbackModel(
		failedModel: string,
	): Promise<string | null> {
		if (!this.openaiApiKey) return null;

		try {
			const { fetchProviderModels } = require("./utils/modelFetcher");
			const models = await fetchProviderModels("openai", this.openaiApiKey);
			return this.chooseBestAvailableOpenAiModel(
				models.map((model: { id: string }) => model.id),
				failedModel,
			);
		} catch (error) {
			console.warn(
				"[LLMHelper] Failed to resolve OpenAI fallback model:",
				sanitizeError(error),
			);
			return null;
		}
	}

	public applyModelFallback(event: ModelFallbackEvent): void {
		this.currentModelId = event.fallbackModel;
		this.modelFallbackHandler?.(event);
	}

	public switchToCurl(provider: CurlProvider) {
		this.useOllama = false;
		this.customProvider = null;
		this.activeCurlProvider = provider;
		console.log(`[LLMHelper] Switched to cURL provider: ${provider.name}`);
	}

	public setDeepMode(enabled: boolean): void {
		this.deepMode = enabled;
		console.log(`[LLMHelper] Deep Mode: ${enabled ? "ENABLED" : "DISABLED"}`);
	}

	public isDeepModeActive(): boolean {
		return this.deepMode;
	}

	private restoreStandardProviderClientsForFallback(): void {
		if (!this.client && this.apiKey) {
			this.setApiKey(this.apiKey);
		}
		if (!this.groqClient && this.groqApiKey) {
			this.setGroqApiKey(this.groqApiKey);
		}
		if (!this.cerebrasClient && this.cerebrasApiKey) {
			this.setCerebrasApiKey(this.cerebrasApiKey);
		}
		if (!this.openaiClient && this.openaiApiKey) {
			this.setOpenaiApiKey(this.openaiApiKey);
		}
		if (!this.claudeClient && this.claudeApiKey) {
			this.setClaudeApiKey(this.claudeApiKey);
		}
	}

	public async runWithProviderFallbackBypass<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		const previousCustomProvider = this.customProvider;
		const previousCurlProvider = this.activeCurlProvider;
		this.customProvider = null;
		this.activeCurlProvider = null;
		this.restoreStandardProviderClientsForFallback();

		try {
			return await operation();
		} finally {
			this.customProvider = previousCustomProvider;
			this.activeCurlProvider = previousCurlProvider;
		}
	}

	private async *streamWithProviderFallbackBypass(
		operation: () => AsyncGenerator<string, void, unknown>,
	): AsyncGenerator<string, void, unknown> {
		const previousCustomProvider = this.customProvider;
		const previousCurlProvider = this.activeCurlProvider;
		this.customProvider = null;
		this.activeCurlProvider = null;
		this.restoreStandardProviderClientsForFallback();

		try {
			yield* operation();
		} finally {
			this.customProvider = previousCustomProvider;
			this.activeCurlProvider = previousCurlProvider;
		}
	}

	private cleanJsonResponse(text: string): string {
		// Remove markdown code block syntax if present
		text = text.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "");
		// Remove any leading/trailing whitespace
		text = text.trim();
		return text;
	}

	public async callOllama(prompt: string): Promise<string> {
		try {
			const response = await fetch(`${this.ollamaUrl}/api/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.ollamaModel,
					prompt: prompt,
					stream: false,
					options: {
						temperature: 0.7,
						top_p: 0.9,
					},
				}),
			});

			if (!response.ok) {
				throw new Error(
					`Ollama API error: ${response.status} ${response.statusText}`,
				);
			}

			const data: OllamaResponse = await response.json();
			return data.response;
		} catch (error: any) {
			// console.error("[LLMHelper] Error calling Ollama:", error)
			throw new Error(
				`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`,
			);
		}
	}

	private async checkOllamaAvailable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.ollamaUrl}/api/tags`);
			return response.ok;
		} catch {
			return false;
		}
	}

	private async initializeOllamaModel(): Promise<void> {
		try {
			const availableModels = await this.getOllamaModels();
			if (availableModels.length === 0) {
				// console.warn("[LLMHelper] No Ollama models found")
				return;
			}

			// Check if current model exists, if not use the first available
			if (!availableModels.includes(this.ollamaModel)) {
				this.ollamaModel = availableModels[0];
				// console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
			}

			// Test the selected model works
			await this.callOllama("Hello");
			// console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
		} catch (_error: any) {
			// console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
			// Try to use first available model as fallback
			try {
				const models = await this.getOllamaModels();
				if (models.length > 0) {
					this.ollamaModel = models[0];
					// console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
				}
			} catch (_fallbackError: any) {
				// console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
			}
		}
	}

	/**
	 * Generate content using Gemini 3 Flash (text reasoning)
	 * Used by IntelligenceManager for mode-specific prompts
	 * NOTE: Migrated from Pro to Flash for consistency
	 */
	public async generateWithPro(contents: any[]): Promise<string> {
		return _generateWithPro(this, contents);
	}

	/**
	 * Generate content using Gemini 3 Flash (audio + fast multimodal)
	 * CRITICAL: Audio input MUST use this model, not Pro
	 */
	public async generateWithFlash(contents: any[]): Promise<string> {
		return _generateWithFlash(this, contents);
	}

	/**
	 * Post-process the response
	 * Prompt enforces brevity - no clamping needed
	 */
	public processResponse(text: string): string {
		// Basic cleaning
		const clean = this.cleanJsonResponse(text);

		// Filter out fallback phrases
		const fallbackPhrases = ["I'm not sure", "I can't answer", "I don't know"];

		if (
			fallbackPhrases.some((phrase) =>
				clean.toLowerCase().includes(phrase.toLowerCase()),
			)
		) {
			throw new Error("Filtered fallback response");
		}

		return clean;
	}

	private estimateTokens(text: string): number {
		return this.tokenCounter.count(text, this.getCurrentModel());
	}

	private trimTextToTokenBudget(
		text: string,
		maxTokens: number,
		preserveTail: boolean = false,
	): string {
		if (!text) return text;
		if (this.estimateTokens(text) <= maxTokens) return text;

		const maxChars = this.tokenCounter.estimateCharacterBudget(
			maxTokens,
			this.getCurrentModel(),
		);
		if (preserveTail) {
			return `...[truncated]\n${text.slice(-maxChars)}`;
		}

		return `${text.slice(0, maxChars)}\n...[truncated]`;
	}

	private trimContextToTokenBudget(text: string, maxTokens: number): string {
		if (!text) return text;
		if (this.estimateTokens(text) <= maxTokens) return text;

		const normalizedBudget = Math.max(128, maxTokens);
		const marker = "\n...[middle truncated]\n";
		const maxChars = this.tokenCounter.estimateCharacterBudget(
			normalizedBudget,
			this.getCurrentModel(),
		);

		let headBudget = Math.max(
			96,
			Math.min(Math.floor(normalizedBudget * 0.45), normalizedBudget - 32),
		);
		let tailBudget = Math.max(32, normalizedBudget - headBudget);

		const buildStitched = (
			currentHeadBudget: number,
			currentTailBudget: number,
		): string => {
			const head = this.trimTextToTokenBudget(text, currentHeadBudget, false)
				.replace(/\n\.\.\.\[truncated\]$/u, "")
				.trimEnd();
			const tail = this.trimTextToTokenBudget(text, currentTailBudget, true)
				.replace(/^\.\.\.\[truncated\]\n/u, "")
				.trimStart();
			return `${head}${marker}${tail}`;
		};

		let stitched = buildStitched(headBudget, tailBudget);

		const minHeadBudget = 48;
		const minTailBudget = 24;
		const shrinkStep = 16;
		while (
			this.estimateTokens(stitched) > normalizedBudget &&
			(headBudget > minHeadBudget || tailBudget > minTailBudget)
		) {
			if (headBudget >= tailBudget && headBudget > minHeadBudget) {
				headBudget = Math.max(minHeadBudget, headBudget - shrinkStep);
			} else if (tailBudget > minTailBudget) {
				tailBudget = Math.max(minTailBudget, tailBudget - shrinkStep);
			}

			stitched = buildStitched(headBudget, tailBudget);
		}

		if (this.estimateTokens(stitched) <= normalizedBudget) {
			return stitched;
		}

		const minTailChars = Math.max(48, Math.floor(maxChars * 0.3));
		const allowedHeadChars = Math.max(
			32,
			maxChars - minTailChars - marker.length,
		);
		const fallbackHead = text.slice(0, allowedHeadChars).trimEnd();
		const fallbackTail = text.slice(-minTailChars).trimStart();
		const charBounded = `${fallbackHead}${marker}${fallbackTail}`;

		if (
			charBounded.length <= maxChars &&
			this.estimateTokens(charBounded) <= normalizedBudget
		) {
			return charBounded;
		}

		const tailOnlyChars = Math.max(
			64,
			Math.min(maxChars - marker.length, Math.floor(maxChars * 0.45)),
		);
		const headOnlyChars = Math.max(
			16,
			maxChars - tailOnlyChars - marker.length,
		);
		return `${text.slice(0, headOnlyChars)}${marker}${text.slice(-tailOnlyChars)}`;
	}

	public prepareUserContent(
		message: string,
		context?: string,
		budget: number = DEFAULT_INPUT_TOKEN_BUDGET,
	): string {
		const safeMessage = this.trimTextToTokenBudget(
			message,
			Math.max(512, Math.floor(budget * 0.25)),
		);
		if (!context) {
			return safeMessage;
		}

		const reservedForMessage = this.estimateTokens(safeMessage) + 64;
		const availableForContext = Math.max(512, budget - reservedForMessage);
		const trimmedContext = this.trimContextToTokenBudget(
			context,
			availableForContext,
		);
		return `CONTEXT:\n${trimmedContext}\n\nUSER QUESTION:\n${safeMessage}`;
	}

	public joinPrompt(
		systemPrompt: string | undefined,
		userContent: string,
		budget: number = DEFAULT_INPUT_TOKEN_BUDGET,
	): string {
		if (!systemPrompt) {
			return this.trimContextToTokenBudget(userContent, budget);
		}

		const normalizedSystemPrompt = systemPrompt.trim();
		const separator = "\n\n";
		const reservedForSystem =
			this.estimateTokens(normalizedSystemPrompt) +
			this.estimateTokens(separator);

		if (reservedForSystem >= budget) {
			return this.trimTextToTokenBudget(normalizedSystemPrompt, budget, false);
		}

		const availableForUser = Math.max(64, budget - reservedForSystem);
		let trimmedUserContent = this.trimContextToTokenBudget(
			userContent,
			availableForUser,
		);
		let combined = `${normalizedSystemPrompt}${separator}${trimmedUserContent}`;

		if (this.estimateTokens(combined) <= budget) {
			return combined;
		}

		const overflowTokens = this.estimateTokens(combined) - budget;
		const tightenedUserBudget = Math.max(
			32,
			availableForUser - overflowTokens - 16,
		);
		trimmedUserContent = this.trimContextToTokenBudget(
			userContent,
			tightenedUserBudget,
		);
		combined = `${normalizedSystemPrompt}${separator}${trimmedUserContent}`;

		if (this.estimateTokens(combined) <= budget) {
			return combined;
		}

		const shrunkSystemBudget = Math.max(64, budget - 64);
		const shrunkSystemPrompt = this.trimTextToTokenBudget(
			normalizedSystemPrompt,
			shrunkSystemBudget,
			false,
		);
		const remainingForUser = Math.max(
			0,
			budget -
				this.estimateTokens(shrunkSystemPrompt) -
				this.estimateTokens(separator),
		);

		if (remainingForUser === 0) {
			return shrunkSystemPrompt;
		}

		return `${shrunkSystemPrompt}${separator}${this.trimContextToTokenBudget(userContent, remainingForUser)}`;
	}

	/**
	 * Retry logic with exponential backoff
	 * Handles common transient provider failures consistently.
	 */
	private isRetryableError(error: any): boolean {
		const status =
			error?.status ??
			error?.statusCode ??
			error?.response?.status ??
			error?.error?.status;
		const code = String(error?.code ?? error?.error?.code ?? "").toLowerCase();
		const type = String(error?.type ?? error?.error?.type ?? "").toLowerCase();
		const message = [
			error?.message,
			error?.error?.message,
			error?.cause?.message,
			error,
		]
			.filter(Boolean)
			.map((value) => String(value).toLowerCase())
			.join(" ");

		return (
			status === 408 ||
			status === 409 ||
			status === 425 ||
			status === 429 ||
			status === 500 ||
			status === 502 ||
			status === 503 ||
			status === 504 ||
			code === "econnreset" ||
			code === "etimedout" ||
			code === "eai_again" ||
			type.includes("overloaded") ||
			type.includes("rate_limit") ||
			message.includes("503") ||
			message.includes("502") ||
			message.includes("504") ||
			message.includes("429") ||
			message.includes("500") ||
			message.includes("overloaded") ||
			message.includes("rate limit") ||
			message.includes("temporarily unavailable") ||
			message.includes("timeout") ||
			message.includes("temporar") ||
			message.includes("econnreset") ||
			message.includes("network")
		);
	}

	private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
		let delay = 400;
		for (let i = 0; i < retries; i++) {
			try {
				return await fn();
			} catch (e: any) {
				if (!this.isRetryableError(e)) throw e;
				if (i === retries - 1) break;

				console.warn(
					`[LLMHelper] Transient model failure. Retrying in ${delay}ms...`,
				);
				await this.delay(delay);
				delay *= 2;
			}
		}
		throw new Error("Model busy, try again");
	}

	/**
	 * Generate content using the currently selected model
	 */
	private async generateContent(
		contents: any[],
		modelIdOverride?: string,
	): Promise<string> {
		if (!this.client) throw new Error("Gemini client not initialized");

		const targetModel = modelIdOverride || this.geminiModel;
		console.log(`[LLMHelper] Calling ${targetModel}...`);
		const systemPromptHash = "";
		const payloadHash = this.hashValue({
			contents,
			config: {
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.4,
			},
		});

		return this.withResponseCache(
			"gemini",
			targetModel,
			systemPromptHash,
			payloadHash,
			() =>
				this.withRetry(async () => {
					const requestPayload = await this.withFinalPayloadCache(
						"gemini",
						targetModel,
						systemPromptHash,
						payloadHash,
						() => ({
							model: targetModel,
							contents,
							config: {
								maxOutputTokens: MAX_OUTPUT_TOKENS,
								temperature: 0.4,
							},
						}),
					);

					const response =
						await this.client?.models.generateContent(requestPayload);

					// Debug: log full response structure
					// console.log(`[LLMHelper] Full response:`, JSON.stringify(response, null, 2).substring(0, 500))

					const candidate = response.candidates?.[0];
					if (!candidate) {
						console.error("[LLMHelper] No candidates returned!");
						console.error(
							"[LLMHelper] Full response:",
							JSON.stringify(response, null, 2).substring(0, 1000),
						);
						return "";
					}

					if (candidate.finishReason && candidate.finishReason !== "STOP") {
						console.warn(
							`[LLMHelper] Generation stopped with reason: ${candidate.finishReason}`,
						);
						console.warn(
							`[LLMHelper] Safety ratings:`,
							JSON.stringify(candidate.safetyRatings),
						);
					}

					// Try multiple ways to access text - handle different response structures
					let text = "";

					// Method 1: Direct response.text
					if (response.text) {
						text = response.text;
					}
					// Method 2: candidate.content.parts array (check all parts)
					else if (candidate.content?.parts) {
						const parts = Array.isArray(candidate.content.parts)
							? candidate.content.parts
							: [candidate.content.parts];
						for (const part of parts) {
							if (part?.text) {
								text += part.text;
							}
						}
					}
					// Method 3: candidate.content directly (if it's a string)
					else if (typeof candidate.content === "string") {
						text = candidate.content;
					}

					if (!text || text.trim().length === 0) {
						console.error("[LLMHelper] Candidate found but text is empty.");
						console.error(
							"[LLMHelper] Response structure:",
							JSON.stringify(
								{
									hasResponseText: !!response.text,
									candidateFinishReason: candidate.finishReason,
									candidateContent: candidate.content,
									candidateParts: candidate.content?.parts,
								},
								null,
								2,
							),
						);

						if (candidate.finishReason === "MAX_TOKENS") {
							return "Response was truncated due to length limit. Please try a shorter question or break it into parts.";
						}

						return "";
					}

					console.log(`[LLMHelper] Extracted text length: ${text.length}`);
					return text;
				}),
		);
	}

	public async extractProblemFromImages(imagePaths: string[]) {
		const prompt = `You are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`;

		const text = await this.generateWithVisionFallback(
			IMAGE_ANALYSIS_PROMPT,
			prompt,
			imagePaths,
		);
		return JSON.parse(this.cleanJsonResponse(text));
	}

	public async generateSolution(problemInfo: any, signal?: AbortSignal) {
		const prompt = `Given this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`;
		throwIfAborted(signal);
		const text = await this.generateWithVisionFallback(
			IMAGE_ANALYSIS_PROMPT,
			prompt,
			[],
			signal,
		);
		throwIfAborted(signal);
		const parsed = JSON.parse(this.cleanJsonResponse(text));
		return parsed;
	}

	public async debugSolutionWithImages(
		problemInfo: any,
		currentCode: string,
		debugImagePaths: string[],
		signal?: AbortSignal,
	) {
		const prompt = `You are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`;

		throwIfAborted(signal);
		const text = await this.generateWithVisionFallback(
			IMAGE_ANALYSIS_PROMPT,
			prompt,
			debugImagePaths,
			signal,
		);
		throwIfAborted(signal);
		const parsed = JSON.parse(this.cleanJsonResponse(text));
		return parsed;
	}

	/**
	 * NEW: Helper to process image: resize to max 1536px and compress to JPEG 80%
	 * drastically reduces token usage and upload time.
	 */
	private async processImage(
		path: string,
	): Promise<{ mimeType: string; data: string }> {
		try {
			const imageBuffer = await fs.promises.readFile(path);

			// Resize and compress
			const processedBuffer = await sharp(imageBuffer)
				.resize({
					width: 1536,
					height: 1536,
					fit: "inside", // Maintain aspect ratio, max dimension 1536
					withoutEnlargement: true,
				})
				.jpeg({ quality: 80 }) // 80% quality JPEG is much smaller than PNG
				.toBuffer();

			return {
				mimeType: "image/jpeg",
				data: processedBuffer.toString("base64"),
			};
		} catch (error) {
			console.error(
				"[LLMHelper] Failed to process image with sharp:",
				sanitizeError(error),
			);
			// Fallback to raw read if sharp fails
			const data = await fs.promises.readFile(path);
			return {
				mimeType: "image/png",
				data: data.toString("base64"),
			};
		}
	}

	public async analyzeImageFiles(imagePaths: string[], signal?: AbortSignal) {
		try {
			const prompt = `Review ${imagePaths.length > 1 ? "these screenshots" : "this screenshot"} and respond according to the screenshot-event workflow.`;
			throwIfAborted(signal);
			const text = await this.generateWithVisionFallback(
				SCREENSHOT_EVENT_PROMPT,
				prompt,
				imagePaths,
				signal,
			);
			throwIfAborted(signal);

			return { text: text, timestamp: Date.now() };
		} catch (error: any) {
			console.error("Error analyzing image files:", sanitizeError(error));
			return {
				text: `I couldn't analyze the screen right now (${error.message}). Please try again.`,
				timestamp: Date.now(),
			};
		}
	}

	/**
	 * Generate a suggestion based on conversation transcript - Natively-style
	 * This uses Gemini Flash to reason about what the user should say
	 * @param context - The full conversation transcript
	 * @param lastQuestion - The most recent question from the interviewer
	 * @returns Suggested response for the user
	 */
	public async generateSuggestion(
		context: string,
		lastQuestion: string,
	): Promise<string> {
		const systemPrompt = `${CORE_IDENTITY}

${UNIVERSAL_ANTI_DUMP_RULES}

Provide a concise, natural response the user could say in their interview.

RULES:
- Be direct and conversational
- Keep responses under 3 sentences for simple questions
- Focus on answering the specific question asked
- If technical, provide a clear, structured answer with code if needed
- Do NOT preface with "You could say" - just give the answer directly
- Never hedge. Never say "it depends".
- NON-CODE ANSWERS >100 WORDS ARE WRONG. DELETE AND REWRITE SHORTER.

CONVERSATION SO FAR:
${context}

LATEST QUESTION FROM INTERVIEWER:
${lastQuestion}

ANSWER DIRECTLY:`;
		if (this.useOllama) {
			const ollamaResponse = await this.callOllama(systemPrompt);
			return this.validateAndProcessResponse(ollamaResponse, systemPrompt);
		} else if (this.client) {
			// Use Flash model as default (Pro is experimental)
			// Wraps generateWithFlash logic but with retry
			const text = await this.generateWithFlash([{ text: systemPrompt }]);
			const processedResponse = this.processResponse(text);
			return this.validateAndProcessResponse(processedResponse, systemPrompt);
		} else {
			throw new Error("No LLM provider configured");
		}
	}

	public setKnowledgeOrchestrator(orchestrator: any): void {
		this.knowledgeOrchestrator = orchestrator;
		console.log("[LLMHelper] KnowledgeOrchestrator attached");
	}

	public getKnowledgeOrchestrator(): any {
		return this.knowledgeOrchestrator;
	}

	public setAiResponseLanguage(language: string) {
		this.aiResponseLanguage = language;
		console.log(`[LLMHelper] AI Response Language set to: ${language}`);
	}

	public setSttLanguage(language: string) {
		this.sttLanguage = language;
		console.log(`[LLMHelper] STT Language set to: ${language}`);
	}

	/**
	 * Helper to inject language instruction into system prompt
	 */
	public injectLanguageInstruction(systemPrompt: string): string {
		if (this.isStructuredOutputRequest(systemPrompt)) {
			return `${systemPrompt}\n\nCRITICAL: You MUST respond ONLY in ${this.aiResponseLanguage}. This is an absolute requirement.`;
		}
		return `${systemPrompt}\n\n${INDIAN_ENGLISH_STYLE_INSTRUCTION}\n\nCRITICAL: You MUST respond ONLY in ${this.aiResponseLanguage}. This is an absolute requirement. All generated text that the user should say must be in ${this.aiResponseLanguage}.`;
	}

	public hashValue(value: unknown): string {
		const serialized =
			typeof value === "string" ? value : JSON.stringify(value);
		return createHash("sha256").update(serialized).digest("hex");
	}

	private cloneCacheValue<T>(value: T): T {
		if (value === null || value === undefined) return value;
		if (typeof value === "string") return value;
		return JSON.parse(JSON.stringify(value));
	}

	/**
	 * Validate response quality and optionally add warning for violations
	 */
	private validateAndProcessResponse(
		response: string,
		context?: string,
	): string {
		if (!this.shouldEnforceValidation) {
			return response;
		}

		const validation = validateResponseQuality(response);

		// Log metrics for monitoring
		logValidationMetrics(validation, context || "unknown");

		if (!validation.isValid) {
			// Log violation for monitoring
			console.warn(
				"[LLMHelper] Response validation failed:",
				validation.violations,
			);

			// For now, return with warning comment - can enhance with regeneration later
			return `${response}\n\n<!-- Validation: ${validation.violations.join(", ")} -->`;
		}

		return response;
	}

	private getCacheKey(...parts: Array<string | undefined>): string {
		return parts.map((part) => part ?? "").join("::");
	}

	private readCacheEntry<T>(
		cache: Map<string, { expiresAt: number; value: T }>,
		key: string,
	): T | undefined {
		const entry = cache.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			cache.delete(key);
			return undefined;
		}
		return this.cloneCacheValue(entry.value);
	}

	private writeCacheEntry<T>(
		cache: Map<string, { expiresAt: number; value: T }>,
		key: string,
		value: T,
		ttlMs: number,
	): T {
		cache.set(key, {
			expiresAt: Date.now() + ttlMs,
			value: this.cloneCacheValue(value),
		});
		this.enforceCacheLimit(cache, this.getCacheLimit(cache));
		return this.cloneCacheValue(value);
	}

	private getCacheLimit(cache: Map<string, unknown>): number {
		if (cache === this.systemPromptCache) return SYSTEM_PROMPT_CACHE_MAX;
		if (cache === this.finalPayloadCache) return FINAL_PAYLOAD_CACHE_MAX;
		if (cache === this.responseCache) return RESPONSE_CACHE_MAX;
		return RESPONSE_CACHE_MAX;
	}

	private enforceCacheLimit<T>(
		cache: Map<string, T>,
		maxEntries: number,
	): void {
		while (cache.size > maxEntries) {
			const oldestKey = cache.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			cache.delete(oldestKey);
		}
	}

	private cleanupExpiredCaches(): void {
		const now = Date.now();
		for (const cache of [
			this.systemPromptCache,
			this.finalPayloadCache,
			this.responseCache,
		]) {
			for (const [key, value] of cache.entries()) {
				if (value.expiresAt <= now) {
					cache.delete(key);
				}
			}
		}
	}

	public async withSystemPromptCache(
		provider: string,
		model: string,
		basePrompt: string,
		builder: () => Promise<string> | string,
		ttlMs: number = SYSTEM_PROMPT_CACHE_TTL_MS,
	): Promise<string> {
		const cacheKey = this.getCacheKey(
			"system-prompt",
			provider,
			model,
			this.hashValue(basePrompt),
			this.aiResponseLanguage,
		);
		const cached = this.readCacheEntry(this.systemPromptCache, cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const built = await builder();
		return this.writeCacheEntry(this.systemPromptCache, cacheKey, built, ttlMs);
	}

	public async withFinalPayloadCache<T>(
		provider: string,
		model: string,
		systemPromptHash: string,
		payloadHash: string,
		builder: () => Promise<T> | T,
		ttlMs: number = FINAL_PAYLOAD_CACHE_TTL_MS,
	): Promise<T> {
		const cacheKey = this.getCacheKey(
			"final-payload",
			provider,
			model,
			systemPromptHash,
			payloadHash,
		);
		const cached = this.readCacheEntry(this.finalPayloadCache, cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const built = await builder();
		return this.writeCacheEntry(this.finalPayloadCache, cacheKey, built, ttlMs);
	}

	public async withResponseCache(
		provider: string,
		model: string,
		systemPromptHash: string,
		payloadHash: string,
		request: () => Promise<string>,
		ttlMs: number = RESPONSE_CACHE_TTL_MS,
	): Promise<string> {
		const cacheKey = this.getCacheKey(
			"response",
			provider,
			model,
			systemPromptHash,
			payloadHash,
		);
		const cached = this.readCacheEntry(this.responseCache, cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const inFlight = this.inFlightResponseCache.get(cacheKey);
		if (inFlight) {
			return inFlight;
		}

		if (this.inFlightResponseCache.size >= IN_FLIGHT_RESPONSE_CACHE_MAX) {
			const oldestKey = this.inFlightResponseCache.keys().next().value;
			if (oldestKey !== undefined) {
				this.inFlightResponseCache.delete(oldestKey);
			}
		}

		const pending = request()
			.then((result) => {
				this.writeCacheEntry(this.responseCache, cacheKey, result, ttlMs);
				this.inFlightResponseCache.delete(cacheKey);
				return result;
			})
			.catch((error) => {
				this.inFlightResponseCache.delete(cacheKey);
				throw error;
			});

		this.inFlightResponseCache.set(cacheKey, pending);
		return pending;
	}

	public getInputTokenBudget(
		provider: string,
		modelId: string,
		summaryMode: boolean = false,
	): number {
		if (summaryMode) {
			return SUMMARY_INPUT_TOKEN_BUDGET;
		}

		const normalizedProvider = provider.toLowerCase();
		const normalizedModelId = modelId.toLowerCase();

		if (
			normalizedProvider === "claude" ||
			normalizedModelId.startsWith("claude-")
		)
			return CLAUDE_INPUT_TOKEN_BUDGET;
		if (normalizedProvider === "cerebras") return CEREBRAS_INPUT_TOKEN_BUDGET;
		if (
			normalizedProvider === "openai" ||
			this.isOpenAiModel(normalizedModelId)
		)
			return OPENAI_INPUT_TOKEN_BUDGET;
		if (
			normalizedProvider === "groq" ||
			normalizedProvider === "text_groq" ||
			this.isGroqModel(normalizedModelId)
		)
			return GROQ_INPUT_TOKEN_BUDGET;
		if (
			normalizedProvider === "gemini_pro" ||
			(normalizedModelId.includes("gemini") &&
				normalizedModelId.includes("pro"))
		)
			return GEMINI_PRO_INPUT_TOKEN_BUDGET;
		if (
			normalizedProvider === "gemini" ||
			normalizedProvider === "gemini_flash" ||
			this.isGeminiModel(normalizedModelId)
		)
			return GEMINI_FLASH_INPUT_TOKEN_BUDGET;
		if (
			normalizedProvider === "ollama" ||
			normalizedProvider === "custom" ||
			normalizedProvider === "curl"
		)
			return LOCAL_INPUT_TOKEN_BUDGET;

		return DEFAULT_INPUT_TOKEN_BUDGET;
	}

	public prepareUserContentForModel(
		provider: string,
		modelId: string,
		message: string,
		context?: string,
	): string {
		return this.prepareUserContent(
			message,
			context,
			this.getInputTokenBudget(provider, modelId),
		);
	}

	private wantsDetailedResponse(message: string): boolean {
		return /\b(detailed|detail|deep dive|in depth|step by step|thorough|comprehensive|elaborate|full explanation|longer version)\b/i.test(
			message,
		);
	}

	public isStructuredOutputRequest(input?: string): boolean {
		if (!input) return false;
		return /(STRUCTURED_REASONING_RESPONSE|Return JSON|mode, openingReasoning, implementationPlan|JSON with keys|reasoning_first)/i.test(
			input,
		);
	}

	public applyDefaultBrevityHint(message: string): string {
		if (
			this.wantsDetailedResponse(message) ||
			this.isStructuredOutputRequest(message)
		) {
			return message;
		}
		return `${message}\n\nAnswer briefly and directly. Keep it to 2-3 short sentences unless code is required.`;
	}

	private trimScreenshotFallbackText(text: string): string {
		if (text.length <= SCREENSHOT_FALLBACK_TEXT_LIMIT_CHARS) {
			return text;
		}
		return `${text.slice(0, SCREENSHOT_FALLBACK_TEXT_LIMIT_CHARS)}\n...[image text fallback truncated]`;
	}

	private appendScreenshotTextFallback(
		message: string,
		fallbackText: string,
	): string {
		const trimmedMessage = message.trim();
		const sections: string[] = [];

		if (trimmedMessage) {
			sections.push(trimmedMessage);
		}

		sections.push("SCREENSHOT_TEXT_FALLBACK:");
		sections.push(fallbackText || "[unable to extract text from images]");

		return sections.join("\n\n");
	}

	private async extractImageTextWithTesseract(
		imagePaths: string[],
		signal?: AbortSignal,
	): Promise<string> {
		const chunks: string[] = [];

		for (let i = 0; i < imagePaths.length; i++) {
			throwIfAborted(signal);
			const imagePath = imagePaths[i];
			const label = `Image ${i + 1}`;

			if (!imagePath || !fs.existsSync(imagePath)) {
				chunks.push(`${label}: [missing image file]`);
				continue;
			}

			try {
				const result = await Tesseract.recognize(imagePath, "eng");
				throwIfAborted(signal);
				const text = (result?.data?.text || "").trim();
				chunks.push(
					text ? `${label}:\n${text}` : `${label}: [no text extracted]`,
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				chunks.push(`${label}: [tesseract failed: ${reason}]`);
			}
		}

		return this.trimScreenshotFallbackText(chunks.join("\n\n").trim());
	}

	private curlLikelyAcceptsImages(curlCommand: string): boolean {
		const command = curlCommand.toLowerCase();

		if (
			command.includes("{{image_base64}}") ||
			command.includes("{{image_base64s}}") ||
			command.includes("{{openai_user_content}}") ||
			command.includes("{{openai_messages}}")
		) {
			return true;
		}

		if (command.includes("image_url") || command.includes("data:image/")) {
			return true;
		}

		return false;
	}

	public shouldForceScreenshotTextFallback(imagePaths?: string[]): boolean {
		if (!imagePaths?.length) {
			return false;
		}

		if (this.useOllama) {
			return true;
		}

		if (this.activeCurlProvider) {
			return !this.curlLikelyAcceptsImages(
				this.activeCurlProvider.curlCommand || "",
			);
		}

		if (this.customProvider) {
			return !this.curlLikelyAcceptsImages(
				this.customProvider.curlCommand || "",
			);
		}

		return false;
	}

	private isImageCapabilityError(error: unknown): boolean {
		const err = error as any;
		const status =
			err?.status ??
			err?.statusCode ??
			err?.response?.status ??
			err?.error?.status;
		const code = String(err?.code ?? err?.error?.code ?? "").toLowerCase();
		const type = String(err?.type ?? err?.error?.type ?? "").toLowerCase();
		const message = [
			err?.message,
			err?.error?.message,
			err?.response?.data?.error?.message,
			err?.response?.data,
			err?.cause?.message,
		]
			.filter(Boolean)
			.map((value) =>
				typeof value === "string" ? value : JSON.stringify(value),
			)
			.join(" ")
			.toLowerCase();

		const combined = `${code} ${type} ${message}`;
		const mentionsImageInput =
			/(image|vision|multimodal|multi-modal|modalit|image_url|inline_?data|media_type|base64|data:image|content part)/i.test(
				combined,
			);
		const mentionsUnsupportedCapability =
			/(unsupported|not support|does not support|doesn't support|not accept|does not accept|can't process|cannot process|text[- ]only|invalid content|invalid image|bad request|refus|unavailable)/i.test(
				combined,
			);

		return Boolean(
			mentionsImageInput &&
				(mentionsUnsupportedCapability ||
					status === 400 ||
					status === 415 ||
					status === 422),
		);
	}

	private shouldRetryScreenshotWithOcr(
		error: unknown,
		imagePaths?: string[],
	): boolean {
		return !!imagePaths?.length && this.isImageCapabilityError(error);
	}

	private async buildScreenshotTextFallbackMessage(
		message: string,
		imagePaths: string[],
		signal?: AbortSignal,
	): Promise<string> {
		const fallbackText = await this.extractImageTextWithTesseract(
			imagePaths,
			signal,
		);
		return this.appendScreenshotTextFallback(message, fallbackText);
	}

	public async runWithScreenshotOcrFallback<T>(
		label: string,
		imagePaths: string[] | undefined,
		originalMessage: string,
		imageRequest: () => Promise<T>,
		textRequest: (fallbackMessage: string) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		try {
			return await imageRequest();
		} catch (error) {
			if (!this.shouldRetryScreenshotWithOcr(error, imagePaths)) {
				throw error;
			}

			console.warn(
				`[LLMHelper] ${label} rejected image input. Falling back to local OCR text.`,
			);
			throwIfAborted(signal);
			if (!imagePaths) {
				throw new Error("imagePaths is required for OCR fallback");
			}
			const fallbackMessage = await this.buildScreenshotTextFallbackMessage(
				originalMessage,
				imagePaths,
				signal,
			);
			throwIfAborted(signal);
			return textRequest(fallbackMessage);
		}
	}

	private async *streamWithScreenshotOcrFallback(
		label: string,
		imagePaths: string[] | undefined,
		originalMessage: string,
		imageStream: () => AsyncGenerator<string, void, unknown>,
		textStream: (
			fallbackMessage: string,
		) => AsyncGenerator<string, void, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		try {
			yield* imageStream();
		} catch (error) {
			if (!this.shouldRetryScreenshotWithOcr(error, imagePaths)) {
				throw error;
			}

			console.warn(
				`[LLMHelper] ${label} rejected image input. Falling back to local OCR text.`,
			);
			throwIfAborted(signal);
			if (!imagePaths) {
				throw new Error("imagePaths is required for OCR fallback");
			}
			const fallbackMessage = await this.buildScreenshotTextFallbackMessage(
				originalMessage,
				imagePaths,
				signal,
			);
			throwIfAborted(signal);
			yield* textStream(fallbackMessage);
		}
	}

	public async prepareScreenshotEventRouting(
		input: ScreenshotEventRoutingInput,
	): Promise<ScreenshotEventRoutingResult> {
		const fallbackText = input.forceTextFallback
			? await this.extractImageTextWithTesseract(input.imagePaths, input.signal)
			: "";

		return {
			userMessage: input.forceTextFallback
				? this.appendScreenshotTextFallback(input.message, fallbackText)
				: input.message,
			context: input.context,
			systemPrompt: SCREENSHOT_EVENT_PROMPT,
			imagePaths: input.forceTextFallback ? [] : input.imagePaths,
		};
	}

	private getStreamProviderCacheKey(): string {
		return this.activeCurlProvider
			? `curl:${this.activeCurlProvider.id}`
			: this.isOpenAiModel(this.currentModelId)
				? "openai"
				: this.isClaudeModel(this.currentModelId)
					? "claude"
					: this.isGroqModel(this.currentModelId)
						? "groq"
						: this.useOllama
							? "ollama"
							: "gemini";
	}

	private async connectToProvider(abortSignal?: AbortSignal): Promise<void> {
		throwIfAborted(abortSignal);
		// NAT-037: keep provider pre-connect strictly non-blocking for the stream
		// hot path. Real SDK calls establish connections lazily on first request.
		// We intentionally avoid eager network handshakes here (especially Ollama),
		// since they can dominate TTFT and make tests appear hung.
		return;
	}

	private async prepareKnowledgeInterceptionForStream(
		message: string,
	): Promise<StreamKnowledgeInterceptionResult | null> {
		if (!this.knowledgeOrchestrator?.isKnowledgeMode()) {
			return null;
		}
		const knowledgeResult =
			await this.knowledgeOrchestrator.processQuestion(message);
		if (!knowledgeResult) {
			return null;
		}
		return {
			introResponse: knowledgeResult.isIntroQuestion
				? knowledgeResult.introResponse
				: undefined,
			contextBlock: knowledgeResult.contextBlock,
			systemPromptInjection: knowledgeResult.systemPromptInjection,
		};
	}

	public async warmStreamChatPromptCache(): Promise<void> {
		const providerCacheKey = this.getStreamProviderCacheKey();
		const baseSystemPrompt = HARD_SYSTEM_PROMPT;
		await this.withSystemPromptCache(
			providerCacheKey,
			this.getCurrentModel(),
			baseSystemPrompt,
			() => this.injectLanguageInstruction(baseSystemPrompt),
		);
	}

	public async chatWithGemini(
		message: string,
		imagePaths?: string[],
		context?: string,
		skipSystemPrompt: boolean = false,
		alternateGroqMessage?: string,
	): Promise<string> {
		return _chatWithGemini(
			this,
			message,
			imagePaths,
			context,
			skipSystemPrompt,
			alternateGroqMessage,
		);
	}

	/**
	 * Generate content using only reasoning-capable models.
	 * Priority: OpenAI → Claude → Gemini Pro → Groq (last resort).
	 * Used for structured JSON output tasks (resume/JD/company research).
	 * NOTE: Does NOT mutate this.geminiModel — calls Gemini Pro directly to avoid race conditions.
	 */
	public async generateContentStructured(message: string): Promise<string> {
		type ProviderAttempt = { name: string; execute: () => Promise<string> };
		const providers: ProviderAttempt[] = [];

		// Priority 1: OpenAI
		if (this.openaiClient) {
			providers.push({
				name: `OpenAI (${OPENAI_MODEL})`,
				execute: () => this.generateWithOpenai(message),
			});
		}

		// Priority 2: Claude
		if (this.claudeClient) {
			providers.push({
				name: `Claude (${CLAUDE_MODEL})`,
				execute: () => this.generateWithClaude(message),
			});
		}

		// Priority 3: Gemini Pro (Skip Flash, and don't mutate this.geminiModel to avoid race conditions)
		if (this.client) {
			providers.push({
				name: `Gemini Pro (${GEMINI_PRO_MODEL})`,
				execute: async () => {
					// Call the API directly with the Pro model instead of touching shared state
					const response = await this.withRetry(async () => {
						const res = await this.client?.models.generateContent({
							model: GEMINI_PRO_MODEL,
							contents: [{ role: "user", parts: [{ text: message }] }],
							config: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
						});
						const candidate = res.candidates?.[0];
						if (!candidate) return "";
						if (res.text) return res.text;
						const parts = candidate.content?.parts ?? [];
						return (Array.isArray(parts) ? parts : [parts])
							.map((p: any) => p?.text ?? "")
							.join("");
					});
					return response;
				},
			});
		}

		// Priority 4: Groq (Fallback despite JSON hallucination risks)
		if (this.groqClient) {
			providers.push({
				name: `Groq (${GROQ_MODEL}) fallback`,
				execute: () => this.generateWithGroq(message),
			});
		}

		if (providers.length === 0) {
			throw new Error(
				"No reasoning model available. Please configure an OpenAI, Claude, Gemini, or Groq API key.",
			);
		}

		for (const provider of providers) {
			try {
				console.log(
					`[LLMHelper] 🧠 Structured generation: trying ${provider.name}...`,
				);
				const result = await this.withRetry(() => provider.execute(), 3);
				if (result && result.trim().length > 0) {
					console.log(
						`[LLMHelper] ✅ Structured generation succeeded with ${provider.name}`,
					);
					return result;
				}
				console.warn(`[LLMHelper] ⚠️ ${provider.name} returned empty response`);
			} catch (error: any) {
				console.warn(
					`[LLMHelper] ⚠️ Structured generation: ${provider.name} failed: ${error.message}`,
				);
			}
		}

		throw new Error("All reasoning models failed for structured generation");
	}

	public async generateWithGroq(
		fullMessage: string,
		modelOverride: string = GROQ_MODEL,
	): Promise<string> {
		return _generateWithGroq(this, fullMessage, modelOverride);
	}

	public async generateWithCerebras(
		userMessage: string,
		systemPrompt?: string,
		modelOverride?: string,
	): Promise<string> {
		return _generateWithCerebras(
			this,
			userMessage,
			systemPrompt,
			modelOverride,
		);
	}

	/**
	 * Non-streaming OpenAI generation with proper system/user separation
	 */
	public async generateWithOpenai(
		userMessage: string,
		systemPrompt?: string,
		imagePaths?: string[],
		modelOverride?: string,
		allowFallback: boolean = true,
	): Promise<string> {
		if (!this.openaiClient) throw new Error("OpenAI client not initialized");

		const targetModel = modelOverride || this.getActiveOpenAiModel();

		await this.rateLimiters.openai.acquire();
		const systemPromptHash = this.hashValue(systemPrompt || "");
		const payloadHash = this.hashValue({
			model: targetModel,
			userMessage,
			systemPrompt: systemPrompt || "",
			imagePaths: imagePaths || [],
		});

		return this.withResponseCache(
			"openai",
			targetModel,
			systemPromptHash,
			payloadHash,
			async () => {
				const requestPayload = await this.withFinalPayloadCache(
					"openai",
					targetModel,
					systemPromptHash,
					payloadHash,
					async () => {
						const messages: any[] = [];
						if (systemPrompt) {
							messages.push({ role: "system", content: systemPrompt });
						}

						if (imagePaths?.length) {
							const contentParts: any[] = [{ type: "text", text: userMessage }];
							for (const p of imagePaths) {
								if (fs.existsSync(p)) {
									const imageData = await fs.promises.readFile(p);
									contentParts.push({
										type: "image_url",
										image_url: {
											url: `data:image/png;base64,${imageData.toString("base64")}`,
										},
									});
								}
							}
							messages.push({ role: "user", content: contentParts });
						} else {
							messages.push({ role: "user", content: userMessage });
						}

						return {
							model: targetModel,
							messages,
							max_completion_tokens: MAX_OUTPUT_TOKENS,
						};
					},
				);

				try {
					const response = await withTimeout(
						this.openaiClient?.chat.completions.create(requestPayload as any),
						LLM_API_TIMEOUT_MS,
					);
					return response.choices[0]?.message?.content || "";
				} catch (error) {
					if (allowFallback && this.isModelNotFoundError(error)) {
						const fallbackModel =
							await this.resolveOpenAiFallbackModel(targetModel);
						if (fallbackModel && fallbackModel !== targetModel) {
							this.applyModelFallback({
								provider: "openai",
								previousModel: targetModel,
								fallbackModel,
								reason: "model_not_found",
							});
							return this.generateWithOpenai(
								userMessage,
								systemPrompt,
								imagePaths,
								fallbackModel,
								false,
							);
						}
					}
					throw error;
				}
			},
		);
	}

	private async readImagesAsBase64(imagePaths?: string[]): Promise<string[]> {
		if (!imagePaths?.length) return [];

		const encodedImages: string[] = [];
		for (const imagePath of imagePaths) {
			if (!imagePath || !fs.existsSync(imagePath)) {
				continue;
			}

			try {
				const imageData = await fs.promises.readFile(imagePath);
				const base64Image = imageData.toString("base64");
				if (base64Image) {
					encodedImages.push(base64Image);
				}
			} catch (error) {
				console.warn(
					"[LLMHelper] Failed to read image for cURL provider:",
					sanitizeError(error),
				);
			}
		}

		return encodedImages;
	}

	private isEmptyInlineImageDataUrl(value: string): boolean {
		return /^data:image\/[a-zA-Z0-9.+-]+;base64,\s*$/.test(value.trim());
	}

	private isEmptyImageContentPart(payload: Record<string, unknown>): boolean {
		if (payload.type !== "image_url") {
			return false;
		}

		const imageUrl = payload.image_url;
		if (typeof imageUrl === "string") {
			return this.isEmptyInlineImageDataUrl(imageUrl);
		}

		if (!imageUrl || typeof imageUrl !== "object") {
			return false;
		}

		const url = (imageUrl as Record<string, unknown>).url;
		return typeof url === "string" && this.isEmptyInlineImageDataUrl(url);
	}

	private isEmptyTextContentPart(payload: Record<string, unknown>): boolean {
		return (
			payload.type === "text" &&
			typeof payload.text === "string" &&
			payload.text.trim().length === 0
		);
	}

	private collapseOpenAiMessageContent(content: unknown[]): unknown {
		if (content.length === 1) {
			const onlyPart = content[0];
			if (
				onlyPart &&
				typeof onlyPart === "object" &&
				(onlyPart as Record<string, unknown>).type === "text" &&
				typeof (onlyPart as Record<string, unknown>).text === "string"
			) {
				return (onlyPart as Record<string, string>).text;
			}
		}

		return content;
	}

	private compactProviderPayload(payload: unknown): unknown {
		if (Array.isArray(payload)) {
			return payload
				.map((item) => this.compactProviderPayload(item))
				.filter((item) => item !== undefined);
		}

		if (!payload || typeof payload !== "object") {
			return payload;
		}

		const normalized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			payload as Record<string, unknown>,
		)) {
			const compacted = this.compactProviderPayload(value);
			if (compacted !== undefined) {
				normalized[key] = compacted;
			}
		}

		if (
			this.isEmptyImageContentPart(normalized) ||
			this.isEmptyTextContentPart(normalized)
		) {
			return undefined;
		}

		if (
			typeof normalized.role === "string" &&
			Array.isArray(normalized.content)
		) {
			normalized.content = this.collapseOpenAiMessageContent(
				normalized.content,
			);
		}

		return normalized;
	}

	private normalizeProviderRequestPayload(payload: unknown): unknown {
		if (typeof payload !== "string") {
			return this.compactProviderPayload(payload);
		}

		const trimmed = payload.trim();
		if (!trimmed) {
			return payload;
		}

		if (looksLikeJsonPayload(trimmed)) {
			const tryParseCandidate = (
				candidate: string,
			): { ok: true; value: unknown } | { ok: false } => {
				try {
					return {
						ok: true,
						value: this.compactProviderPayload(JSON.parse(candidate)),
					};
				} catch {
					return { ok: false };
				}
			};

			const parseCandidates = new Set<string>();
			parseCandidates.add(trimmed);

			const unescaped = trimmed.replace(/\\"/g, '"');
			if (unescaped !== trimmed) {
				parseCandidates.add(unescaped);
			}

			for (const candidate of parseCandidates) {
				if (!looksLikeJsonPayload(candidate)) {
					continue;
				}

				const parsedCandidate = tryParseCandidate(candidate);
				if (parsedCandidate.ok) {
					return parsedCandidate.value;
				}

				const escapedControlChars =
					this.escapeControlCharactersInsideJsonStrings(candidate);
				if (
					escapedControlChars !== candidate &&
					looksLikeJsonPayload(escapedControlChars)
				) {
					const escapedCandidate = tryParseCandidate(escapedControlChars);
					if (escapedCandidate.ok) {
						return escapedCandidate.value;
					}
				}
			}
		}

		return payload;
	}

	private escapeControlCharactersInsideJsonStrings(input: string): string {
		let output = "";
		let inString = false;
		let escaped = false;

		for (let i = 0; i < input.length; i++) {
			const char = input[i];

			if (escaped) {
				output += char;
				escaped = false;
				continue;
			}

			if (char === "\\") {
				output += char;
				escaped = true;
				continue;
			}

			if (char === '"') {
				inString = !inString;
				output += char;
				continue;
			}

			if (inString) {
				switch (char) {
					case "\n":
						output += "\\n";
						continue;
					case "\r":
						output += "\\r";
						continue;
					case "\t":
						output += "\\t";
						continue;
					case "\f":
						output += "\\f";
						continue;
					case "\b":
						output += "\\b";
						continue;
					default: {
						const code = char.charCodeAt(0);
						if (code >= 0 && code <= 0x1f) {
							output += `\\u${code.toString(16).padStart(4, "0")}`;
							continue;
						}
					}
				}
			}

			output += char;
		}

		return output;
	}

	private buildFetchRequestBody(payload: unknown): any {
		const normalizedPayload = this.normalizeProviderRequestPayload(payload);
		if (normalizedPayload === undefined || normalizedPayload === null) {
			return undefined;
		}

		if (typeof normalizedPayload === "string") {
			return normalizedPayload;
		}

		return JSON.stringify(normalizedPayload);
	}

	private getCurlDataTemplate(requestConfig: any): unknown {
		const candidate = requestConfig?.data ?? requestConfig?.form ?? {};

		if (
			candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate)
		) {
			const entries = Object.entries(candidate as Record<string, unknown>);
			if (entries.length === 1) {
				const [template, value] = entries[0];
				if (
					(value === undefined || value === null) &&
					typeof template === "string" &&
					template.trim()
				) {
					return template;
				}
			}
		}

		return candidate;
	}

	private buildOpenAiCompatibleVariables(
		userMessage: string,
		systemPrompt: string | undefined,
		context: string,
		base64Images: string[],
	): { OPENAI_USER_CONTENT: any[]; OPENAI_MESSAGES: any[] } {
		const userText = context
			? userMessage
				? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${userMessage}`
				: `CONTEXT:\n${context}`
			: userMessage;

		const openAiUserContent: any[] = [];
		if (userText.trim()) {
			openAiUserContent.push({ type: "text", text: userText });
		}
		for (const base64Image of base64Images) {
			openAiUserContent.push({
				type: "image_url",
				image_url: { url: `data:image/png;base64,${base64Image}` },
			});
		}

		const openAiMessages: any[] = [];
		if ((systemPrompt || "").trim()) {
			openAiMessages.push({ role: "system", content: systemPrompt });
		}
		if (openAiUserContent.length > 0) {
			openAiMessages.push({ role: "user", content: openAiUserContent });
		}

		return {
			OPENAI_USER_CONTENT: openAiUserContent,
			OPENAI_MESSAGES: openAiMessages,
		};
	}

	// The handler for cURL requests
	public async chatWithCurl(
		userMessage: string,
		systemPrompt?: string,
		context: string = "",
		imagePaths?: string[],
	): Promise<string> {
		if (!this.activeCurlProvider) throw new Error("No cURL provider active");

		const { curlCommand, responsePath } = this.activeCurlProvider;

		// 1. Parse cURL to config object
		const curlConfig = curl2Json(curlCommand);

		// 2. Prepare Variables
		const contextualUserMessage = context
			? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${userMessage}`
			: userMessage;
		const fullPrompt = systemPrompt
			? `${systemPrompt}\n\n${contextualUserMessage}`
			: contextualUserMessage;
		const base64Images = await this.readImagesAsBase64(imagePaths);
		const primaryBase64Image = base64Images[0] || "";
		const { OPENAI_USER_CONTENT, OPENAI_MESSAGES } =
			this.buildOpenAiCompatibleVariables(
				userMessage,
				systemPrompt,
				context,
				base64Images,
			);

		const variables = {
			TEXT: fullPrompt,
			PROMPT: fullPrompt,
			SYSTEM_PROMPT: systemPrompt || "",
			USER_MESSAGE: userMessage,
			CONTEXT: context,
			IMAGE_BASE64: primaryBase64Image,
			IMAGE_BASE64S: base64Images,
			IMAGE_COUNT: String(base64Images.length),
			OPENAI_USER_CONTENT,
			OPENAI_MESSAGES,
			API_KEY:
				this.openaiApiKey ||
				this.groqApiKey ||
				this.cerebrasApiKey ||
				this.claudeApiKey ||
				this.apiKey ||
				"",
			OPENAI_API_KEY: this.openaiApiKey || "",
			GROQ_API_KEY: this.groqApiKey || "",
			CEREBRAS_API_KEY: this.cerebrasApiKey || "",
			CLAUDE_API_KEY: this.claudeApiKey || "",
			GEMINI_API_KEY: this.apiKey || "",
		};

		// 3. Inject Variables into URL, Headers, and Body
		const url = deepVariableReplacer(curlConfig.url, variables);
		const headers = deepVariableReplacer(curlConfig.header || {}, variables);
		const dataTemplate = this.getCurlDataTemplate(curlConfig);
		const replacedData = deepVariableReplacer(dataTemplate, variables);
		const data = this.normalizeProviderRequestPayload(replacedData);

		// 4. Execute
		try {
			const axiosImpl = LLMHelper.__testAxios ?? axios;
			const response = await axiosImpl({
				method: curlConfig.method || "POST",
				url: url,
				headers: headers,
				data: data,
				timeout: CURL_PROVIDER_TIMEOUT_MS,
			});

			return this.extractCurlResponseText(response.data, responsePath);
		} catch (error) {
			console.error("[LLMHelper] cURL Execution Error:", sanitizeError(error));
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	/**
	 * Non-streaming Claude generation with proper system/user separation
	 */
	public async generateWithClaude(
		userMessage: string,
		systemPrompt?: string,
		imagePaths?: string[],
		modelOverride?: string,
	): Promise<string> {
		if (!this.claudeClient) throw new Error("Claude client not initialized");

		const targetModel = modelOverride || CLAUDE_MODEL;
		await this.rateLimiters.claude.acquire();
		const systemPromptHash = this.hashValue(systemPrompt || "");
		const payloadHash = this.hashValue({
			model: targetModel,
			userMessage,
			systemPrompt: systemPrompt || "",
			imagePaths: imagePaths || [],
		});

		return this.withResponseCache(
			"claude",
			targetModel,
			systemPromptHash,
			payloadHash,
			async () => {
				const requestPayload = await this.withFinalPayloadCache(
					"claude",
					targetModel,
					systemPromptHash,
					payloadHash,
					async () => {
						const content: any[] = [];
						if (imagePaths?.length) {
							for (const p of imagePaths) {
								if (fs.existsSync(p)) {
									const imageData = await fs.promises.readFile(p);
									content.push({
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: imageData.toString("base64"),
										},
									});
								}
							}
						}
						content.push({ type: "text", text: userMessage });

						return {
							model: targetModel,
							max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
							...(systemPrompt ? { system: systemPrompt } : {}),
							messages: [{ role: "user", content }],
						};
					},
				);

				const response = await withTimeout(
					this.claudeClient?.messages.create(requestPayload as any),
					LLM_API_TIMEOUT_MS,
				);
				const textBlock = response.content.find(
					(block: any) => block.type === "text",
				) as any;
				return textBlock?.text || "";
			},
		);
	}

	/**
	 * Executes a custom cURL provider defined by the user
	 */
	public async executeCustomProvider(
		curlCommand: string,
		combinedMessage: string,
		systemPrompt: string,
		rawUserMessage: string,
		context: string,
		imagePaths?: string[],
		responsePath?: string,
		abortSignal?: AbortSignal,
		timeoutMs: number = LLM_API_TIMEOUT_MS,
	): Promise<string> {
		// 1. Parse cURL to JSON object
		const requestConfig = curl2Json(curlCommand);

		// 2. Prepare Image (if any)
		const base64Images = await this.readImagesAsBase64(imagePaths);
		const primaryBase64Image = base64Images[0] || "";
		const { OPENAI_USER_CONTENT, OPENAI_MESSAGES } =
			this.buildOpenAiCompatibleVariables(
				rawUserMessage,
				systemPrompt,
				context,
				base64Images,
			);

		// 3. Prepare Variables
		const variables = {
			TEXT: combinedMessage, // Deprecated but kept for compat: System + Context + User
			PROMPT: combinedMessage, // Alias for TEXT
			SYSTEM_PROMPT: systemPrompt, // Raw System Prompt
			USER_MESSAGE: rawUserMessage, // Raw User Message
			CONTEXT: context, // Raw Context
			IMAGE_BASE64: primaryBase64Image, // Backward-compatible first image
			IMAGE_BASE64S: base64Images,
			IMAGE_COUNT: String(base64Images.length),
			OPENAI_USER_CONTENT,
			OPENAI_MESSAGES,
			API_KEY:
				this.openaiApiKey ||
				this.groqApiKey ||
				this.cerebrasApiKey ||
				this.claudeApiKey ||
				this.apiKey ||
				"",
			OPENAI_API_KEY: this.openaiApiKey || "",
			GROQ_API_KEY: this.groqApiKey || "",
			CEREBRAS_API_KEY: this.cerebrasApiKey || "",
			CLAUDE_API_KEY: this.claudeApiKey || "",
			GEMINI_API_KEY: this.apiKey || "",
		};

		// 4. Inject Variables into URL, Headers, and Body
		const url = deepVariableReplacer(requestConfig.url, variables);
		const headers = deepVariableReplacer(requestConfig.header || {}, variables);
		const bodyTemplate = this.getCurlDataTemplate(requestConfig);
		const body = deepVariableReplacer(bodyTemplate, variables);
		const requestBody = this.buildFetchRequestBody(body);

		// 5. Execute Fetch
		try {
			const requestControl = createRequestAbortController(
				timeoutMs,
				abortSignal,
			);
			try {
				const response = await fetch(url, {
					method: requestConfig.method || "POST",
					headers: headers,
					body: requestBody,
					signal: requestControl.signal,
				});

				const rawBody = await readFetchBodyWithLimit(response);
				const trimmedBody = rawBody.trim();
				if (!response.ok) {
					throw new Error(
						`Custom Provider HTTP ${response.status}: ${summarizeResponseBody(trimmedBody)}`,
					);
				}

				if (!trimmedBody) {
					throw new Error("Custom Provider returned an empty response body");
				}

				if (!looksLikeJsonPayload(trimmedBody)) {
					console.log(
						`[LLMHelper] Custom Provider returned plain text response (${trimmedBody.length} chars)`,
					);
					return trimmedBody;
				}

				const data = JSON.parse(trimmedBody);
				console.log(
					`[LLMHelper] Custom Provider raw response:`,
					trimmedBody.substring(0, 1000),
				);

				const extracted = this.extractCurlResponseText(data, responsePath);
				console.log(
					`[LLMHelper] Custom Provider extracted text length: ${extracted.length}`,
				);
				return extracted;
			} finally {
				requestControl.cleanup();
			}
		} catch (error) {
			console.error("Custom Provider Error:", sanitizeError(error));
			throw error;
		}
	}

	/**
	 * Stream a custom cURL provider using SSE (Server-Sent Events).
	 * This is an additive enhancement — callers should fall back to
	 * `executeCustomProvider` on empty/non-SSE responses so existing
	 * non-streaming providers keep working.
	 */
	public async *streamCustomProvider(
		curlCommand: string,
		combinedMessage: string,
		systemPrompt: string,
		rawUserMessage: string,
		context: string,
		imagePaths?: string[],
		responsePath?: string,
		abortSignal?: AbortSignal,
		timeoutMs: number = CURL_PROVIDER_TIMEOUT_MS,
	): AsyncGenerator<string, void, unknown> {
		const requestConfig = curl2Json(curlCommand);
		const base64Images = await this.readImagesAsBase64(imagePaths);
		const primaryBase64Image = base64Images[0] || "";
		const { OPENAI_USER_CONTENT, OPENAI_MESSAGES } =
			this.buildOpenAiCompatibleVariables(
				rawUserMessage,
				systemPrompt,
				context,
				base64Images,
			);
		const variables = {
			TEXT: combinedMessage,
			PROMPT: combinedMessage,
			SYSTEM_PROMPT: systemPrompt,
			USER_MESSAGE: rawUserMessage,
			CONTEXT: context,
			IMAGE_BASE64: primaryBase64Image,
			IMAGE_BASE64S: base64Images,
			IMAGE_COUNT: String(base64Images.length),
			OPENAI_USER_CONTENT,
			OPENAI_MESSAGES,
			API_KEY:
				this.openaiApiKey ||
				this.groqApiKey ||
				this.cerebrasApiKey ||
				this.claudeApiKey ||
				this.apiKey ||
				"",
			OPENAI_API_KEY: this.openaiApiKey || "",
			GROQ_API_KEY: this.groqApiKey || "",
			CEREBRAS_API_KEY: this.cerebrasApiKey || "",
			CLAUDE_API_KEY: this.claudeApiKey || "",
			GEMINI_API_KEY: this.apiKey || "",
		};
		const url = deepVariableReplacer(requestConfig.url, variables);
		const headers = deepVariableReplacer(requestConfig.header || {}, variables);
		const bodyTemplate = this.getCurlDataTemplate(requestConfig);
		let body = deepVariableReplacer(bodyTemplate, variables);
		body = this.normalizeProviderRequestPayload(body);
		if (body && typeof body === "object") {
			body = { ...body, stream: true };
		}
		const requestBody = this.buildFetchRequestBody(body);
		const requestControl = createRequestAbortController(timeoutMs, abortSignal);
		let response: Response;
		try {
			response = await fetch(url, {
				method: requestConfig.method || "POST",
				headers: { ...headers, Accept: "text/event-stream" },
				body: requestBody,
				signal: requestControl.signal,
			});
		} catch (error) {
			requestControl.cleanup();
			throw error;
		}
		if (!response.ok) {
			requestControl.cleanup();
			const errorText = await readFetchBodyWithLimit(response);
			throw new Error(
				`Custom Provider HTTP ${response.status}: ${summarizeResponseBody(errorText.trim())}`,
			);
		}
		if (!response.body) {
			requestControl.cleanup();
			return;
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				if (abortSignal?.aborted) return;
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) continue;
					const dataStr = trimmed.slice(5).trim();
					if (dataStr === "[DONE]") return;
					if (!dataStr) continue;
					try {
						const data = JSON.parse(dataStr);
						const text = this.extractCurlResponseText(data, responsePath);
						if (text) yield text;
					} catch {
						// malformed SSE line — ignore
					}
				}
			}
		} finally {
			requestControl.cleanup();
			reader.releaseLock();
		}
	}

	/**
	 * Try to extract text content from common LLM API response formats.
	 * Supports: Ollama, OpenAI, Anthropic, and generic formats.
	 */
	private extractFromCommonFormats(
		data: any,
		allowRawJsonFallback: boolean = true,
	): string {
		if (!data || typeof data === "string") return data || "";

		// Ollama format: { response: "..." }
		if (typeof data.response === "string") return data.response;

		// OpenAI format: { choices: [{ message: { content: "..." } }] }
		if (data.choices?.[0]?.message?.content)
			return data.choices[0].message.content;

		// OpenAI delta/streaming format: { choices: [{ delta: { content: "..." } }] }
		if (data.choices?.[0]?.delta?.content) return data.choices[0].delta.content;

		// Anthropic format: { content: [{ text: "..." }] }
		if (Array.isArray(data.content) && data.content[0]?.text)
			return data.content[0].text;

		// Generic text field
		if (typeof data.text === "string") return data.text;

		// Generic output field
		if (typeof data.output === "string") return data.output;

		// Generic result field
		if (typeof data.result === "string") return data.result;

		// Fallback: stringify the whole response
		if (allowRawJsonFallback) {
			console.warn(
				"[LLMHelper] Could not extract text from custom provider response, returning raw JSON",
			);
			return JSON.stringify(data);
		}

		return "";
	}

	private extractOpenAIFormattedText(
		data: any,
		allowRawJsonFallback: boolean = true,
	): string {
		if (!data || typeof data === "string") return data || "";

		if (typeof data.choices?.[0]?.message?.content === "string") {
			return data.choices[0].message.content;
		}

		if (Array.isArray(data.choices?.[0]?.message?.content)) {
			const text = data.choices[0].message.content
				.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
				.join("")
				.trim();
			if (text) return text;
		}

		if (typeof data.choices?.[0]?.delta?.content === "string") {
			return data.choices[0].delta.content;
		}

		if (Array.isArray(data.output_text)) {
			const text = data.output_text.join("").trim();
			if (text) return text;
		}

		if (typeof data.output_text === "string") {
			return data.output_text;
		}

		if (Array.isArray(data.output)) {
			const text = data.output
				.flatMap((item: any) =>
					Array.isArray(item?.content) ? item.content : [],
				)
				.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
				.join("")
				.trim();
			if (text) return text;
		}

		return this.extractFromCommonFormats(data, allowRawJsonFallback);
	}

	private extractCurlResponseText(data: any, responsePath?: string): string {
		if (!responsePath) {
			const extracted = this.extractOpenAIFormattedText(data, true);
			return extracted && extracted.trim().length > 0
				? extracted
				: JSON.stringify(data);
		}

		const answer = getByPath(data, responsePath);

		if (typeof answer === "string" && answer.trim().length > 0) return answer;
		if (answer !== null && answer !== undefined) {
			if (typeof answer === "number" || typeof answer === "boolean")
				return String(answer);
			if (Array.isArray(answer) && answer.length > 0)
				return JSON.stringify(answer);
			if (typeof answer === "object" && Object.keys(answer).length > 0)
				return JSON.stringify(answer);
		}

		const guessed = this.extractOpenAIFormattedText(data, false);
		if (guessed && guessed.trim().length > 0) return guessed;

		throw new Error(
			`cURL response extraction failed for path: ${responsePath}`,
		);
	}

	/**
	 * Map UNIVERSAL (local model) prompts to richer CUSTOM prompts.
	 * Custom providers can be any cloud model, so they get detailed prompts.
	 */
	private mapToCustomPrompt(prompt: string): string {
		// Map from concise UNIVERSAL to rich CUSTOM equivalents
		if (prompt === UNIVERSAL_SYSTEM_PROMPT || prompt === HARD_SYSTEM_PROMPT)
			return CUSTOM_SYSTEM_PROMPT;
		if (prompt === UNIVERSAL_ANSWER_PROMPT) return CUSTOM_ANSWER_PROMPT;
		if (prompt === UNIVERSAL_WHAT_TO_ANSWER_PROMPT)
			return CUSTOM_WHAT_TO_ANSWER_PROMPT;
		if (prompt === UNIVERSAL_RECAP_PROMPT) return CUSTOM_RECAP_PROMPT;
		if (prompt === UNIVERSAL_FOLLOWUP_PROMPT) return CUSTOM_FOLLOWUP_PROMPT;
		if (prompt === UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT)
			return CUSTOM_FOLLOW_UP_QUESTIONS_PROMPT;
		if (prompt === UNIVERSAL_ASSIST_PROMPT) return CUSTOM_ASSIST_PROMPT;
		// If it's already a different override (e.g. user-supplied), pass through
		return prompt;
	}

	public async tryGenerateResponse(
		fullMessage: string,
		imagePaths?: string[],
		modelIdOverride?: string,
	): Promise<string> {
		let rawResponse: string;

		if (imagePaths?.length) {
			const contents: any[] = [{ text: fullMessage }];
			for (const p of imagePaths) {
				if (fs.existsSync(p)) {
					const imageData = await fs.promises.readFile(p);
					contents.push({
						inlineData: {
							mimeType: "image/png",
							data: imageData.toString("base64"),
						},
					});
				}
			}

			// Use current model for multimodal (allows Pro fallback)
			if (this.client) {
				rawResponse = await this.generateContent(contents, modelIdOverride);
			} else {
				throw new Error("No LLM provider configured");
			}
		} else {
			// Text-only chat
			if (this.useOllama) {
				rawResponse = await this.callOllama(fullMessage);
			} else if (this.client) {
				rawResponse = await this.generateContent(
					[{ text: fullMessage }],
					modelIdOverride,
				);
			} else {
				throw new Error("No LLM provider configured");
			}
		}

		return rawResponse || "";
	}

	/**
	 * Non-streaming multimodal response from Groq using Llama 4 Scout
	 */
	public async generateWithGroqMultimodal(
		userMessage: string,
		imagePaths: string[],
		systemPrompt?: string,
		modelOverride?: string,
	): Promise<string> {
		if (!this.groqClient) throw new Error("Groq client not initialized");

		const messages: any[] = [];
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}

		const contentParts: any[] = [{ type: "text", text: userMessage }];
		for (const p of imagePaths) {
			if (fs.existsSync(p)) {
				const imageData = await fs.promises.readFile(p);
				contentParts.push({
					type: "image_url",
					image_url: {
						url: `data:image/jpeg;base64,${imageData.toString("base64")}`,
					},
				});
			}
		}
		messages.push({ role: "user", content: contentParts });

		const response = await withTimeout(
			this.groqClient.chat.completions.create({
				model: modelOverride,
				messages,
				temperature: 1,
				max_completion_tokens: 28672,
				top_p: 1,
				stream: false,
				stop: null,
			}),
			LLM_API_TIMEOUT_MS,
		);

		return response.choices[0]?.message?.content || "";
	}

	/**
	 * Universal non-streaming fallback helper for internal operations (screenshot analysis, problem extraction, etc.)
	 *
	 * THREE-TIER RETRY ROTATION (self-improving):
	 *   Tier 1: Pinned stable models (promoted only when 2+ minor versions behind)
	 *   Tier 2: Latest auto-discovered models (updated every ~14 days) — 1st retry
	 *   Tier 3: Same as Tier 2 — 2nd retry (with backoff between tiers)
	 *
	 * Provider order per tier: OpenAI -> Gemini Flash -> Claude -> Gemini Pro -> Groq Scout
	 * After all cloud tiers: Custom Provider -> cURL Provider -> Ollama
	 */
	private async generateWithVisionFallback(
		systemPrompt: string,
		userPrompt: string,
		imagePaths: string[] = [],
		signal?: AbortSignal,
	): Promise<string> {
		type ProviderAttempt = { name: string; execute: () => Promise<string> };
		const isMultimodal = imagePaths.length > 0;
		throwIfAborted(signal);
		let screenshotTextFallbackPromise: Promise<string> | null = null;
		const getScreenshotTextFallback = (): Promise<string> => {
			screenshotTextFallbackPromise ??= this.extractImageTextWithTesseract(
				imagePaths,
				signal,
			);
			return screenshotTextFallbackPromise;
		};
		const getTextOnlyScreenshotPrompt = async (): Promise<string> => {
			const fallbackText = await getScreenshotTextFallback();
			return this.appendScreenshotTextFallback(userPrompt, fallbackText);
		};
		const runVisionAttemptWithTextFallback = async (
			label: string,
			imageRequest: () => Promise<string>,
			textRequest: (fallbackPrompt: string) => Promise<string>,
		): Promise<string> => {
			try {
				return await imageRequest();
			} catch (error) {
				if (!this.shouldRetryScreenshotWithOcr(error, imagePaths)) {
					throw error;
				}

				console.warn(
					`[LLMHelper] ${label} rejected image input. Falling back to local OCR text.`,
				);
				throwIfAborted(signal);
				const fallbackPrompt = await getTextOnlyScreenshotPrompt();
				throwIfAborted(signal);
				return textRequest(fallbackPrompt);
			}
		};

		// Helper: build a provider attempt for a given family + model ID
		const buildProviderForFamily = (
			family: ModelFamily,
			modelId: string,
		): ProviderAttempt | null => {
			switch (family) {
				case ModelFamily.OPENAI:
					if (!this.openaiClient) return null;
					return {
						name: `OpenAI (${modelId})`,
						execute: () =>
							isMultimodal
								? runVisionAttemptWithTextFallback(
										`OpenAI (${modelId})`,
										() =>
											this.generateWithOpenai(
												userPrompt,
												systemPrompt,
												imagePaths,
											),
										(fallbackPrompt) =>
											this.generateWithOpenai(fallbackPrompt, systemPrompt),
									)
								: this.generateWithOpenai(userPrompt, systemPrompt),
					};

				case ModelFamily.GEMINI_FLASH:
					if (!this.client) return null;
					if (isMultimodal) {
						return {
							name: `Gemini Flash (${modelId})`,
							execute: () =>
								runVisionAttemptWithTextFallback(
									`Gemini Flash (${modelId})`,
									async () => {
										const contents: any[] = [
											{ text: `${systemPrompt}\n\n${userPrompt}` },
										];
										for (const p of imagePaths) {
											throwIfAborted(signal);
											if (fs.existsSync(p)) {
												const { mimeType, data } = await this.processImage(p);
												contents.push({ inlineData: { mimeType, data } });
											}
										}
										return await this.generateContent(contents, modelId);
									},
									(fallbackPrompt) =>
										this.generateContent(
											[{ text: `${systemPrompt}\n\n${fallbackPrompt}` }],
											modelId,
										),
								),
						};
					}
					return {
						name: `Gemini Flash (${modelId})`,
						execute: () =>
							this.generateContent(
								[{ text: `${systemPrompt}\n\n${userPrompt}` }],
								modelId,
							),
					};

				case ModelFamily.CLAUDE:
					if (!this.claudeClient) return null;
					return {
						name: `Claude (${modelId})`,
						execute: () =>
							isMultimodal
								? runVisionAttemptWithTextFallback(
										`Claude (${modelId})`,
										() =>
											this.generateWithClaude(
												userPrompt,
												systemPrompt,
												imagePaths,
											),
										(fallbackPrompt) =>
											this.generateWithClaude(fallbackPrompt, systemPrompt),
									)
								: this.generateWithClaude(userPrompt, systemPrompt),
					};

				case ModelFamily.GEMINI_PRO:
					if (!this.client) return null;
					if (isMultimodal) {
						return {
							name: `Gemini Pro (${modelId})`,
							execute: () =>
								runVisionAttemptWithTextFallback(
									`Gemini Pro (${modelId})`,
									async () => {
										const contents: any[] = [
											{ text: `${systemPrompt}\n\n${userPrompt}` },
										];
										for (const p of imagePaths) {
											throwIfAborted(signal);
											if (fs.existsSync(p)) {
												const { mimeType, data } = await this.processImage(p);
												contents.push({ inlineData: { mimeType, data } });
											}
										}
										return await this.generateContent(contents, modelId);
									},
									(fallbackPrompt) =>
										this.generateContent(
											[{ text: `${systemPrompt}\n\n${fallbackPrompt}` }],
											modelId,
										),
								),
						};
					}
					return {
						name: `Gemini Pro (${modelId})`,
						execute: () =>
							this.generateContent(
								[{ text: `${systemPrompt}\n\n${userPrompt}` }],
								modelId,
							),
					};

				case ModelFamily.GROQ_LLAMA:
					if (!this.groqClient) return null;
					if (isMultimodal) {
						return {
							name: `Groq (${modelId})`,
							execute: () =>
								runVisionAttemptWithTextFallback(
									`Groq (${modelId})`,
									() =>
										this.generateWithGroqMultimodal(
											userPrompt,
											imagePaths,
											systemPrompt,
										),
									(fallbackPrompt) =>
										this.generateWithGroq(
											`${systemPrompt}\n\n${fallbackPrompt}`,
										),
								),
						};
					}
					return {
						name: `Groq (${modelId})`,
						execute: () =>
							this.generateWithGroq(`${systemPrompt}\n\n${userPrompt}`),
					};

				default:
					return null;
			}
		};

		// ──────────────────────────────────────────────────────────────────
		// Build 3-tier retry rotation from ModelVersionManager
		// ──────────────────────────────────────────────────────────────────
		const allTiers = this.modelVersionManager.getAllVisionTiers();

		const buildTierProviders = (
			tierKey: "tier1" | "tier2" | "tier3",
		): ProviderAttempt[] => {
			const result: ProviderAttempt[] = [];
			for (const entry of allTiers) {
				const modelId = entry[tierKey];
				const attempt = buildProviderForFamily(entry.family, modelId);
				if (attempt) result.push(attempt);
			}
			return result;
		};

		const tier1Providers = buildTierProviders("tier1");
		const tier2Providers = buildTierProviders("tier2");
		const tier3Providers = buildTierProviders("tier3"); // Same as tier2 — pure retry

		// ──────────────────────────────────────────────────────────────────
		// Local fallback providers (appended after all cloud tiers)
		// ──────────────────────────────────────────────────────────────────
		const localProviders: ProviderAttempt[] = [];

		if (this.customProvider) {
			const customProviderAcceptsImages =
				!isMultimodal ||
				this.curlLikelyAcceptsImages(this.customProvider.curlCommand || "");
			localProviders.push({
				name: `Custom Provider (${this.customProvider.name})`,
				execute: async () => {
					const effectiveUserPrompt = customProviderAcceptsImages
						? userPrompt
						: await getTextOnlyScreenshotPrompt();
					const effectiveImagePaths = customProviderAcceptsImages
						? imagePaths
						: [];
					return this.executeCustomProvider(
						this.customProvider?.curlCommand,
						`${systemPrompt}\n\n${effectiveUserPrompt}`,
						systemPrompt,
						effectiveUserPrompt,
						"",
						effectiveImagePaths,
					);
				},
			});
		}

		if (this.activeCurlProvider && !this.customProvider) {
			const curlProviderAcceptsImages =
				!isMultimodal ||
				this.curlLikelyAcceptsImages(this.activeCurlProvider.curlCommand || "");
			if (isMultimodal)
				console.log(
					`[LLMHelper] cURL provider "${this.activeCurlProvider.name}": image support = ${curlProviderAcceptsImages}`,
				);
			localProviders.push({
				name: `cURL Provider (${this.activeCurlProvider.name})`,
				execute: async () => {
					const effectiveUserPrompt = curlProviderAcceptsImages
						? userPrompt
						: await getTextOnlyScreenshotPrompt();
					const effectiveImagePaths = curlProviderAcceptsImages
						? imagePaths
						: [];
					return this.chatWithCurl(
						effectiveUserPrompt,
						systemPrompt,
						"",
						effectiveImagePaths,
					);
				},
			});
		}

		if (this.useOllama) {
			localProviders.push({
				name: `Ollama (${this.ollamaModel})`,
				execute: async () => {
					const effectiveUserPrompt = isMultimodal
						? await getTextOnlyScreenshotPrompt()
						: userPrompt;
					return this.callOllama(`${systemPrompt}\n\n${effectiveUserPrompt}`);
				},
			});
		}

		// ──────────────────────────────────────────────────────────────────
		// Execute 3-tier rotation with exponential backoff between tiers
		// ──────────────────────────────────────────────────────────────────
		const tiers = [
			{ label: "Tier 1 (Stable)", providers: tier1Providers },
			{ label: "Tier 2 (Latest)", providers: tier2Providers },
			{ label: "Tier 3 (Retry)", providers: tier3Providers },
		];

		for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
			const tier = tiers[tierIndex];

			if (tier.providers.length === 0) continue;

			// Exponential backoff between tiers (skip for first tier)
			if (tierIndex > 0) {
				const backoffMs = 1000 * 2 ** (tierIndex - 1);
				console.log(
					`[LLMHelper] 🔄 Escalating to ${tier.label} after ${backoffMs}ms backoff...`,
				);
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
			}

			for (const provider of tier.providers) {
				try {
					const emoji = tierIndex === 0 ? "🚀" : tierIndex === 1 ? "🔁" : "🆘";
					console.log(
						`[LLMHelper] ${emoji} [${tier.label}] Attempting ${provider.name}...`,
					);
					const result = await provider.execute();
					if (result && result.trim().length > 0) {
						console.log(
							`[LLMHelper] ✅ [${tier.label}] ${provider.name} succeeded.`,
						);
						return result;
					}
					console.warn(
						`[LLMHelper] ⚠️ [${tier.label}] ${provider.name} returned empty response`,
					);
				} catch (err: any) {
					console.warn(
						`[LLMHelper] ⚠️ [${tier.label}] ${provider.name} failed: ${err.message}`,
					);

					// Event-driven discovery: trigger on 404 / model-not-found errors
					const errMsg = (err.message || "").toLowerCase();
					if (
						errMsg.includes("404") ||
						errMsg.includes("not found") ||
						errMsg.includes("deprecated")
					) {
						this.modelVersionManager
							.onModelError(provider.name)
							.catch(() => {});
					}
				}
			}
		}

		// ──────────────────────────────────────────────────────────────────
		// Local fallback — absolute last resort after all cloud tiers exhausted
		// ──────────────────────────────────────────────────────────────────
		for (const provider of localProviders) {
			try {
				console.log(
					`[LLMHelper] 🏠 [Local Fallback] Attempting ${provider.name}...`,
				);
				const result = await provider.execute();
				if (result && result.trim().length > 0) {
					console.log(
						`[LLMHelper] ✅ [Local Fallback] ${provider.name} succeeded.`,
					);
					return result;
				}
			} catch (err: any) {
				console.warn(
					`[LLMHelper] ⚠️ [Local Fallback] ${provider.name} failed: ${err.message}`,
				);
			}
		}

		throw new Error(
			"All AI providers failed across all 3 tiers and local fallbacks.",
		);
	}

	/**
	 * Stream chat response with Groq-first fallback chain for text-only,
	 * and Gemini-only for multimodal (images)
	 *
	 * TEXT-ONLY FALLBACK CHAIN:
	 * 1. Groq (llama-3.3-70b-versatile) - Primary
	 * 2. Gemini Flash - 1st fallback
	 * 3. Gemini Flash + Pro parallel - 2nd fallback
	 * 4. Gemini Flash retries (max 3) - Last resort
	 *
	 * MULTIMODAL: Gemini-only (existing logic)
	 */
	public async *streamChatWithGemini(
		message: string,
		imagePaths?: string[],
		context?: string,
		skipSystemPrompt: boolean = false,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamChatWithGemini(
			this,
			message,
			imagePaths,
			context,
			skipSystemPrompt,
			abortSignal,
		);
	}

	/**
	 * Universal Stream Chat - Routes to correct provider based on currentModelId
	 */
	public async *streamChat(
		message: string,
		imagePaths?: string[],
		context?: string,
		systemPromptOverride?: string,
		options?: StreamChatOptions,
	): AsyncGenerator<string, void, unknown> {
		if (options?.abortSignal?.aborted) {
			return;
		}

		const originalImagePaths = imagePaths ? [...imagePaths] : undefined;
		const originalContext = context;

		const hasScreenshotInput = !!imagePaths?.length;
		let effectiveMessage = hasScreenshotInput
			? message
			: this.applyDefaultBrevityHint(message);
		const structuredScreenshotRequest =
			this.isStructuredOutputRequest(effectiveMessage);
		const preserveSystemPromptForStructuredOutput =
			structuredScreenshotRequest || options?.qualityTier === "verify";
		let screenshotRouting: ScreenshotEventRoutingResult | null = null;
		let forcedScreenshotTextFallback = false;
		const forceTextFallback =
			this.shouldForceScreenshotTextFallback(imagePaths);
		const providerCacheKey = this.getStreamProviderCacheKey();
		const prepareStreamSystemPrompt = (prompt: string): string =>
			prompt === SCREENSHOT_EVENT_PROMPT
				? prompt
				: this.injectLanguageInstruction(prompt);
		const initialBaseSystemPrompt = systemPromptOverride || HARD_SYSTEM_PROMPT;
		let excludedVisionTier1Family: ModelFamily | undefined;
		let excludedTextTier1Family: TextModelFamily | undefined;

		// NAT-037: start TTFT blockers concurrently — screenshot/knowledge prep,
		// system prompt warm, and provider warmup.
		const screenshotPrepP =
			hasScreenshotInput && imagePaths
				? this.prepareScreenshotEventRouting({
						message: effectiveMessage,
						context,
						imagePaths,
						signal: options?.abortSignal,
						forceTextFallback,
					})
				: Promise.resolve(null);
		const knowledgePrepP =
			!hasScreenshotInput && !options?.skipKnowledgeInterception
				? this.prepareKnowledgeInterceptionForStream(message)
				: Promise.resolve(null);
		const promptCacheWarmP: Promise<string | null> = this.withSystemPromptCache(
			providerCacheKey,
			this.getCurrentModel(),
			initialBaseSystemPrompt,
			() => prepareStreamSystemPrompt(initialBaseSystemPrompt),
		).catch((): string | null => null);
		const providerConnectP = this.connectToProvider(options?.abortSignal).catch(
			(error) => {
				console.warn(
					"[LLMHelper] Provider pre-connect warmup skipped:",
					sanitizeError(error),
				);
			},
		);

		if (hasScreenshotInput) {
			screenshotRouting = await screenshotPrepP;
		}
		if (screenshotRouting) {
			effectiveMessage = screenshotRouting.userMessage;
			context = screenshotRouting.context;
			imagePaths = screenshotRouting.imagePaths;
			forcedScreenshotTextFallback =
				forceTextFallback && (imagePaths?.length || 0) === 0;
			if (!preserveSystemPromptForStructuredOutput) {
				systemPromptOverride = screenshotRouting.systemPrompt;
			}
		}

		// ============================================================
		// KNOWLEDGE MODE INTERCEPT (Streaming)
		// ============================================================
		if (!hasScreenshotInput && !options?.skipKnowledgeInterception) {
			try {
				const knowledgeResult = await knowledgePrepP;
				if (knowledgeResult) {
					// Intro question shortcut — yield generated response directly
					if (knowledgeResult.introResponse) {
						console.log(
							"[LLMHelper] Knowledge mode (stream): returning generated intro response",
						);
						yield knowledgeResult.introResponse;
						return;
					}
					// Inject knowledge system prompt
					if (knowledgeResult.systemPromptInjection) {
						systemPromptOverride = knowledgeResult.systemPromptInjection;
					}
					// Inject knowledge context
					if (knowledgeResult.contextBlock) {
						context = context
							? `${knowledgeResult.contextBlock}\n\n${context}`
							: knowledgeResult.contextBlock;
					}
				}
			} catch (knowledgeError: any) {
				console.warn(
					"[LLMHelper] Knowledge mode (stream) processing failed, falling back:",
					knowledgeError.message,
				);
			}
		}

		// Preparation
		const isMultimodal = !!imagePaths?.length;
		// Determine the system prompt to use
		// logic: if override provided, use it. otherwise use HARD_SYSTEM_PROMPT (which is the universal base)
		const baseSystemPrompt = systemPromptOverride || HARD_SYSTEM_PROMPT;
		const finalSystemPrompt =
			(baseSystemPrompt === initialBaseSystemPrompt
				? await promptCacheWarmP
				: null) ||
			(await this.withSystemPromptCache(
				providerCacheKey,
				this.getCurrentModel(),
				baseSystemPrompt,
				() => prepareStreamSystemPrompt(baseSystemPrompt),
			));

		// Helper to build combined user message
		const buildStreamUserContent = (messageText: string) =>
			context
				? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${messageText}`
				: messageText;
		const userContent = buildStreamUserContent(effectiveMessage);

		const qualityTier: StreamQualityTier = options?.qualityTier ?? "quality";
		const canUseFastResponse =
			!isMultimodal &&
			!this.activeCurlProvider &&
			!this.customProvider &&
			!this.useOllama;
		const fastResponseTarget = canUseFastResponse
			? this.getActiveFastResponseTarget(qualityTier)
			: null;
		await providerConnectP;
		if (fastResponseTarget) {
			console.log(
				`[LLMHelper] ⚡️ Fast Response Mode Active (Streaming). Routing to ${fastResponseTarget.provider} (${fastResponseTarget.model})...`,
			);
			try {
				if (fastResponseTarget.provider === "cerebras") {
					const cerebrasSystem = systemPromptOverride || OPENAI_SYSTEM_PROMPT;
					const finalCerebrasSystem = prepareStreamSystemPrompt(cerebrasSystem);
					yield* this.streamWithCerebras(
						userContent,
						finalCerebrasSystem,
						fastResponseTarget.model,
						options?.abortSignal,
					);
					return;
				}

				const groqSystem = systemPromptOverride || GROQ_SYSTEM_PROMPT;
				const finalGroqSystem = prepareStreamSystemPrompt(groqSystem);
				const groqFullMessage = this.joinPrompt(finalGroqSystem, userContent);
				yield* this.streamWithGroq(
					groqFullMessage,
					fastResponseTarget.model,
					options?.abortSignal,
				);
				return;
			} catch (e: any) {
				if (e?.streamHadOutput) {
					throw e;
				}
				console.warn(
					`[LLMHelper] Fast Response Mode streaming failed on ${fastResponseTarget.provider}, falling back:`,
					e.message,
				);
				// Fall through
			}
		}

		// 1. Ollama Streaming
		if (this.useOllama) {
			yield* this.streamWithOllama(
				effectiveMessage,
				context,
				finalSystemPrompt,
				options?.abortSignal,
			);
			return;
		}

		// 2. Custom Provider Streaming (via cURL)
		if (this.activeCurlProvider) {
			// Map UNIVERSAL prompts to CUSTOM before injecting language instruction,
			// because injectLanguageInstruction modifies the string and breaks mapToCustomPrompt matching
			const mappedBase = this.mapToCustomPrompt(baseSystemPrompt);
			const curlSystemPrompt = prepareStreamSystemPrompt(mappedBase);
			try {
				// Multimodal / screenshot path: keep the existing non-streaming behaviour
				// with screenshot-OCR fallback exactly as before.
				if (isMultimodal && imagePaths?.length) {
					const response = await this.runWithScreenshotOcrFallback(
						`cURL Provider (${this.activeCurlProvider.name})`,
						imagePaths,
						effectiveMessage,
						() =>
							this.executeCustomProvider(
								this.activeCurlProvider?.curlCommand,
								userContent,
								curlSystemPrompt,
								effectiveMessage,
								context || "",
								imagePaths,
								this.activeCurlProvider?.responsePath,
								options?.abortSignal,
								CURL_PROVIDER_TIMEOUT_MS,
							),
						(fallbackMessage) =>
							this.executeCustomProvider(
								this.activeCurlProvider?.curlCommand,
								buildStreamUserContent(fallbackMessage),
								curlSystemPrompt,
								fallbackMessage,
								context || "",
								[],
								this.activeCurlProvider?.responsePath,
								options?.abortSignal,
								CURL_PROVIDER_TIMEOUT_MS,
							),
						options?.abortSignal,
					);
					if (response.trim().length > 0) {
						yield response;
						return;
					}
				} else if (forcedScreenshotTextFallback) {
					// Forced OCR fallback already converted the screenshot into text and
					// removed image paths. Keep this on the buffered cURL path from the
					// pre-SSE workflow so screenshot analysis is handled as one complete
					// request instead of a generic text streaming request.
					const response = await this.executeCustomProvider(
						this.activeCurlProvider.curlCommand,
						userContent,
						curlSystemPrompt,
						effectiveMessage,
						context || "",
						[],
						this.activeCurlProvider.responsePath,
						options?.abortSignal,
						CURL_PROVIDER_TIMEOUT_MS,
					);
					if (response.trim().length > 0) {
						yield response;
						return;
					}
				} else {
					// Text-only path: try SSE streaming first for real-time tokens.
					// If the provider does not support SSE (yields nothing) or throws,
					// fall back transparently to the old buffered executeCustomProvider.
					let streamedAny = false;
					try {
						for await (const chunk of this.streamCustomProvider(
							this.activeCurlProvider.curlCommand,
							userContent,
							curlSystemPrompt,
							effectiveMessage,
							context || "",
							undefined,
							this.activeCurlProvider.responsePath,
							options?.abortSignal,
							CURL_PROVIDER_TIMEOUT_MS,
						)) {
							streamedAny = true;
							yield chunk;
						}
					} catch (streamErr: any) {
						// Streaming failed — fall through to buffered fallback below
						console.warn(
							`[LLMHelper] cURL provider (${this.activeCurlProvider.name}) SSE streaming failed, falling back to buffered:`,
							streamErr.message,
						);
					}
					if (streamedAny) {
						return;
					}
					// Non-SSE provider or empty stream: fall back to buffered request
					const response = await this.executeCustomProvider(
						this.activeCurlProvider.curlCommand,
						userContent,
						curlSystemPrompt,
						effectiveMessage,
						context || "",
						undefined,
						this.activeCurlProvider.responsePath,
						options?.abortSignal,
						CURL_PROVIDER_TIMEOUT_MS,
					);
					if (response.trim().length > 0) {
						yield response;
						return;
					}
				}

				console.warn(
					`[LLMHelper] cURL provider (${this.activeCurlProvider.name}) returned no response. Falling back to standard routing.`,
				);
			} catch (error: any) {
				if (options?.abortSignal?.aborted) {
					throw error;
				}
				console.warn(
					`[LLMHelper] cURL provider (${this.activeCurlProvider.name}) failed after ${CURL_PROVIDER_TIMEOUT_MS}ms timeout window. Falling back to standard routing:`,
					error.message,
				);
			}

			// Deep Mode: do NOT fall back to standard providers — let the caller
			// handle the failure via the deep → conscious → standard fallback chain.
			if (this.deepMode) {
				throw new Error(
					`Deep mode cURL provider (${this.activeCurlProvider.name}) exhausted`,
				);
			}

			yield* this.streamWithProviderFallbackBypass(() =>
				this.streamChat(
					message,
					originalImagePaths,
					originalContext,
					systemPromptOverride,
					options,
				),
			);
			return;
		}

		// 3. Cloud Provider Routing with cross-provider fallback
		const openAiSystem = systemPromptOverride || OPENAI_SYSTEM_PROMPT;
		const finalOpenAiSystem = this.injectLanguageInstruction(openAiSystem);
		const claudeSystem = systemPromptOverride || CLAUDE_SYSTEM_PROMPT;
		const finalClaudeSystem = this.injectLanguageInstruction(claudeSystem);
		const groqSystem = systemPromptOverride
			? baseSystemPrompt
			: GROQ_SYSTEM_PROMPT;
		const finalGroqSystem = this.injectLanguageInstruction(groqSystem);
		const groqFullMessage = this.joinPrompt(finalGroqSystem, userContent);
		const geminiFullMessage = this.joinPrompt(finalSystemPrompt, userContent);

		if (this.isOpenAiModel(this.currentModelId) && this.openaiClient) {
			const openAiSystem = systemPromptOverride || OPENAI_SYSTEM_PROMPT;
			const finalOpenAiSystem = prepareStreamSystemPrompt(openAiSystem);
			if (isMultimodal && imagePaths) {
				yield* this.streamWithScreenshotOcrFallback(
					`OpenAI (${this.getActiveOpenAiModel()})`,
					imagePaths,
					effectiveMessage,
					() =>
						this.streamWithOpenaiMultimodal(
							userContent,
							imagePaths,
							finalOpenAiSystem,
							options?.abortSignal,
						),
					(fallbackMessage) =>
						this.streamWithOpenai(
							buildStreamUserContent(fallbackMessage),
							finalOpenAiSystem,
							options?.abortSignal,
						),
					options?.abortSignal,
				);
			} else {
				yield* this.streamWithOpenai(
					userContent,
					finalOpenAiSystem,
					options?.abortSignal,
				);
			}
			return;
		}

		if (this.isClaudeModel(this.currentModelId) && this.claudeClient) {
			const claudeSystem = systemPromptOverride || CLAUDE_SYSTEM_PROMPT;
			const finalClaudeSystem = prepareStreamSystemPrompt(claudeSystem);
			if (isMultimodal && imagePaths) {
				yield* this.streamWithScreenshotOcrFallback(
					`Claude (${CLAUDE_MODEL})`,
					imagePaths,
					effectiveMessage,
					() =>
						this.streamWithClaudeMultimodal(
							userContent,
							imagePaths,
							finalClaudeSystem,
							options?.abortSignal,
						),
					(fallbackMessage) =>
						this.streamWithClaude(
							buildStreamUserContent(fallbackMessage),
							finalClaudeSystem,
							options?.abortSignal,
						),
					options?.abortSignal,
				);
			} else {
				yield* this.streamWithClaude(
					userContent,
					finalClaudeSystem,
					options?.abortSignal,
				);
			}
			return;
		}

		if (this.isGroqModel(this.currentModelId) && this.groqClient) {
			try {
				if (isMultimodal && imagePaths) {
					// Route multimodal to Groq Llama 4 Scout (vision-capable)
					const groqSystem = systemPromptOverride || OPENAI_SYSTEM_PROMPT;
					const finalGroqSystem = prepareStreamSystemPrompt(groqSystem);
					yield* this.streamWithScreenshotOcrFallback(
						"Groq multimodal",
						imagePaths,
						effectiveMessage,
						() =>
							this.streamWithGroqMultimodal(
								userContent,
								imagePaths,
								finalGroqSystem,
								options?.abortSignal,
							),
						(fallbackMessage) =>
							this.streamWithGroq(
								this.joinPrompt(
									finalGroqSystem,
									buildStreamUserContent(fallbackMessage),
								),
								GROQ_MODEL,
								options?.abortSignal,
							),
						options?.abortSignal,
					);
					return;
				}
			} catch (error: any) {
				if (error?.streamHadOutput) {
					throw error;
				}
				if (isMultimodal) {
					excludedVisionTier1Family = ModelFamily.GROQ_LLAMA;
				} else {
					excludedTextTier1Family = TextModelFamily.GROQ;
				}
				console.warn(
					`[LLMHelper] Selected Groq stream failed. Falling back across providers: ${error.message}`,
				);
			}
			// Text-only Groq
			const groqSystem = systemPromptOverride
				? baseSystemPrompt
				: GROQ_SYSTEM_PROMPT;
			const finalGroqSystem = prepareStreamSystemPrompt(groqSystem);
			const groqFullMessage = this.joinPrompt(finalGroqSystem, userContent);
			yield* this.streamWithGroq(
				groqFullMessage,
				GROQ_MODEL,
				options?.abortSignal,
			);
			return;
		}

		// 4. Gemini Routing & Fallback
		if (this.client) {
			try {
				// Direct model use if specified
				if (this.isGeminiModel(this.currentModelId)) {
					const fullMsg = this.joinPrompt(finalSystemPrompt, userContent);
					if (isMultimodal && imagePaths?.length) {
						yield* this.streamWithScreenshotOcrFallback(
							`Gemini (${this.currentModelId})`,
							imagePaths,
							effectiveMessage,
							() =>
								this.streamWithGeminiModel(
									fullMsg,
									this.currentModelId,
									imagePaths,
									options?.abortSignal,
								),
							(fallbackMessage) =>
								this.streamWithGeminiModel(
									this.joinPrompt(
										finalSystemPrompt,
										buildStreamUserContent(fallbackMessage),
									),
									this.currentModelId,
									undefined,
									options?.abortSignal,
								),
							options?.abortSignal,
						);
						return;
					}
					yield* this.streamWithGeminiModel(
						fullMsg,
						this.currentModelId,
						imagePaths,
						options?.abortSignal,
					);
					return;
				}
			} catch (error: any) {
				if (error?.streamHadOutput) {
					throw error;
				}
				if (isMultimodal) {
					excludedVisionTier1Family = this.currentModelId.includes("pro")
						? ModelFamily.GEMINI_PRO
						: ModelFamily.GEMINI_FLASH;
				} else {
					excludedTextTier1Family = this.currentModelId.includes("pro")
						? TextModelFamily.GEMINI_PRO
						: TextModelFamily.GEMINI_FLASH;
				}
				console.warn(
					`[LLMHelper] Selected Gemini stream failed. Falling back across providers: ${error.message}`,
				);
			}
		}

		type ProviderStreamAttempt = {
			name: string;
			execute: () => AsyncGenerator<string, void, unknown>;
		};
		const orderedTiers = isMultimodal
			? this.getOrderedVisionTiers()
			: this.getOrderedTextTiers();
		const tierKeys: Array<keyof TieredModels> = ["tier1", "tier2", "tier3"];

		for (let tierIndex = 0; tierIndex < tierKeys.length; tierIndex++) {
			const providers: ProviderStreamAttempt[] = [];
			const tierKey = tierKeys[tierIndex];
			const tierEntries = isMultimodal
				? tierIndex === 0 && excludedVisionTier1Family
					? orderedTiers.filter(
							(entry) => entry.family !== excludedVisionTier1Family,
						)
					: orderedTiers
				: tierIndex === 0 && excludedTextTier1Family
					? orderedTiers.filter(
							(entry) => entry.family !== excludedTextTier1Family,
						)
					: orderedTiers;

			for (const entry of tierEntries) {
				const modelId = entry[tierKey];

				if (isMultimodal) {
					if (
						entry.family === ModelFamily.OPENAI &&
						this.openaiClient &&
						imagePaths
					) {
						providers.push({
							name: `OpenAI (${modelId})`,
							execute: () =>
								this.streamWithOpenaiMultimodalUsingModel(
									userContent,
									imagePaths,
									modelId,
									finalOpenAiSystem,
								),
						});
					} else if (
						entry.family === ModelFamily.CLAUDE &&
						this.claudeClient &&
						imagePaths
					) {
						providers.push({
							name: `Claude (${modelId})`,
							execute: () =>
								this.streamWithClaudeMultimodal(
									userContent,
									imagePaths,
									finalClaudeSystem,
								),
						});
					} else if (entry.family === ModelFamily.GEMINI_FLASH && this.client) {
						providers.push({
							name: `Gemini Flash (${modelId})`,
							execute: () =>
								this.streamWithGeminiModel(
									geminiFullMessage,
									modelId,
									imagePaths,
								),
						});
					} else if (entry.family === ModelFamily.GEMINI_PRO && this.client) {
						providers.push({
							name: `Gemini Pro (${modelId})`,
							execute: () =>
								this.streamWithGeminiModel(
									geminiFullMessage,
									modelId,
									imagePaths,
								),
						});
					} else if (
						entry.family === ModelFamily.GROQ_LLAMA &&
						this.groqClient &&
						imagePaths
					) {
						providers.push({
							name: `Groq (${modelId})`,
							execute: () =>
								this.streamWithGroqMultimodal(
									userContent,
									imagePaths,
									finalOpenAiSystem,
								),
						});
					}
					continue;
				}

				if (entry.family === TextModelFamily.GROQ && this.groqClient) {
					providers.push({
						name: `Groq (${modelId})`,
						execute: () => this.streamWithGroq(groqFullMessage, modelId),
					});
				} else if (
					entry.family === TextModelFamily.OPENAI &&
					this.openaiClient
				) {
					providers.push({
						name: `OpenAI (${modelId})`,
						execute: () =>
							this.streamWithOpenaiUsingModel(
								userContent,
								modelId,
								finalOpenAiSystem,
							),
					});
				} else if (
					entry.family === TextModelFamily.CLAUDE &&
					this.claudeClient
				) {
					providers.push({
						name: `Claude (${modelId})`,
						execute: () =>
							this.streamWithClaude(userContent, finalClaudeSystem),
					});
				} else if (
					entry.family === TextModelFamily.GEMINI_FLASH &&
					this.client
				) {
					providers.push({
						name: `Gemini Flash (${modelId})`,
						execute: () =>
							this.streamWithGeminiModel(geminiFullMessage, modelId),
					});
				} else if (entry.family === TextModelFamily.GEMINI_PRO && this.client) {
					providers.push({
						name: `Gemini Pro (${modelId})`,
						execute: () =>
							this.streamWithGeminiModel(geminiFullMessage, modelId),
					});
				}
			}

			// Race strategy (default)
			const raceMsg = this.joinPrompt(finalSystemPrompt, userContent);
			if (qualityTier === "verify") {
				if (isMultimodal && imagePaths?.length) {
					yield* this.streamWithScreenshotOcrFallback(
						`Gemini (${GEMINI_PRO_MODEL})`,
						imagePaths,
						effectiveMessage,
						() =>
							this.streamWithGeminiModel(
								raceMsg,
								GEMINI_PRO_MODEL,
								imagePaths,
								options?.abortSignal,
							),
						(fallbackMessage) =>
							this.streamWithGeminiModel(
								this.joinPrompt(
									finalSystemPrompt,
									buildStreamUserContent(fallbackMessage),
								),
								GEMINI_PRO_MODEL,
								undefined,
								options?.abortSignal,
							),
						options?.abortSignal,
					);
				} else {
					yield* this.streamWithGeminiModel(
						raceMsg,
						GEMINI_PRO_MODEL,
						imagePaths,
						options?.abortSignal,
					);
				}
			} else {
				if (isMultimodal && imagePaths?.length) {
					yield* this.streamWithScreenshotOcrFallback(
						"Gemini race",
						imagePaths,
						effectiveMessage,
						() =>
							this.streamWithGeminiParallelRace(
								raceMsg,
								imagePaths,
								options?.abortSignal,
							),
						(fallbackMessage) =>
							this.streamWithGeminiParallelRace(
								this.joinPrompt(
									finalSystemPrompt,
									buildStreamUserContent(fallbackMessage),
								),
								undefined,
								options?.abortSignal,
							),
						options?.abortSignal,
					);
				} else {
					yield* this.streamWithGeminiParallelRace(
						raceMsg,
						imagePaths,
						options?.abortSignal,
					);
				}
			}
		}

		throw new Error("No LLM provider available");
	}

	/**
	 * Stream response from Groq
	 */
	public async *streamWithGroq(
		fullMessage: string,
		modelOverride: string = GROQ_MODEL,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithGroq(this, fullMessage, modelOverride, abortSignal);
	}

	private async *streamWithCerebras(
		userMessage: string,
		systemPrompt?: string,
		modelOverride?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithCerebras(
			this,
			userMessage,
			systemPrompt,
			modelOverride,
			abortSignal,
		);
	}

	/**
	 * Stream multimodal (image + text) response from Groq using Llama 4 Scout as a last resort
	 */
	public async *streamWithGroqMultimodal(
		userMessage: string,
		imagePaths: string[],
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithGroqMultimodal(
			this,
			userMessage,
			imagePaths,
			systemPrompt,
			abortSignal,
		);
	}

	/**
	 * Stream response from OpenAI with proper system/user message separation
	 */
	public async *streamWithOpenai(
		userMessage: string,
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithOpenai(this, userMessage, systemPrompt, abortSignal);
	}

	/**
	 * Stream response from Claude with proper system/user message separation
	 */
	public async *streamWithClaude(
		userMessage: string,
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithClaude(this, userMessage, systemPrompt, abortSignal);
	}

	/**
	 * Stream multimodal (image + text) response from OpenAI with system/user separation
	 */
	public async *streamWithOpenaiMultimodal(
		userMessage: string,
		imagePaths: string[],
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithOpenaiMultimodal(
			this,
			userMessage,
			imagePaths,
			systemPrompt,
			abortSignal,
		);
	}

	private async *streamWithOpenaiUsingModel(
		userMessage: string,
		model: string,
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithOpenaiUsingModel(
			this,
			userMessage,
			model,
			systemPrompt,
			abortSignal,
		);
	}

	private async *streamWithOpenaiMultimodalUsingModel(
		userMessage: string,
		imagePaths: string[],
		model: string,
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithOpenaiMultimodalUsingModel(
			this,
			userMessage,
			imagePaths,
			model,
			systemPrompt,
			abortSignal,
		);
	}

	/**
	 * Stream multimodal (image + text) response from Claude with system/user separation
	 */
	public async *streamWithClaudeMultimodal(
		userMessage: string,
		imagePaths: string[],
		systemPrompt?: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithClaudeMultimodal(
			this,
			userMessage,
			imagePaths,
			systemPrompt,
			abortSignal,
		);
	}

	/**
	 * Stream response from a specific Gemini model
	 */
	public async *streamWithGeminiModel(
		fullMessage: string,
		model: string,
		imagePaths?: string[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithGeminiModel(
			this,
			fullMessage,
			model,
			imagePaths,
			abortSignal,
		);
	}

	/**
	 * Race Flash and Pro streams, return whichever succeeds first
	 */
	public async *streamWithGeminiParallelRace(
		fullMessage: string,
		imagePaths?: string[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		yield* _streamWithGeminiParallelRace(
			this,
			fullMessage,
			imagePaths,
			abortSignal,
		);
	}

	/**
	 * Stream chunks from a specific Gemini model.
	 */
	public async *streamGeminiModelChunks(
		fullMessage: string,
		model: string,
		imagePaths?: string[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		if (!this.client) throw new Error("Gemini client not initialized");

		const contents: any[] = [{ text: fullMessage }];
		if (imagePaths?.length) {
			for (const p of imagePaths) {
				if (fs.existsSync(p)) {
					const imageData = await fs.promises.readFile(p);
					contents.push({
						inlineData: {
							mimeType: "image/png",
							data: imageData.toString("base64"),
						},
					});
				}
			}
		}

		const requestControl = createRequestAbortController(
			LLM_API_TIMEOUT_MS,
			abortSignal,
		);

		const streamResult = await this.client.models.generateContentStream({
			model: model,
			contents: contents,
			config: {
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.4,
			},
		});

		// @ts-expect-error
		const stream = streamResult.stream || streamResult;

		try {
			for await (const chunk of stream) {
				if (requestControl.signal.aborted) {
					console.log("[LLMHelper] streamGeminiModelChunks aborted");
					return;
				}
				let chunkText = "";
				if (typeof chunk.text === "function") {
					chunkText = chunk.text();
				} else if (typeof chunk.text === "string") {
					chunkText = chunk.text;
				} else if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
					chunkText = chunk.candidates[0].content.parts[0].text;
				}
				if (chunkText) {
					yield chunkText;
				}
			}
		} finally {
			requestControl.cleanup();
		}
	}

	// --- OLLAMA STREAMING ---
	private async *streamWithOllama(
		message: string,
		context?: string,
		systemPrompt: string = UNIVERSAL_SYSTEM_PROMPT,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string, void, unknown> {
		const fullPrompt = context
			? `SYSTEM: ${systemPrompt}\nCONTEXT: ${context}\nUSER: ${message}`
			: `SYSTEM: ${systemPrompt}\nUSER: ${message}`;

		try {
			const requestControl = createRequestAbortController(
				LLM_API_TIMEOUT_MS,
				abortSignal,
			);
			try {
				const response = await fetch(`${this.ollamaUrl}/api/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: this.ollamaModel,
						prompt: fullPrompt,
						stream: true,
						options: { temperature: 0.7 },
					}),
					signal: requestControl.signal,
				});

				if (!response.body) throw new Error("No response body from Ollama");

				// iterate over the readable stream
				for await (const chunk of response.body) {
					if (abortSignal?.aborted) {
						return;
					}
					const text = new TextDecoder().decode(chunk);
					// Ollama sends JSON objects per line
					const lines = text.split("\n").filter((l) => l.trim());
					for (const line of lines) {
						try {
							const json = JSON.parse(line);
							if (json.response) yield json.response;
							if (json.done) return;
						} catch (_e) {
							// ignore partial json
						}
					}
				}
			} finally {
				requestControl.cleanup();
			}
		} catch (e) {
			// NAT-040 / audit P-9: previously this branch yielded the literal
			// string "Error: Failed to stream from Ollama." which then flowed
			// through the IPC and was rendered to the user as if it were a
			// model response (and worse, was indexed by downstream answer
			// ranking). The accuracy bug is straightforward: the model said
			// nothing, but the user saw a sentence. We now propagate the
			// failure as a typed Error so the streaming IPC layer translates
			// it into a `gemini-stream-error` event (NAT-036).
			console.error("Ollama streaming failed", sanitizeError(e));
			throw e instanceof Error
				? e
				: new Error(`Ollama streaming failed: ${sanitizeError(e)}`);
		}
	}

	public delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	public isUsingOllama(): boolean {
		return this.useOllama;
	}

	public async getOllamaModels(): Promise<string[]> {
		const baseUrl = (this.ollamaUrl || "http://127.0.0.1:11434").replace(
			"localhost",
			"127.0.0.1",
		);

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 1000); // Fast 1s timeout

			const response = await fetch(`${baseUrl}/api/tags`, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) return [];

			const data = await response.json();
			if (data?.models) {
				return data.models.map((m: any) => m.name);
			}

			return [];
		} catch (_error: any) {
			// Silently catch connection refused/timeout errors.
			// OllamaManager handles logging the startup status.
			return [];
		}
	}

	public async forceRestartOllama(): Promise<boolean> {
		try {
			console.log("[LLMHelper] Attempting to force restart Ollama...");

			// 1. Check for process on port 11434
			try {
				const { stdout } = await execAsync(`lsof -t -i:11434`);
				const pid = stdout.trim();
				if (pid) {
					console.log(`[LLMHelper] Found blocking PID: ${pid}. Killing...`);
					await execAsync(`kill -9 ${pid}`);
				}
			} catch (_e: any) {
				// lsof returns 1 if no process found, which throws error in execAsync
				// Ignore unless it's a real error
			}

			// 2. Restart Ollama through the Manager (which handles polling and background spawn)
			// We don't want to use exec('ollama serve') here directly anymore to avoid duplicate tracking
			const { OllamaManager } = require("./services/OllamaManager");
			await OllamaManager.getInstance().init();

			return true;
		} catch (error) {
			console.error(
				"[LLMHelper] Failed to restart Ollama:",
				sanitizeError(error),
			);
			return false;
		}
	}

	public getCurrentProvider(): "ollama" | "gemini" | "custom" {
		if (this.customProvider) return "custom";
		return this.useOllama ? "ollama" : "gemini";
	}

	public getProviderCapabilityClass(): ProviderCapabilityClass {
		return classifyProviderCapability({
			useOllama: this.useOllama,
			activeCurlProvider: !!this.activeCurlProvider,
			isOpenAiModel: this.isOpenAiModel(this.currentModelId),
			isClaudeModel: this.isClaudeModel(this.currentModelId),
			isGroqModel: this.isGroqModel(this.currentModelId),
			isGeminiModel: this.isGeminiModel(this.currentModelId),
		});
	}

	public hasStructuredGenerationCapability(): boolean {
		return Boolean(
			this.openaiClient || this.claudeClient || this.client || this.groqClient,
		);
	}

	public getCurrentModel(): string {
		if (this.customProvider) return this.customProvider.name;
		if (this.activeCurlProvider) return this.activeCurlProvider.id;
		return this.useOllama ? this.ollamaModel : this.currentModelId;
	}

	/**
	 * Get the Gemini client for mode-specific LLMs
	 * Used by AnswerLLM, AssistLLM, FollowUpLLM, RecapLLM
	 * RETURNS A PROXY client that handles retries and fallbacks transparently
	 */
	public getGeminiClient(): GoogleGenAI | null {
		if (!this.client) return null;
		return this.createRobustClient(this.client);
	}

	/**
	 * Get the Groq client for mode-specific LLMs
	 */
	public getGroqClient(): Groq | null {
		return this.groqClient;
	}

	/**
	 * Check if Groq is available
	 */
	public hasGroq(): boolean {
		return this.groqClient !== null;
	}

	/**
	 * Get the OpenAI client for mode-specific LLMs
	 */
	public getOpenaiClient(): OpenAI | null {
		return this.openaiClient;
	}

	/**
	 * Get the Claude client for mode-specific LLMs
	 */
	public getClaudeClient(): Anthropic | null {
		return this.claudeClient;
	}

	/**
	 * Check if OpenAI is available
	 */
	public hasOpenai(): boolean {
		return this.openaiClient !== null;
	}

	/**
	 * Check if Claude is available
	 */
	public hasClaude(): boolean {
		return this.claudeClient !== null;
	}

	/**
	 * Stream with Groq using a specific prompt, with Gemini fallback
	 * Used by mode-specific LLMs (RecapLLM, FollowUpLLM, WhatToAnswerLLM)
	 * @param groqMessage - Message with Groq-optimized prompt
	 * @param geminiMessage - Message with Gemini prompt (for fallback)
	 * @param config - Optional temperature and max tokens
	 */
	public async *streamWithGroqOrGemini(
		groqMessage: string,
		geminiMessage: string,
		config?: { temperature?: number; maxTokens?: number },
	): AsyncGenerator<string, void, unknown> {
		const temperature = config?.temperature ?? 0.3;
		const maxTokens = config?.maxTokens ?? 8192;

		// Try Groq first if available
		if (this.groqClient) {
			try {
				await this.rateLimiters.groq.acquire();
				console.log(`[LLMHelper] 🚀 Mode-specific Groq stream starting...`);
				const timeoutSignal = createTimeoutSignal(LLM_API_TIMEOUT_MS);

				const stream = await this.groqClient.chat.completions.create(
					{
						model: GROQ_MODEL,
						messages: [{ role: "user", content: groqMessage }],
						stream: true,
						temperature: temperature,
						max_tokens: maxTokens,
					},
					{ signal: timeoutSignal },
				);

				for await (const chunk of stream) {
					const content = chunk.choices[0]?.delta?.content;
					if (content) {
						yield content;
					}
				}
				console.log(`[LLMHelper] ✅ Mode-specific Groq stream completed`);
				return; // Success - done
			} catch (err: any) {
				console.warn(
					`[LLMHelper] ⚠️ Groq mode-specific failed: ${err.message}, falling back to Gemini`,
				);
			}
		}

		// Fallback to Gemini
		if (this.client) {
			console.log(
				`[LLMHelper] 🔄 Falling back to Gemini for mode-specific request...`,
			);
			yield* this.streamWithGeminiModel(geminiMessage, GEMINI_FLASH_MODEL);
		} else {
			throw new Error("No LLM provider available");
		}
	}

	/**
	 * Creates a proxy around the real Gemini client to intercept generation calls
	 * and apply robust retry/fallback logic without modifying consumer code.
	 */
	private createRobustClient(realClient: GoogleGenAI): GoogleGenAI {
		// We proxy the 'models' property to intercept 'generateContent'
		const modelsProxy = new Proxy(realClient.models, {
			get: (target, prop, receiver) => {
				if (prop === "generateContent") {
					return async (args: any) => {
						return this.generateWithFallback(realClient, args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		// We proxy the client itself to return our modelsProxy
		return new Proxy(realClient, {
			get: (target, prop, receiver) => {
				if (prop === "models") {
					return modelsProxy;
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	}

	/**
	 * ROBUST GENERATION STRATEGY (SPECULATIVE PARALLEL EXECUTION)
	 * 1. Attempt with original model (Flash).
	 * 2. If it fails/empties:
	 *    - IMMEDIATELY launch two requests in parallel:
	 *      a) Retry Flash (Attempt 2)
	 *      b) Start Pro (Backup)
	 * 3. Return whichever finishes successfully first (prioritizing Flash if both fast).
	 * 4. If both fail, try Flash one last time (Attempt 3).
	 * 5. If that fails, throw error.
	 */
	private async generateWithFallback(
		client: GoogleGenAI,
		args: any,
	): Promise<any> {
		const originalModel = args.model;

		// Helper to check for valid content
		const isValidResponse = (response: any) => {
			const candidate = response.candidates?.[0];
			if (!candidate) return false;
			// Check for text content
			if (response.text && response.text.trim().length > 0) return true;
			if (
				candidate.content?.parts?.[0]?.text &&
				candidate.content.parts[0].text.trim().length > 0
			)
				return true;
			if (
				typeof candidate.content === "string" &&
				candidate.content.trim().length > 0
			)
				return true;
			return false;
		};

		// 1. Initial Attempt (Flash)
		try {
			const response = await client.models.generateContent({
				...args,
				model: originalModel,
			});
			if (isValidResponse(response)) return response;
			console.warn(
				`[LLMHelper] Initial ${originalModel} call returned empty/invalid response.`,
			);
		} catch (error: any) {
			console.warn(
				`[LLMHelper] Initial ${originalModel} call failed: ${error.message}`,
			);
		}

		console.log(
			`[LLMHelper] 🚀 Triggering Speculative Parallel Retry (Flash + Pro)...`,
		);

		// 2. Parallel Execution (Retry Flash vs Pro)
		// We create promises for both but treat them carefully
		const flashRetryPromise = (async () => {
			const res = await client.models.generateContent({
				...args,
				model: originalModel,
			});
			if (isValidResponse(res)) return { type: "flash", res };
			throw new Error("Empty Flash Response");
		})();

		const proBackupPromise = (async () => {
			// Pro might be slower, but it's the robust backup
			const res = await client.models.generateContent({
				...args,
				model: GEMINI_PRO_MODEL,
			});
			if (isValidResponse(res)) return { type: "pro", res };
			throw new Error("Empty Pro Response");
		})();

		// 3. Race / Fallback Logic
		try {
			// We want Flash if it succeeds, but will accept Pro if Flash fails
			// If Flash finishes first and success -> return Flash
			// If Pro finishes first -> wait for Flash? Or return Pro?
			// User said: "if the gemini 3 flash again fails the gemini 3 pro response can be immediatly displayed"
			// This implies we prioritize Flash's *result*, but if Flash fails, we want Pro.

			// We use Promise.any to get the first *successful* result
			const winner = await Promise.any([flashRetryPromise, proBackupPromise]);
			console.log(`[LLMHelper] Parallel race won by: ${winner.type}`);
			return winner.res;
		} catch (_aggregateError) {
			console.warn(`[LLMHelper] Both parallel retry attempts failed.`);
		}

		// 4. Last Resort: Flash Final Retry
		console.log(
			`[LLMHelper] ⚠️ All parallel attempts failed. Trying Flash one last time...`,
		);
		try {
			return await client.models.generateContent({
				...args,
				model: originalModel,
			});
		} catch (finalError) {
			console.error(`[LLMHelper] Final retry failed.`);
			throw finalError;
		}
	}

	private async withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		operationName: string,
	): Promise<T> {
		let timeoutHandle: NodeJS.Timeout;
		const timeoutPromise = new Promise<T>((_, reject) => {
			timeoutHandle = setTimeout(
				() =>
					reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});

		return Promise.race([
			promise.then((result) => {
				clearTimeout(timeoutHandle);
				return result;
			}),
			timeoutPromise,
		]);
	}

	/**
	 * Robust Meeting Summary Generation
	 * Strategy:
	 * 1. Groq (if context text < 100k tokens approx)
	 * 2. Gemini Flash (Retry 2x)
	 * 3. Gemini Pro (Retry 5x)
	 */
	public async generateMeetingSummary(
		systemPrompt: string,
		context: string,
		groqSystemPrompt?: string,
	): Promise<string> {
		console.log(
			`[LLMHelper] generateMeetingSummary called. Context length: ${context.length}`,
		);

		const safeContext = this.trimTextToTokenBudget(
			context,
			SUMMARY_INPUT_TOKEN_BUDGET,
			true,
		);
		const tokenCount = this.estimateTokens(safeContext);
		console.log(`[LLMHelper] Estimated tokens: ${tokenCount}`);

		// ATTEMPT 1: Groq (if text-only and within limits)
		// Groq Llama 3.3 70b has ~128k context, let's be safe with 100k
		if (this.groqClient && tokenCount < 100000) {
			console.log(`[LLMHelper] Attempting Groq for summary...`);
			try {
				const groqPrompt = groqSystemPrompt || systemPrompt;
				// Use non-streaming for summary
				const response = await this.withTimeout(
					this.groqClient.chat.completions.create({
						model: GROQ_MODEL,
						messages: [
							{ role: "system", content: groqPrompt },
							{ role: "user", content: `Context:\n${safeContext}` },
						],
						temperature: 0.3,
						max_tokens: 8192,
						stream: false,
					}),
					45000,
					"Groq Summary",
				);

				const text = response.choices[0]?.message?.content || "";
				if (text.trim().length > 0) {
					console.log(`[LLMHelper] ✅ Groq summary generated successfully.`);
					return this.processResponse(text);
				}
			} catch (e: any) {
				console.warn(
					`[LLMHelper] ⚠️ Groq summary failed: ${e.message}. Falling back to Gemini...`,
				);
			}
		} else {
			if (tokenCount >= 100000) {
				console.log(
					`[LLMHelper] Context too large for Groq (${tokenCount} tokens). Skipping straight to Gemini.`,
				);
			}
		}

		// ATTEMPT 2: Gemini Flash (with 2 retries = 3 attempts total)
		console.log(`[LLMHelper] Attempting Gemini Flash for summary...`);
		const contents = [{ text: `${systemPrompt}\n\nCONTEXT:\n${safeContext}` }];

		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const text = await this.withTimeout(
					this.generateWithFlash(contents),
					45000,
					`Gemini Flash Summary (Attempt ${attempt})`,
				);
				if (text.trim().length > 0) {
					console.log(
						`[LLMHelper] ✅ Gemini Flash summary generated successfully (Attempt ${attempt}).`,
					);
					return this.processResponse(text);
				}
			} catch (e: any) {
				console.warn(
					`[LLMHelper] ⚠️ Gemini Flash attempt ${attempt}/3 failed: ${e.message}`,
				);
				if (attempt < 3) {
					await new Promise((r) => setTimeout(r, 1000 * attempt)); // Linear backoff
				}
			}
		}

		// ATTEMPT 3: Gemini Pro (Infinite-ish loop)
		// User requested "call gemini 3 pro until summary is generated"
		// We will cap it at 5 heavily backed-off retries to avoid hanging processes forever,
		// but effectively this acts as a very persistent retry.
		console.log(
			`[LLMHelper] ⚠️ Flash exhausted. Switching to Gemini Pro for robust retry...`,
		);
		const maxProRetries = 5;

		if (!this.client) throw new Error("Gemini client not initialized");

		for (let attempt = 1; attempt <= maxProRetries; attempt++) {
			try {
				console.log(
					`[LLMHelper] 🔄 Gemini Pro Attempt ${attempt}/${maxProRetries}...`,
				);
				const response = await this.withTimeout(
					this.client.models.generateContent({
						model: GEMINI_PRO_MODEL,
						contents: contents,
						config: {
							maxOutputTokens: MAX_OUTPUT_TOKENS,
							temperature: 0.3,
						},
					}),
					60000,
					`Gemini Pro Summary (Attempt ${attempt})`,
				);
				const text = response.text || "";

				if (text.trim().length > 0) {
					console.log(
						`[LLMHelper] ✅ Gemini Pro summary generated successfully.`,
					);
					return this.processResponse(text);
				}
			} catch (e: any) {
				console.warn(
					`[LLMHelper] ⚠️ Gemini Pro attempt ${attempt} failed: ${e.message}`,
				);
				// Aggressive backoff for Pro: 2s, 4s, 8s, 16s, 32s
				const backoff = 2000 * 2 ** (attempt - 1);
				console.log(`[LLMHelper] Waiting ${backoff}ms before next retry...`);
				await new Promise((r) => setTimeout(r, backoff));
			}
		}

		throw new Error("Failed to generate summary after all fallback attempts.");
	}

	public async switchToOllama(model?: string, url?: string): Promise<void> {
		this.useOllama = true;
		if (url) this.ollamaUrl = url;

		if (model) {
			this.ollamaModel = model;
		} else {
			// Auto-detect first available model
			await this.initializeOllamaModel();
		}

		// console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
	}

	public async switchToGemini(
		apiKey?: string,
		modelId?: string,
	): Promise<void> {
		if (modelId) {
			this.geminiModel = modelId;
		}

		if (apiKey) {
			this.apiKey = apiKey;
			this.client = new GoogleGenAI({
				apiKey: apiKey,
				httpOptions: { apiVersion: "v1alpha" },
			});
		} else if (!this.client) {
			throw new Error("No Gemini API key provided and no existing client");
		}

		this.useOllama = false;
		this.customProvider = null;
		// console.log(`[LLMHelper] Switched to Gemini: ${this.geminiModel}`);
	}

	public async switchToCustom(provider: CustomProvider): Promise<void> {
		this.customProvider = provider;
		this.useOllama = false;
		this.client = null;
		this.groqClient = null;
		this.openaiClient = null;
		this.claudeClient = null;
		console.log(`[LLMHelper] Switched to Custom Provider: ${provider.name}`);
	}

	public async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			if (this.useOllama) {
				const available = await this.checkOllamaAvailable();
				if (!available) {
					return {
						success: false,
						error: `Ollama not available at ${this.ollamaUrl}`,
					};
				}
				// Test with a simple prompt
				await this.callOllama("Hello");
				return { success: true };
			} else {
				if (!this.client) {
					return { success: false, error: "No Gemini client configured" };
				}
				// Test with a simple prompt using the selected model
				const text = await this.generateContent([{ text: "Hello" }]);
				if (text) {
					return { success: true };
				} else {
					return { success: false, error: "Empty response from Gemini" };
				}
			}
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	}
	/**
	 * Deep Mode: Execute cURL with adaptive context window.
	 * Starts with full context, halves on likely context-overflow errors,
	 * and returns the first successful result.
	 */
	public async executeDeepWithAdaptiveContext(
		fullContext: string,
		generateFn: (context: string) => Promise<string>,
	): Promise<string> {
		const maxAttempts = 4;
		const minBudget = 2048;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const context =
					attempt === 0
						? fullContext
						: this.trimContextToTokenBudget(
								fullContext,
								Math.max(minBudget, 32768 >> attempt),
							);
				const result = await generateFn(context);
				if (attempt > 0) {
					console.log(
						`[LLMHelper] Deep Mode adaptive context succeeded at attempt ${attempt + 1}`,
					);
				}
				return result;
			} catch (e: any) {
				if (this.isLikelyContextOverflowError(e)) {
					const nextBudget = attempt === 0 ? 32768 : 32768 >> attempt;
					if (nextBudget < minBudget) {
						throw e;
					}
					console.warn(
						`[LLMHelper] Deep Mode context overflow, retrying at ~${nextBudget} tokens`,
					);
					continue;
				}
				throw e;
			}
		}

		throw new Error("Deep mode: all adaptive context sizes exhausted");
	}

	private isLikelyContextOverflowError(error: any): boolean {
		const message = String(error?.message || error || "").toLowerCase();
		return (
			message.includes("context length") ||
			message.includes("too long") ||
			message.includes("max context") ||
			message.includes("maximum context") ||
			message.includes("context window") ||
			message.includes("too many tokens") ||
			message.includes("token limit") ||
			message.includes("reduce the length") ||
			message.includes("truncat")
		);
	}

	/**
	 * Deep Mode: Verify claims against context in background.
	 * Launches parallel mini-LLM calls via cURL to check each claim.
	 */
	public async verifyClaimsInBackground(
		claims: { text: string }[],
		fullContext: string,
	): Promise<{ supported: boolean; unsupportedClaims: string[] }> {
		if (!this.activeCurlProvider || claims.length === 0) {
			return { supported: true, unsupportedClaims: [] };
		}

		const truncatedContext = fullContext.slice(0, 16000);

		const results = await Promise.all(
			claims.map(async (claim) => {
				try {
					const response = await this.chatWithCurl(
						`CLAIM: "${claim.text}"\n\nCONTEXT:\n${truncatedContext}\n\nIs this claim supported by the context above? Answer ONLY "YES" or "NO" followed by one sentence explaining why.`,
						"You verify whether claims are supported by context. Answer ONLY YES or NO, then one sentence why.",
					);
					return {
						claim: claim.text,
						supported: response.trim().toUpperCase().startsWith("YES"),
					};
				} catch {
					return { claim: claim.text, supported: true };
				}
			}),
		);

		const unsupported = results.filter((r) => !r.supported).map((r) => r.claim);
		return {
			supported: unsupported.length === 0,
			unsupportedClaims: unsupported,
		};
	}

	/**
	 * Universal Chat (Non-streaming)
	 */
	public async chat(
		message: string,
		imagePaths?: string[],
		context?: string,
		systemPromptOverride?: string,
	): Promise<string> {
		let fullResponse = "";
		for await (const chunk of this.streamChat(
			message,
			imagePaths,
			context,
			systemPromptOverride,
		)) {
			fullResponse += chunk;
		}
		return fullResponse;
	}
}
