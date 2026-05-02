import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import { Metrics } from "../runtime/Metrics";
import type { HandlerContext } from "./handlerContext";

export type GeminiStreamIpcDeps = Pick<
	HandlerContext,
	| "safeHandle"
	| "safeHandleValidated"
	| "getInferenceLlmHelper"
	| "getIntelligenceManager"
	| "activeChatControllers"
	| "streamChatStartedAt"
	| "appState"
>;

export function registerGeminiStreamIpcHandlers(
	deps: GeminiStreamIpcDeps,
): void {
	const {
		safeHandle,
		safeHandleValidated,
		getInferenceLlmHelper,
		getIntelligenceManager,
		activeChatControllers,
		streamChatStartedAt,
		appState,
	} = deps;

	const assertNotContained = (): void => {
		if (
			typeof appState.isStealthContainmentActive === "function" &&
			appState.isStealthContainmentActive()
		) {
			throw new Error("CONTAINMENT_ACTIVE");
		}
	};

	safeHandleValidated(
		"gemini-chat",
		(args) => parseIpcInput(ipcSchemas.geminiChatArgs, args, "gemini-chat"),
		async (_event, message, imagePaths, context, options) => {
			assertNotContained();
			const result = await getInferenceLlmHelper().chatWithGemini(
				message,
				imagePaths,
				context,
				options?.skipSystemPrompt,
			);
			assertNotContained();

			console.log(
				`[IPC] gemini - chat response: `,
				result ? result.substring(0, 50) : "(empty)",
			);

			// Don't process empty responses
			if (!result || result.trim().length === 0) {
				console.warn(
					"[IPC] Empty response from LLM, not updating IntelligenceManager",
				);
				return "I apologize, but I couldn't generate a response. Please try again.";
			}

			// Sync with IntelligenceManager so Follow-Up/Recap work
			const intelligenceManager = getIntelligenceManager();

			// 1. Add user question to context (as 'user')
			// CRITICAL: Skip refinement check to prevent auto-triggering follow-up logic
			// The user's manual question is a NEW input, not a refinement of previous answer.
			intelligenceManager.addTranscript(
				{
					text: message,
					speaker: "user",
					timestamp: Date.now(),
					final: true,
				},
				true,
			);

			// 2. Add assistant response and set as last message
			console.log(
				`[IPC] Updating IntelligenceManager with assistant message...`,
			);
			intelligenceManager.addAssistantMessage(result);
			console.log(
				`[IPC] Updated IntelligenceManager.Last message: `,
				intelligenceManager.getLastAssistantMessage()?.substring(0, 50),
			);

			// Log Usage
			intelligenceManager.logUsage("chat", message, result, {
				model: getInferenceLlmHelper().getCurrentModel?.() ?? "unknown",
				hasImages: !!imagePaths?.length,
				consciousMode: intelligenceManager.isConsciousModeEnabled?.() ?? false,
			});

			return result;
		},
	);

	// Streaming IPC Handler
	safeHandleValidated(
		"gemini-chat-stream",
		(args) =>
			parseIpcInput(ipcSchemas.geminiChatArgs, args, "gemini-chat-stream"),
		async (event, message, imagePaths, context, options) => {
			const requestId = options?.requestId;
			assertNotContained();
			if (!requestId) {
				throw new Error("gemini-chat-stream requires requestId in options");
			}

			// Clean up any previous controller for this requestId (shouldn't happen, but be safe)
			const previousController = activeChatControllers.get(requestId);
			if (previousController) {
				previousController.abort();
				activeChatControllers.delete(requestId);
			}

			const controller = new AbortController();
			activeChatControllers.set(requestId, controller);
			streamChatStartedAt.set(requestId, Date.now());

			const llmHelper = getInferenceLlmHelper();
			const intelligenceManager = getIntelligenceManager();

			try {
				console.log(
					"[IPC] gemini-chat-stream started using LLMHelper.streamChat",
				);

				// Update IntelligenceManager with USER message immediately
				intelligenceManager.addTranscript(
					{
						text: message,
						speaker: "user",
						timestamp: Date.now(),
						final: true,
					},
					true,
				);

				let fullResponse = "";

				// Context Injection for "Answer" button (100s rolling window)
				if (!context) {
					// User requested 100 seconds of context for the answer button
					// Logic: If no explicit context provided (like from manual override), auto-inject from IntelligenceManager
					try {
						const autoContext = intelligenceManager.getFormattedContext(100);
						if (autoContext && autoContext.trim().length > 0) {
							context = autoContext;
							console.log(
								`[IPC] Auto - injected 100s context for gemini - chat - stream(${context.length} chars)`,
							);
						}
					} catch (ctxErr) {
						console.warn("[IPC] Failed to auto-inject context:", ctxErr);
					}
				}

				try {
					// USE streamChat which handles routing
					const stream = llmHelper.streamChat(
						message,
						imagePaths,
						context,
						options?.skipSystemPrompt ? "" : undefined,
						{
							abortSignal: controller.signal,
							qualityTier: options?.qualityTier,
						},
					);

					// NAT-019 / audit R-7: micro-batch tokens before crossing the IPC
					// boundary. The previous implementation issued one IPC send per
					// token, so a fast provider (Groq, Cerebras) could push 200+ IPC
					// messages/sec, flooding the renderer event loop and producing
					// user-visible jank during streaming.
					//
					// Flush rule: every BATCH_FLUSH_INTERVAL_MS or every
					// BATCH_FLUSH_MAX_TOKENS tokens, whichever comes first. The cap
					// comes from the audit's acceptance criterion of <= 64 IPC
					// sends/second (1000 / 16 ms = 62.5).
					//
					// Destroyed-sender guard: every flush checks
					// `event.sender.isDestroyed()` first so a renderer crash or
					// navigation no longer turns into "Object has been destroyed"
					// exceptions surfacing in logs and aborting the stream consumer.
					const BATCH_FLUSH_INTERVAL_MS = 16;
					const BATCH_FLUSH_MAX_TOKENS = 32;
					let pending = "";
					let pendingTokenCount = 0;
					let lastFlushAt = Date.now();
					let aborted = false;

					const flush = (): boolean => {
						if (pending.length === 0) return true;
						if (
							typeof appState.isStealthContainmentActive === "function" &&
							appState.isStealthContainmentActive()
						) {
							aborted = true;
							return false;
						}
						if (event.sender.isDestroyed()) {
							aborted = true;
							return false;
						}
						event.sender.send(`gemini-stream-token:${requestId}`, pending);
						pending = "";
						pendingTokenCount = 0;
						lastFlushAt = Date.now();
						return true;
					};

					for await (const token of stream) {
						if (
							event.sender.isDestroyed() ||
							controller.signal.aborted ||
							(typeof appState.isStealthContainmentActive === "function" &&
								appState.isStealthContainmentActive())
						) {
							aborted = true;
							if (event.sender.isDestroyed()) {
								console.warn(
									"[IPC] gemini-chat-stream: sender destroyed mid-stream; aborting",
								);
							} else {
								console.log("[IPC] gemini-chat-stream: aborted by client");
							}
							break;
						}
						pending += token;
						pendingTokenCount += 1;
						fullResponse += token;
						const elapsed = Date.now() - lastFlushAt;
						if (
							pendingTokenCount >= BATCH_FLUSH_MAX_TOKENS ||
							elapsed >= BATCH_FLUSH_INTERVAL_MS
						) {
							if (!flush()) break;
						}
					}

					if (!aborted) {
						flush();
						if (!event.sender.isDestroyed()) {
							event.sender.send(`gemini-stream-final:${requestId}`);
						}
					}

					// Update IntelligenceManager with ASSISTANT message after completion
					const cleanedResponse = fullResponse
						.replace(/^data: \{.*\}$/gm, "")
						.replace(/\n{3,}/g, "\n\n")
						.trim();
					if (cleanedResponse.length > 0) {
						intelligenceManager.addAssistantMessage(cleanedResponse);
						intelligenceManager.logUsage("chat", message, cleanedResponse, {
							model: llmHelper.getCurrentModel?.() ?? "unknown",
							hasImages: !!imagePaths?.length,
							streamDurationMs:
								Date.now() - (streamChatStartedAt.get(requestId) ?? Date.now()),
							consciousMode:
								intelligenceManager.isConsciousModeEnabled?.() ?? false,
						});
					} else {
						console.error(
							`[IPC] gemini-chat-stream: empty response for request ${requestId} (${imagePaths?.length ?? 0} images)`,
						);
						intelligenceManager.logUsage(
							"chat",
							message,
							"[no response — all providers failed]",
							{
								model: llmHelper.getCurrentModel?.() ?? "unknown",
								hasImages: !!imagePaths?.length,
								failed: true,
								streamDurationMs:
									Date.now() -
									(streamChatStartedAt.get(requestId) ?? Date.now()),
							},
						);
						if (!event.sender.isDestroyed()) {
							event.sender.send(
								`gemini-stream-error:${requestId}`,
								"Could not generate a response. No AI provider was able to process the request.",
							);
						}
					}
				} catch (streamError: any) {
					console.error("[IPC] Streaming error:", streamError);
					const errorMsg = streamError.message || "Unknown streaming error";
					try {
						intelligenceManager.logUsage(
							"chat",
							message,
							`[stream error: ${errorMsg}]`,
							{
								model: llmHelper.getCurrentModel?.() ?? "unknown",
								hasImages: !!imagePaths?.length,
								failed: true,
								streamDurationMs:
									Date.now() -
									(streamChatStartedAt.get(requestId) ?? Date.now()),
							},
						);
					} catch (_) {
						/* best-effort logging */
					}
					if (!event.sender.isDestroyed()) {
						event.sender.send(`gemini-stream-error:${requestId}`, errorMsg);
					}
				}

				return null; // Return null as data is sent via events
			} catch (error: any) {
				console.error("[IPC] Error in gemini-chat-stream setup:", error);
				try {
					intelligenceManager.logUsage(
						"chat",
						message,
						`[setup error: ${error.message}]`,
						{
							model: llmHelper.getCurrentModel?.() ?? "unknown",
							hasImages: !!imagePaths?.length,
							failed: true,
						},
					);
				} catch (_) {
					/* best-effort */
				}
				throw error;
			} finally {
				activeChatControllers.delete(requestId);
				streamChatStartedAt.delete(requestId);
			}
		},
	);

	safeHandle("gemini-chat-cancel", (_event, requestId: string) => {
		const controller = activeChatControllers.get(requestId);
		if (controller) {
			const started = streamChatStartedAt.get(requestId);
			if (started !== undefined) {
				Metrics.gauge("stream.cancel_latency_ms", Date.now() - started);
				streamChatStartedAt.delete(requestId);
			}
			controller.abort();
			activeChatControllers.delete(requestId);
			console.log(`[IPC] gemini-chat-cancel: aborted request ${requestId}`);
		}
	});

	safeHandle("metrics:get", () => {
		const snapshot = Metrics.getSnapshot();
		console.log("[metrics] snapshot", JSON.stringify(snapshot));
		return snapshot;
	});
}
