import fs from "fs";
import type { LLMHelper, ScreenshotEventRoutingResult } from "../../LLMHelper";
import { CLAUDE_MODEL, GROQ_MODEL } from "../../LLMHelper";
import {
	CLAUDE_SYSTEM_PROMPT,
	CUSTOM_SYSTEM_PROMPT,
	GROQ_SYSTEM_PROMPT,
	HARD_SYSTEM_PROMPT,
	OPENAI_SYSTEM_PROMPT,
} from "../../llm/prompts";
import { TextModelFamily } from "../../services/ModelVersionManager";

/** Default timeout for LLM API calls in milliseconds */
const LLM_API_TIMEOUT_MS = 30000;
const CURL_PROVIDER_TIMEOUT_MS = 60000;
const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview";
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Sanitize error objects to remove sensitive data before logging
 */
function sanitizeError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
	}
	if (typeof error === "object" && error !== null) {
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

/**
 * Generate content using Gemini 3 Flash (text reasoning)
 * Used by IntelligenceManager for mode-specific prompts
 * NOTE: Migrated from Pro to Flash for consistency
 */
export async function generateWithPro(
	helper: LLMHelper,
	contents: any[],
): Promise<string> {
	if (!helper.client) throw new Error("Gemini client not initialized");

	await helper.rateLimiters.gemini.acquire();
	// console.log(`[LLMHelper] Calling ${GEMINI_FLASH_MODEL}...`)
	const response = await helper.client.models.generateContent({
		model: GEMINI_PRO_MODEL,
		contents: contents,
		config: {
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			temperature: 0.3, // Lower = faster, more focused
		},
	});
	return response.text || "";
}

/**
 * Generate content using Gemini 3 Flash (audio + fast multimodal)
 * CRITICAL: Audio input MUST use this model, not Pro
 */
export async function generateWithFlash(
	helper: LLMHelper,
	contents: any[],
): Promise<string> {
	if (!helper.client) throw new Error("Gemini client not initialized");

	await helper.rateLimiters.gemini.acquire();
	// console.log(`[LLMHelper] Calling ${GEMINI_FLASH_MODEL}...`)
	const response = await helper.client.models.generateContent({
		model: GEMINI_FLASH_MODEL,
		contents: contents,
		config: {
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			temperature: 0.3, // Lower = faster, more focused
		},
	});
	return response.text || "";
}

export async function chatWithGemini(
	helper: LLMHelper,
	message: string,
	imagePaths?: string[],
	context?: string,
	skipSystemPrompt: boolean = false,
	alternateGroqMessage?: string,
): Promise<string> {
	try {
		console.log(
			`[LLMHelper] chatWithGemini called with message:`,
			message.substring(0, 50),
		);
		const originalImagePaths = imagePaths ? [...imagePaths] : undefined;
		const originalContext = context;
		const hasScreenshotInput = !!imagePaths?.length;
		let effectiveMessage = hasScreenshotInput
			? message
			: helper.applyDefaultBrevityHint(message);
		const structuredScreenshotRequest =
			helper.isStructuredOutputRequest(effectiveMessage);
		const preserveSystemPromptForStructuredOutput = structuredScreenshotRequest;
		let screenshotRouting: ScreenshotEventRoutingResult | null = null;
		const forceTextFallback =
			helper.shouldForceScreenshotTextFallback(imagePaths);

		if (hasScreenshotInput && imagePaths) {
			screenshotRouting = await helper.prepareScreenshotEventRouting({
				message: effectiveMessage,
				context,
				imagePaths,
				forceTextFallback,
			});
			effectiveMessage = screenshotRouting.userMessage;
			context = screenshotRouting.context;
			imagePaths = screenshotRouting.imagePaths;
		}

		// ============================================================
		// KNOWLEDGE MODE INTERCEPT
		// If knowledge mode is active, check for intro questions and
		// inject system prompt + relevant context
		// ============================================================
		if (
			!hasScreenshotInput &&
			helper.knowledgeOrchestrator?.isKnowledgeMode()
		) {
			try {
				// Feed the interviewer's utterance to the Technical Depth Scorer
				// so tone adapts dynamically (HR buzzwords → high-level, technical terms → deep technical)
				helper.knowledgeOrchestrator.feedInterviewerUtterance(message);

				const knowledgeResult =
					await helper.knowledgeOrchestrator.processQuestion(message);
				if (knowledgeResult) {
					// Intro question shortcut — return generated response directly
					if (
						knowledgeResult.isIntroQuestion &&
						knowledgeResult.introResponse
					) {
						console.log(
							"[LLMHelper] Knowledge mode: returning generated intro response",
						);
						return knowledgeResult.introResponse;
					}
					// Inject knowledge system prompt and context
					if (!skipSystemPrompt && knowledgeResult.systemPromptInjection) {
						skipSystemPrompt = false; // ensure we use the knowledge prompt
						// Prepend knowledge context to existing context
						if (knowledgeResult.contextBlock) {
							context = context
								? `${knowledgeResult.contextBlock}\n\n${context}`
								: knowledgeResult.contextBlock;
						}
					}
				}
			} catch (knowledgeError: any) {
				console.warn(
					"[LLMHelper] Knowledge mode processing failed, falling back to normal:",
					knowledgeError.message,
				);
			}
		}

		const isMultimodal = !!imagePaths?.length;
		const screenshotSystemPrompt = preserveSystemPromptForStructuredOutput
			? undefined
			: screenshotRouting?.systemPrompt;
		const enforceSystemPrompt = !!screenshotSystemPrompt;
		const skipPromptForRequest = enforceSystemPrompt ? false : skipSystemPrompt;
		const buildSystemPrompt = (basePrompt: string) =>
			screenshotSystemPrompt
				? basePrompt
				: helper.injectLanguageInstruction(basePrompt);

		// Helper to build combined prompts for Groq/Gemini
		const buildMessage = (
			provider: string,
			modelId: string,
			systemPrompt: string,
		) => {
			const preparedUserContent = helper.prepareUserContentForModel(
				provider,
				modelId,
				effectiveMessage,
				context,
			);
			if (skipPromptForRequest) {
				return preparedUserContent;
			}
			return helper.joinPrompt(
				systemPrompt,
				preparedUserContent,
				helper.getInputTokenBudget(provider, modelId),
			);
		};

		// For OpenAI/Claude: separate system prompt + user message
		const activeOpenAiModel = helper.getActiveOpenAiModel();
		const openaiUserContent = helper.prepareUserContentForModel(
			"openai",
			activeOpenAiModel,
			effectiveMessage,
			context,
		);
		const claudeUserContent = helper.prepareUserContentForModel(
			"claude",
			CLAUDE_MODEL,
			effectiveMessage,
			context,
		);

		const geminiBasePrompt = screenshotSystemPrompt || HARD_SYSTEM_PROMPT;
		const groqBasePrompt =
			screenshotSystemPrompt || alternateGroqMessage || GROQ_SYSTEM_PROMPT;
		const openAiBasePrompt = screenshotSystemPrompt || OPENAI_SYSTEM_PROMPT;
		const claudeBasePrompt = screenshotSystemPrompt || CLAUDE_SYSTEM_PROMPT;

		const finalGeminiPrompt = await helper.withSystemPromptCache(
			"gemini",
			helper.currentModelId,
			geminiBasePrompt,
			() => buildSystemPrompt(geminiBasePrompt),
		);
		const finalGroqPrompt = await helper.withSystemPromptCache(
			"groq",
			GROQ_MODEL,
			groqBasePrompt,
			() => buildSystemPrompt(groqBasePrompt),
		);

		const combinedMessages = {
			gemini: buildMessage("gemini", helper.currentModelId, finalGeminiPrompt),
			groq: buildMessage("groq", GROQ_MODEL, finalGroqPrompt),
		};

		const openaiSystemPrompt = skipPromptForRequest
			? undefined
			: await helper.withSystemPromptCache(
					"openai",
					activeOpenAiModel,
					openAiBasePrompt,
					() => buildSystemPrompt(openAiBasePrompt),
				);
		const claudeSystemPrompt = skipPromptForRequest
			? undefined
			: await helper.withSystemPromptCache(
					"claude",
					CLAUDE_MODEL,
					claudeBasePrompt,
					() => buildSystemPrompt(claudeBasePrompt),
				);
		const canUseFastResponse =
			!isMultimodal &&
			!helper.activeCurlProvider &&
			!helper.customProvider &&
			!helper.useOllama;
		const fastResponseTarget = canUseFastResponse
			? helper.getActiveFastResponseTarget()
			: null;
		if (fastResponseTarget) {
			console.log(
				`[LLMHelper] ⚡️ Fast Response Mode Active. Routing to ${fastResponseTarget.provider} (${fastResponseTarget.model})...`,
			);
			try {
				if (fastResponseTarget.provider === "cerebras") {
					return await helper.generateWithCerebras(
						openaiUserContent,
						openaiSystemPrompt,
						fastResponseTarget.model,
					);
				}

				return await helper.generateWithGroq(
					combinedMessages.groq,
					fastResponseTarget.model,
				);
			} catch (e: any) {
				console.warn(
					`[LLMHelper] Fast Response Mode failed on ${fastResponseTarget.provider}, falling back to standard routing:`,
					e.message,
				);
				// Fall through to standard routing
			}
		}

		if (helper.useOllama) {
			return await helper.callOllama(combinedMessages.gemini);
		}

		if (helper.activeCurlProvider) {
			const curlSystemPrompt = skipPromptForRequest
				? undefined
				: screenshotSystemPrompt || CUSTOM_SYSTEM_PROMPT;
			try {
				if (isMultimodal && imagePaths?.length) {
					const response = await helper.runWithScreenshotOcrFallback(
						`cURL Provider (${helper.activeCurlProvider.name})`,
						imagePaths,
						effectiveMessage,
						() =>
							helper.chatWithCurl(
								effectiveMessage,
								curlSystemPrompt,
								context || "",
								imagePaths,
							),
						(fallbackMessage) =>
							helper.chatWithCurl(
								fallbackMessage,
								curlSystemPrompt,
								context || "",
								[],
							),
					);
					if (response.trim().length > 0) {
						return response;
					}
				} else {
					const response = await helper.chatWithCurl(
						effectiveMessage,
						curlSystemPrompt,
						context || "",
						imagePaths,
					);
					if (response.trim().length > 0) {
						return response;
					}
				}
				console.warn(
					`[LLMHelper] cURL provider (${helper.activeCurlProvider.name}) returned no response. Falling back to standard routing.`,
				);
			} catch (error: any) {
				console.warn(
					`[LLMHelper] cURL provider (${helper.activeCurlProvider.name}) failed after ${CURL_PROVIDER_TIMEOUT_MS}ms timeout window. Falling back to standard routing:`,
					error.message,
				);
			}
			return await helper.runWithProviderFallbackBypass(() =>
				helper.chatWithGemini(
					message,
					originalImagePaths,
					originalContext,
					skipSystemPrompt,
					alternateGroqMessage,
				),
			);
		}

		if (helper.customProvider) {
			console.log(
				`[LLMHelper] Using Custom Provider: ${helper.customProvider.name}`,
			);
			// For non-streaming call — use rich CUSTOM prompts since custom providers can be cloud models
			const customSystemPrompt = skipPromptForRequest
				? ""
				: screenshotSystemPrompt || CUSTOM_SYSTEM_PROMPT;
			const response =
				isMultimodal && imagePaths?.length
					? await helper.runWithScreenshotOcrFallback(
							`Custom Provider (${helper.customProvider.name})`,
							imagePaths,
							effectiveMessage,
							() =>
								helper.executeCustomProvider(
									helper.customProvider!.curlCommand,
									combinedMessages.gemini,
									customSystemPrompt,
									effectiveMessage,
									context || "",
									imagePaths,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"custom",
									helper.getCurrentModel(),
									fallbackMessage,
									context,
								);
								const fallbackCombinedMessage = helper.joinPrompt(
									customSystemPrompt,
									fallbackUserContent,
									helper.getInputTokenBudget(
										"custom",
										helper.getCurrentModel(),
									),
								);
								return helper.executeCustomProvider(
									helper.customProvider!.curlCommand,
									fallbackCombinedMessage,
									customSystemPrompt,
									fallbackMessage,
									context || "",
									[],
								);
							},
						)
					: await helper.executeCustomProvider(
							helper.customProvider.curlCommand,
							combinedMessages.gemini,
							customSystemPrompt,
							effectiveMessage,
							context || "",
							imagePaths,
						);
			return helper.processResponse(response);
		}

		// --- Direct Routing based on Selected Model ---
		if (helper.isOpenAiModel(helper.currentModelId) && helper.openaiClient) {
			if (isMultimodal && imagePaths?.length) {
				return await helper.runWithScreenshotOcrFallback(
					`OpenAI (${activeOpenAiModel})`,
					imagePaths,
					effectiveMessage,
					() =>
						helper.generateWithOpenai(
							openaiUserContent,
							openaiSystemPrompt,
							imagePaths,
						),
					(fallbackMessage) => {
						const fallbackUserContent = helper.prepareUserContentForModel(
							"openai",
							activeOpenAiModel,
							fallbackMessage,
							context,
						);
						return helper.generateWithOpenai(
							fallbackUserContent,
							openaiSystemPrompt,
						);
					},
				);
			}
			return await helper.generateWithOpenai(
				openaiUserContent,
				openaiSystemPrompt,
				imagePaths,
			);
		}
		if (helper.isClaudeModel(helper.currentModelId) && helper.claudeClient) {
			const claudeModelId = helper.currentModelId;
			if (isMultimodal && imagePaths?.length) {
				return await helper.runWithScreenshotOcrFallback(
					`Claude (${claudeModelId})`,
					imagePaths,
					effectiveMessage,
					() =>
						helper.generateWithClaude(
							claudeUserContent,
							claudeSystemPrompt,
							imagePaths,
							claudeModelId,
						),
					(fallbackMessage) => {
						const fallbackUserContent = helper.prepareUserContentForModel(
							"claude",
							claudeModelId,
							fallbackMessage,
							context,
						);
						return helper.generateWithClaude(
							fallbackUserContent,
							claudeSystemPrompt,
							undefined,
							claudeModelId,
						);
					},
				);
			}
			return await helper.generateWithClaude(
				claudeUserContent,
				claudeSystemPrompt,
				imagePaths,
				claudeModelId,
			);
		}
		if (helper.isGroqModel(helper.currentModelId) && helper.groqClient) {
			if (isMultimodal && imagePaths) {
				return await helper.runWithScreenshotOcrFallback(
					"Groq multimodal",
					imagePaths,
					effectiveMessage,
					() =>
						helper.generateWithGroqMultimodal(
							openaiUserContent,
							imagePaths,
							openaiSystemPrompt,
						),
					(fallbackMessage) => {
						const fallbackUserContent = helper.prepareUserContentForModel(
							"groq",
							GROQ_MODEL,
							fallbackMessage,
							context,
						);
						return helper.generateWithGroq(
							helper.joinPrompt(
								finalGroqPrompt,
								fallbackUserContent,
								helper.getInputTokenBudget("groq", GROQ_MODEL),
							),
						);
					},
				);
			}
			return await helper.generateWithGroq(combinedMessages.groq);
		}

		// Fallback (Gemini) - logic handled below by SMART DYNAMIC FALLBACK list

		// ============================================================
		// SMART DYNAMIC FALLBACK (Non-Streaming)
		// Multimodal: Gemini Flash → OpenAI → Claude → Gemini Pro (Groq excluded)
		// Text-only:  Gemini Flash → Gemini Pro → Groq → OpenAI → Claude
		// OpenAI/Claude use proper system+user message separation
		// ============================================================
		type ProviderAttempt = { name: string; execute: () => Promise<string> };
		const providers: ProviderAttempt[] = [];

		// Get auto-discovered text model IDs from ModelVersionManager
		const textOpenAI = helper.modelVersionManager.getTextTieredModels(
			TextModelFamily.OPENAI,
		).tier1;
		const textGeminiFlash = helper.modelVersionManager.getTextTieredModels(
			TextModelFamily.GEMINI_FLASH,
		).tier1;
		const textGeminiPro = helper.modelVersionManager.getTextTieredModels(
			TextModelFamily.GEMINI_PRO,
		).tier1;
		const textClaude = helper.modelVersionManager.getTextTieredModels(
			TextModelFamily.CLAUDE,
		).tier1;
		const textGroq = helper.modelVersionManager.getTextTieredModels(
			TextModelFamily.GROQ,
		).tier1;

		if (isMultimodal) {
			// MULTIMODAL PROVIDER ORDER: OpenAI -> Gemini Flash -> Claude -> Gemini Pro -> Groq -> Custom/Ollama
			if (helper.openaiClient) {
				providers.push({
					name: `OpenAI (${textOpenAI})`,
					execute: () =>
						helper.runWithScreenshotOcrFallback(
							`OpenAI (${textOpenAI})`,
							imagePaths,
							effectiveMessage,
							() =>
								helper.generateWithOpenai(
									openaiUserContent,
									openaiSystemPrompt,
									imagePaths,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"openai",
									activeOpenAiModel,
									fallbackMessage,
									context,
								);
								return helper.generateWithOpenai(
									fallbackUserContent,
									openaiSystemPrompt,
								);
							},
						),
				});
			}
			if (helper.client) {
				providers.push({
					name: `Gemini Flash (${textGeminiFlash})`,
					execute: () =>
						helper.runWithScreenshotOcrFallback(
							`Gemini Flash (${textGeminiFlash})`,
							imagePaths,
							effectiveMessage,
							() =>
								helper.tryGenerateResponse(
									combinedMessages.gemini,
									imagePaths,
									textGeminiFlash,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"gemini",
									textGeminiFlash,
									fallbackMessage,
									context,
								);
								return helper.tryGenerateResponse(
									helper.joinPrompt(
										finalGeminiPrompt,
										fallbackUserContent,
										helper.getInputTokenBudget("gemini", textGeminiFlash),
									),
									undefined,
									textGeminiFlash,
								);
							},
						),
				});
			}
			if (helper.claudeClient) {
				providers.push({
					name: `Claude (${textClaude})`,
					execute: () =>
						helper.runWithScreenshotOcrFallback(
							`Claude (${textClaude})`,
							imagePaths,
							effectiveMessage,
							() =>
								helper.generateWithClaude(
									claudeUserContent,
									claudeSystemPrompt,
									imagePaths,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"claude",
									textClaude,
									fallbackMessage,
									context,
								);
								return helper.generateWithClaude(
									fallbackUserContent,
									claudeSystemPrompt,
								);
							},
						),
				});
			}
			if (helper.client) {
				providers.push({
					name: `Gemini Pro (${textGeminiPro})`,
					execute: () =>
						helper.runWithScreenshotOcrFallback(
							`Gemini Pro (${textGeminiPro})`,
							imagePaths,
							effectiveMessage,
							() =>
								helper.tryGenerateResponse(
									combinedMessages.gemini,
									imagePaths,
									textGeminiPro,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"gemini_pro",
									textGeminiPro,
									fallbackMessage,
									context,
								);
								return helper.tryGenerateResponse(
									helper.joinPrompt(
										finalGeminiPrompt,
										fallbackUserContent,
										helper.getInputTokenBudget("gemini_pro", textGeminiPro),
									),
									undefined,
									textGeminiPro,
								);
							},
						),
				});
			}
			if (helper.groqClient) {
				providers.push({
					name: `Groq (meta-llama/llama-4-scout-17b-16e-instruct)`,
					execute: () =>
						helper.runWithScreenshotOcrFallback(
							"Groq multimodal",
							imagePaths,
							effectiveMessage,
							() =>
								helper.generateWithGroqMultimodal(
									openaiUserContent,
									imagePaths!,
									openaiSystemPrompt,
								),
							(fallbackMessage) => {
								const fallbackUserContent = helper.prepareUserContentForModel(
									"groq",
									GROQ_MODEL,
									fallbackMessage,
									context,
								);
								return helper.generateWithGroq(
									helper.joinPrompt(
										finalGroqPrompt,
										fallbackUserContent,
										helper.getInputTokenBudget("groq", GROQ_MODEL),
									),
								);
							},
						),
				});
			}
		} else {
			// TEXT-ONLY: All providers including Groq
			if (helper.groqClient) {
				providers.push({
					name: `Groq (${textGroq})`,
					execute: () => helper.generateWithGroq(combinedMessages.groq),
				});
			}
			if (helper.client) {
				providers.push({
					name: `Gemini Flash (${textGeminiFlash})`,
					execute: () =>
						helper.tryGenerateResponse(
							combinedMessages.gemini,
							undefined,
							textGeminiFlash,
						),
				});
				providers.push({
					name: `Gemini Pro (${textGeminiPro})`,
					execute: () =>
						helper.tryGenerateResponse(
							combinedMessages.gemini,
							undefined,
							textGeminiPro,
						),
				});
			}
			if (helper.openaiClient) {
				providers.push({
					name: `OpenAI (${textOpenAI})`,
					execute: () =>
						helper.generateWithOpenai(openaiUserContent, openaiSystemPrompt),
				});
			}
			if (helper.claudeClient) {
				providers.push({
					name: `Claude (${textClaude})`,
					execute: () =>
						helper.generateWithClaude(claudeUserContent, claudeSystemPrompt),
				});
			}
		}

		if (providers.length === 0) {
			return "No AI providers configured. Please add at least one API key in Settings.";
		}

		// ============================================================
		// RELENTLESS RETRY: Try all providers, then retry entire chain
		// with exponential backoff. Max 2 full rotations.
		// ============================================================
		const MAX_FULL_ROTATIONS = 3;

		for (let rotation = 0; rotation < MAX_FULL_ROTATIONS; rotation++) {
			if (rotation > 0) {
				const backoffMs = 1000 * rotation;
				console.log(
					`[LLMHelper] 🔄 Non-streaming rotation ${rotation + 1}/${MAX_FULL_ROTATIONS} after ${backoffMs}ms backoff...`,
				);
				await helper.delay(backoffMs);
			}

			for (const provider of providers) {
				try {
					console.log(
						`[LLMHelper] ${rotation === 0 ? "🚀" : "🔁"} Attempting ${provider.name}...`,
					);
					const rawResponse = await provider.execute();
					if (rawResponse && rawResponse.trim().length > 0) {
						console.log(`[LLMHelper] ✅ ${provider.name} succeeded`);
						return helper.processResponse(rawResponse);
					}
					console.warn(
						`[LLMHelper] ⚠️ ${provider.name} returned empty response`,
					);
				} catch (error: any) {
					console.warn(
						`[LLMHelper] ⚠️ ${provider.name} failed: ${error.message}`,
					);
				}
			}
		}

		// All exhausted
		console.error("[LLMHelper] ❌ All non-streaming providers exhausted");
		return "I apologize, but I couldn't generate a response. Please try again.";
	} catch (error: any) {
		console.error(
			"[LLMHelper] Critical Error in chatWithGemini:",
			sanitizeError(error),
		);

		if (error.message.includes("503") || error.message.includes("overloaded")) {
			return "The AI service is currently overloaded. Please try again in a moment.";
		}
		if (error.message.includes("API key")) {
			return "Authentication failed. Please check your API key in settings.";
		}
		return `I encountered an error: ${error.message || "Unknown error"}. Please try again.`;
	}
}

