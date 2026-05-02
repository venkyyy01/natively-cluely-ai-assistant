import {
	createRequestAbortController,
	LLM_API_TIMEOUT_MS,
	type LLMHelper,
	MAX_OUTPUT_TOKENS,
	withTimeout,
} from "../../LLMHelper";

export async function* streamWithCerebras(
	helper: LLMHelper,
	userMessage: string,
	systemPrompt?: string,
	modelOverride?: string,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.cerebrasClient)
		throw new Error("Cerebras client not initialized");

	const targetModel =
		modelOverride || helper.getConfiguredFastModel("cerebras");
	const messages: any[] = [];
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}
	messages.push({ role: "user", content: userMessage });

	await helper.rateLimiters.cerebras.acquire();

	const requestControl = createRequestAbortController(
		LLM_API_TIMEOUT_MS,
		abortSignal,
	);
	const stream = await helper.cerebrasClient.chat.completions.create(
		{
			model: targetModel,
			messages,
			stream: true,
			max_completion_tokens: MAX_OUTPUT_TOKENS,
		},
		{ signal: requestControl.signal },
	);

	try {
		for await (const chunk of stream) {
			if (abortSignal?.aborted) {
				return;
			}
			const content = chunk.choices[0]?.delta?.content;
			if (content) {
				yield content;
			}
		}
	} finally {
		requestControl.cleanup();
	}
}

export async function generateWithCerebras(
	helper: LLMHelper,
	userMessage: string,
	systemPrompt?: string,
	modelOverride?: string,
): Promise<string> {
	if (!helper.cerebrasClient)
		throw new Error("Cerebras client not initialized");

	const targetModel =
		modelOverride || helper.getConfiguredFastModel("cerebras");

	await helper.rateLimiters.cerebras.acquire();
	const systemPromptHash = helper.hashValue(systemPrompt || "");
	const payloadHash = helper.hashValue({
		model: targetModel,
		userMessage,
		systemPrompt: systemPrompt || "",
	});

	return helper.withResponseCache(
		"cerebras",
		targetModel,
		systemPromptHash,
		payloadHash,
		async () => {
			const requestPayload = await helper.withFinalPayloadCache(
				"cerebras",
				targetModel,
				systemPromptHash,
				payloadHash,
				() => {
					const messages: any[] = [];
					if (systemPrompt) {
						messages.push({ role: "system", content: systemPrompt });
					}
					messages.push({ role: "user", content: userMessage });

					return {
						model: targetModel,
						messages,
						max_completion_tokens: MAX_OUTPUT_TOKENS,
					};
				},
			);

			const response = await withTimeout(
				helper.cerebrasClient!.chat.completions.create(requestPayload as any),
				LLM_API_TIMEOUT_MS,
			);
			return response.choices[0]?.message?.content || "";
		},
	);
}
