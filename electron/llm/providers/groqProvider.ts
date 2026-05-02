import fs from "fs";
import {
	createRequestAbortController,
	GROQ_MODEL,
	LLM_API_TIMEOUT_MS,
	type LLMHelper,
	withTimeout,
} from "../../LLMHelper";

export async function* streamWithGroq(
	helper: LLMHelper,
	fullMessage: string,
	modelOverride: string = GROQ_MODEL,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.groqClient) throw new Error("Groq client not initialized");

	await helper.rateLimiters.groq.acquire();

	const requestControl = createRequestAbortController(
		LLM_API_TIMEOUT_MS,
		abortSignal,
	);
	const targetModel = modelOverride || GROQ_MODEL;

	const stream = await helper.groqClient.chat.completions.create(
		{
			model: targetModel,
			messages: [{ role: "user", content: fullMessage }],
			stream: true,
			temperature: 0.4,
			max_tokens: 8192,
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

/**
 * Stream multimodal (image + text) response from Groq using Llama 4 Scout as a last resort
 */
export async function* streamWithGroqMultimodal(
	helper: LLMHelper,
	userMessage: string,
	imagePaths: string[],
	systemPrompt?: string,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.groqClient) throw new Error("Groq client not initialized");

	await helper.rateLimiters.groq.acquire();

	const messages: any[] = [];
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}

	const contentParts: any[] = [{ type: "text", text: userMessage }];
	for (const p of imagePaths) {
		if (fs.existsSync(p)) {
			// Groq requires base64 URL format for images, similar to OpenAI
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

	const requestControl = createRequestAbortController(
		LLM_API_TIMEOUT_MS,
		abortSignal,
	);

	const stream = await helper.groqClient.chat.completions.create(
		{
			model: "meta-llama/llama-4-scout-17b-16e-instruct",
			messages,
			stream: true,
			max_tokens: 8192,
			temperature: 1,
			top_p: 1,
			stop: null,
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

export async function generateWithGroq(
	helper: LLMHelper,
	fullMessage: string,
	modelOverride: string = GROQ_MODEL,
): Promise<string> {
	if (!helper.groqClient) throw new Error("Groq client not initialized");

	await helper.rateLimiters.groq.acquire();
	const targetModel = modelOverride || GROQ_MODEL;
	const payloadHash = helper.hashValue({ model: targetModel, fullMessage });

	return helper.withResponseCache(
		"groq",
		targetModel,
		"",
		payloadHash,
		async () => {
			const requestPayload = await helper.withFinalPayloadCache(
				"groq",
				targetModel,
				"",
				payloadHash,
				() => ({
					model: targetModel,
					messages: [{ role: "user", content: fullMessage }],
					temperature: 0.4,
					max_tokens: 8192,
					stream: false,
				}),
			);

			const response = await withTimeout(
				helper.groqClient!.chat.completions.create(requestPayload as any),
				LLM_API_TIMEOUT_MS,
			);
			return response.choices[0]?.message?.content || "";
		},
	);
}
