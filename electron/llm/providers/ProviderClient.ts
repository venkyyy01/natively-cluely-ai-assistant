/**
 * NAT-064 — Unified ProviderClient interface.
 *
 * One contract for all LLM providers:
 *   stream(request, signal) → AsyncIterable<Token | ErrorEvent>
 *
 * Retry, timeout, and backoff live in a single wrapper.
 * No provider yields raw error strings.
 */

export interface Token {
	kind: "token";
	text: string;
}

export interface ErrorEvent {
	kind: "error";
	code: string;
	message: string;
	retryable: boolean;
}

export type StreamEvent = Token | ErrorEvent;

export interface ProviderRequest {
	message: string;
	systemPrompt?: string;
	imagePaths?: string[];
	model?: string;
	temperature?: number;
}

export interface ProviderClient {
	readonly name: string;
	stream(
		request: ProviderRequest,
		signal?: AbortSignal,
	): AsyncIterable<StreamEvent>;
}

export interface RetryPolicy {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 3,
	baseDelayMs: 500,
	maxDelayMs: 8000,
	timeoutMs: 30000,
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(event: ErrorEvent): boolean {
	return event.retryable;
}

/**
 * Wraps a ProviderClient with retry, timeout, and exponential backoff.
 */
export function withRetryAndTimeout(
	client: ProviderClient,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): ProviderClient {
	return {
		name: `${client.name}:retry`,
		async *stream(
			request: ProviderRequest,
			signal?: AbortSignal,
		): AsyncIterable<StreamEvent> {
			let attempt = 0;

			while (true) {
				if (signal?.aborted) return;

				const timeoutController = new AbortController();
				const timeoutTimer = setTimeout(
					() => timeoutController.abort(),
					policy.timeoutMs,
				);

				let sawFatalError = false;
				try {
					for await (const event of client.stream(
						request,
						timeoutController.signal,
					)) {
						if (event.kind === "error") {
							if (isRetryableError(event) && attempt < policy.maxRetries) {
								clearTimeout(timeoutTimer);
								break; // retry
							}
							if (!isRetryableError(event)) {
								sawFatalError = true;
							}
						}
						yield event;
						if (event.kind === "token") {
							clearTimeout(timeoutTimer);
							return; // success
						}
					}
				} catch (err: any) {
					clearTimeout(timeoutTimer);
					if (attempt >= policy.maxRetries) {
						yield {
							kind: "error",
							code: "max_retries_exceeded",
							message: err?.message || "Provider failed after max retries",
							retryable: false,
						};
						return;
					}
				}

				clearTimeout(timeoutTimer);
				if (sawFatalError) return;
				attempt += 1;
				if (attempt > policy.maxRetries) {
					yield {
						kind: "error",
						code: "max_retries_exceeded",
						message: `Provider ${client.name} failed after ${policy.maxRetries} retries`,
						retryable: false,
					};
					return;
				}

				const backoff = Math.min(
					policy.baseDelayMs * 2 ** (attempt - 1),
					policy.maxDelayMs,
				);
				await delay(backoff);
			}
		},
	};
}

/** Stub implementations for each provider. Real migration happens in NAT-065. */

export function createGeminiClient(_apiKey: string): ProviderClient {
	return {
		name: "gemini",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "Gemini client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}

export function createAnthropicClient(_apiKey: string): ProviderClient {
	return {
		name: "anthropic",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "Anthropic client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}

export function createOpenAIClient(_apiKey: string): ProviderClient {
	return {
		name: "openai",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "OpenAI client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}

export function createGroqClient(_apiKey: string): ProviderClient {
	return {
		name: "groq",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "Groq client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}

export function createCerebrasClient(_apiKey: string): ProviderClient {
	return {
		name: "cerebras",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "Cerebras client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}

export function createOllamaClient(_baseUrl: string): ProviderClient {
	return {
		name: "ollama",
		async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
			yield {
				kind: "error",
				code: "not_implemented",
				message: "Ollama client not yet migrated",
				retryable: false,
			} as ErrorEvent;
		},
	};
}
