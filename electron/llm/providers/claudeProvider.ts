import fs from "node:fs";
import {
	CLAUDE_MAX_OUTPUT_TOKENS,
	CLAUDE_MODEL,
	createRequestAbortController,
	LLM_API_TIMEOUT_MS,
	type LLMHelper,
} from "../../LLMHelper";

/**
 * Stream response from Claude with proper system/user message separation
 */
export async function* streamWithClaude(
	helper: LLMHelper,
	userMessage: string,
	systemPrompt?: string,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.claudeClient) throw new Error("Claude client not initialized");

	const requestControl = createRequestAbortController(
		LLM_API_TIMEOUT_MS,
		abortSignal,
	);

	const stream = await helper.claudeClient.messages.stream(
		{
			model: CLAUDE_MODEL,
			max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
			...(systemPrompt ? { system: systemPrompt } : {}),
			messages: [{ role: "user", content: userMessage }],
		},
		{ signal: requestControl.signal },
	);

	try {
		for await (const event of stream) {
			if (requestControl.signal.aborted) {
				return;
			}
			if (
				event.type === "content_block_delta" &&
				event.delta.type === "text_delta"
			) {
				yield event.delta.text;
			}
		}
	} finally {
		requestControl.cleanup();
	}
}

/**
 * Stream multimodal (image + text) response from Claude with system/user separation
 */
export async function* streamWithClaudeMultimodal(
	helper: LLMHelper,
	userMessage: string,
	imagePaths: string[],
	systemPrompt?: string,
	abortSignal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	if (!helper.claudeClient) throw new Error("Claude client not initialized");

	const imageContentParts: any[] = [];
	for (const p of imagePaths) {
		if (fs.existsSync(p)) {
			const imageData = await fs.promises.readFile(p);
			imageContentParts.push({
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: imageData.toString("base64"),
				},
			});
		}
	}

	const requestControl = createRequestAbortController(
		LLM_API_TIMEOUT_MS,
		abortSignal,
	);

	const stream = await helper.claudeClient.messages.stream(
		{
			model: CLAUDE_MODEL,
			max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
			...(systemPrompt ? { system: systemPrompt } : {}),
			messages: [
				{
					role: "user",
					content: [...imageContentParts, { type: "text", text: userMessage }],
				},
			],
		},
		{ signal: requestControl.signal },
	);

	try {
		for await (const event of stream) {
			if (requestControl.signal.aborted) {
				return;
			}
			if (
				event.type === "content_block_delta" &&
				event.delta.type === "text_delta"
			) {
				yield event.delta.text;
			}
		}
	} finally {
		requestControl.cleanup();
	}
}