export async function* streamChatWithGemini(
	helper: LLMHelper,
	message: string,
	imagePaths?: string[],
	context?: string,
	skipSystemPrompt: boolean = false,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	console.log(
		`[LLMHelper] streamChatWithGemini called with message:`,
		message.substring(0, 50),
	);
	const isMultimodal = !!imagePaths?.length;
	if (isMultimodal) {
		yield* helper.streamChat(
			message,
			imagePaths,
			context,
			skipSystemPrompt ? "" : undefined,
			{ abortSignal },
		);
		return;
	}

	const effectiveMessage = helper.applyDefaultBrevityHint(message);

	// Build single-string messages for Groq/Gemini (which use combined prompts)
	const buildCombinedMessage = (systemPrompt: string) => {
		const finalPrompt = skipSystemPrompt
			? systemPrompt
			: helper.injectLanguageInstruction(systemPrompt);
		if (skipSystemPrompt) {
			return context
				? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${effectiveMessage}`
				: effectiveMessage;
		}
		return context
			? `${finalPrompt}\n\nCONTEXT:\n${context}\n\nUSER QUESTION:\n${effectiveMessage}`
			: `${finalPrompt}\n\n${effectiveMessage}`;
	};

	// For OpenAI/Claude: separate system prompt + user message (proper API pattern)
	const userContent = helper.prepareUserContent(effectiveMessage, context);

	const combinedMessages = {
		gemini: buildCombinedMessage(HARD_SYSTEM_PROMPT),
		groq: buildCombinedMessage(GROQ_SYSTEM_PROMPT),
	};

	if (helper.useOllama) {
		const response = await helper.callOllama(combinedMessages.gemini);
		yield response;
		return;
	}

	// ============================================================
	// SMART DYNAMIC FALLBACK: Build provider list using auto-discovered
	// text models from ModelVersionManager.
	// Multimodal requests EXCLUDE Groq (no vision support)
	// Text-only requests can use ALL providers
	// OpenAI/Claude use proper system+user message separation for quality
	// ============================================================
	type ProviderAttempt = {
		name: string;
		execute: () => AsyncGenerator<string, void, unknown>;
	};
	const providers: ProviderAttempt[] = [];

	// System prompts for OpenAI/Claude (skipped if skipSystemPrompt)
	const openaiSystemPrompt = skipSystemPrompt
		? undefined
		: helper.injectLanguageInstruction(OPENAI_SYSTEM_PROMPT);
	const claudeSystemPrompt = skipSystemPrompt
		? undefined
		: helper.injectLanguageInstruction(CLAUDE_SYSTEM_PROMPT);

	// Get auto-discovered text model IDs from ModelVersionManager
	const textOpenAI = helper.modelVersionManager.getTextTieredModels(
		TextModelFamily.OPENAI,
	).tier1;
	const textGeminiFlash = helper.modelVersionManager.getTextTieredModels(
		TextModelFamily.GEMINI_FLASH,
	).tier1;
	const textGeminiPro = helper.modelVersionManager.getTextTieredModels(
		TextModelFamily.GEMINI_PRO,
	).tier1;
	const textClaude = helper.modelVersionManager.getTextTieredModels(
		TextModelFamily.CLAUDE,
	).tier1;
	const textGroq = helper.modelVersionManager.getTextTieredModels(
		TextModelFamily.GROQ,
	).tier1;

	if (isMultimodal) {
		// MULTIMODAL PROVIDER ORDER: OpenAI -> Gemini Flash -> Claude -> Gemini Pro -> Groq Scout 4
		if (helper.openaiClient) {
			providers.push({
				name: `OpenAI (${textOpenAI})`,
				execute: () =>
					helper.streamWithOpenaiMultimodal(
						userContent,
						imagePaths!,
						openaiSystemPrompt,
					),
			});
		}
		if (helper.client) {
			providers.push({
				name: `Gemini Flash (${textGeminiFlash})`,
				execute: () =>
					helper.streamWithGeminiModel(
						combinedMessages.gemini,
						textGeminiFlash,
						imagePaths,
						abortSignal,
					),
			});
		}
		if (helper.claudeClient) {
			providers.push({
				name: `Claude (${textClaude})`,
				execute: () =>
					helper.streamWithClaudeMultimodal(
						userContent,
						imagePaths!,
						claudeSystemPrompt,
					),
			});
		}
		if (helper.client) {
			providers.push({
				name: `Gemini Pro (${textGeminiPro})`,
				execute: () =>
					helper.streamWithGeminiModel(
						combinedMessages.gemini,
						textGeminiPro,
						imagePaths,
						abortSignal,
					),
			});
		}
		if (helper.groqClient) {
			providers.push({
				name: `Groq (meta-llama/llama-4-scout-17b-16e-instruct)`,
				execute: () =>
					helper.streamWithGroqMultimodal(
						userContent,
						imagePaths!,
						openaiSystemPrompt,
					),
			});
		}
	} else {
		// TEXT-ONLY PROVIDER ORDER: Groq → OpenAI → Claude → Gemini Flash → Gemini Pro
		if (helper.groqClient) {
			providers.push({
				name: `Groq (${textGroq})`,
				execute: () => helper.streamWithGroq(combinedMessages.groq),
			});
		}
		if (helper.openaiClient) {
			providers.push({
				name: `OpenAI (${textOpenAI})`,
				execute: () => helper.streamWithOpenai(userContent, openaiSystemPrompt),
			});
		}
		if (helper.claudeClient) {
			providers.push({
				name: `Claude (${textClaude})`,
				execute: () => helper.streamWithClaude(userContent, claudeSystemPrompt),
			});
		}
		if (helper.client) {
			providers.push({
				name: `Gemini Flash (${textGeminiFlash})`,
				execute: () =>
					helper.streamWithGeminiModel(
						combinedMessages.gemini,
						textGeminiFlash,
						undefined,
						abortSignal,
					),
			});
			providers.push({
				name: `Gemini Pro (${textGeminiPro})`,
				execute: () =>
					helper.streamWithGeminiModel(
						combinedMessages.gemini,
						textGeminiPro,
						undefined,
						abortSignal,
					),
			});
		}
	}

	if (providers.length === 0) {
		yield "No AI providers configured. Please add at least one API key in Settings.";
		return;
	}

	// ============================================================
	// RELENTLESS RETRY: Try all providers, then retry entire chain
	// with exponential backoff. Max 1 full rotation.
	// ============================================================
	const MAX_FULL_ROTATIONS = 1;

	for (let rotation = 0; rotation < MAX_FULL_ROTATIONS; rotation++) {
		if (abortSignal?.aborted) {
			console.log("[LLMHelper] streamChatWithGemini aborted by signal");
			return;
		}
		if (rotation > 0) {
			const backoffMs = 1000 * rotation;
			console.log(
				`[LLMHelper] 🔄 Starting rotation ${rotation + 1}/${MAX_FULL_ROTATIONS} after ${backoffMs}ms backoff...`,
			);
			await helper.delay(backoffMs);
		}

		for (let i = 0; i < providers.length; i++) {
			if (abortSignal?.aborted) {
				console.log("[LLMHelper] streamChatWithGemini aborted by signal");
				return;
			}
			const provider = providers[i];
			let yieldedAny = false;
			try {
				console.log(
					`[LLMHelper] ${rotation === 0 ? "🚀" : "🔁"} Attempting ${provider.name}...`,
				);
				const stream = provider.execute();
				for await (const chunk of stream) {
					yieldedAny = true;
					yield chunk;
				}
				console.log(
					`[LLMHelper] ✅ ${provider.name} stream completed successfully`,
				);
				return; // SUCCESS — exit immediately
			} catch (err: any) {
				if (yieldedAny) {
					// Provider yielded tokens then failed - rethrow to avoid concatenation
					console.error(
						`[LLMHelper] ❌ ${provider.name} failed after yielding tokens: ${err.message}`,
					);
					throw err;
				}
				console.warn(
					`[LLMHelper] ⚠️ ${provider.name} failed without yielding tokens: ${err.message}`,
				);
				// Continue to next provider
			}
		}
	}

	// Truly exhausted after all rotations
	console.error(
		`[LLMHelper] ❌ All providers exhausted after ${MAX_FULL_ROTATIONS} rotations`,
	);
	yield "All AI services are currently unavailable. Please check your API keys and try again.";
}

export async function* streamWithGeminiModel(
	helper: LLMHelper,
	fullMessage: string,
	model: string,
	imagePaths?: string[],
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.client) throw new Error("Gemini client not initialized");

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

	// Create abort controller for timeout/cancellation
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), LLM_API_TIMEOUT_MS);

	// Wire up external abort signal if provided
	const abortHandler = () => controller.abort(abortSignal?.reason);
	if (abortSignal) {
		abortSignal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const streamResult = await helper.client.models.generateContentStream({
			model: model,
			contents: contents,
			config: {
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.4,
			},
		});

		// @ts-expect-error
		const stream = streamResult.stream || streamResult;

		for await (const chunk of stream) {
			if (controller.signal.aborted) {
				console.log("[LLMHelper] streamWithGeminiModel aborted");
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
		clearTimeout(timeoutId);
		if (abortSignal) {
			abortSignal.removeEventListener("abort", abortHandler);
		}
	}
}

/**
 * Race Flash and Pro streams, return whichever succeeds first
 */
export async function* streamWithGeminiParallelRace(
	helper: LLMHelper,
	fullMessage: string,
	imagePaths?: string[],
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.client) throw new Error("Gemini client not initialized");

	const streams = {
		flash: helper
			.streamGeminiModelChunks(
				fullMessage,
				GEMINI_FLASH_MODEL,
				imagePaths,
				abortSignal,
			)
			[Symbol.asyncIterator](),
		pro: helper
			.streamGeminiModelChunks(
				fullMessage,
				GEMINI_PRO_MODEL,
				imagePaths,
				abortSignal,
			)
			[Symbol.asyncIterator](),
	} as const;

	const nextChunk = (name: keyof typeof streams) =>
		streams[name].next().then((result) => ({ name, result }));

	let winner: keyof typeof streams | null = null;
	const pending = new Map<
		keyof typeof streams,
		Promise<{ name: keyof typeof streams; result: IteratorResult<string> }>
	>();
	pending.set("flash", nextChunk("flash"));
	pending.set("pro", nextChunk("pro"));

	while (pending.size > 0) {
		const { name, result } = await Promise.race(Array.from(pending.values()));
		pending.delete(name);

		if (result.done) {
			if (winner === name) {
				return;
			}
			if (pending.size === 0 && winner === null) {
				throw new Error("Both Gemini race streams completed without output");
			}
			continue;
		}

		if (!winner) {
			winner = name;
			const loser = name === "flash" ? "pro" : "flash";
			pending.delete(loser);
			await streams[loser].return?.(undefined);
			console.log(`[LLMHelper] Gemini race winner: ${winner}`);
		}

		if (name === winner) {
			yield result.value;
			pending.set(name, nextChunk(name));
		}
	}
}
