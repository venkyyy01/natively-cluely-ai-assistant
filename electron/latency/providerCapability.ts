export type ProviderCapabilityClass =
	| "streaming"
	| "buffered"
	| "non_streaming";

export function classifyProviderCapability(input: {
	useOllama?: boolean;
	activeCurlProvider?: boolean;
	isOpenAiModel?: boolean;
	isClaudeModel?: boolean;
	isGroqModel?: boolean;
	isGeminiModel?: boolean;
}): ProviderCapabilityClass {
	if (input.activeCurlProvider) {
		return "non_streaming";
	}

	if (input.useOllama) {
		return "buffered";
	}

	if (
		input.isOpenAiModel ||
		input.isClaudeModel ||
		input.isGroqModel ||
		input.isGeminiModel
	) {
		return "streaming";
	}

	return "buffered";
}
