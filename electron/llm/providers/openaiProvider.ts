import { LLMHelper } from '../../LLMHelper';
import { createRequestAbortController, LLM_API_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from '../../LLMHelper';
import fs from 'fs';
import { buildPromptCacheKey, logOpenAiCacheUsage, type OpenAiCacheUsage } from './cacheTelemetry';

/**
 * NAT-ACCURACY: temperature for primary answer generation. Low enough to
 * reduce hallucination and keep factual claims grounded; high enough to
 * sound natural and conversational (not robotic). 0.4 is the sweet spot
 * validated by the conscious-mode eval harness.
 */
const OPENAI_ANSWER_TEMPERATURE = 0.4;

/**
 * NAT-CACHE-AUDIT: capture the final usage chunk from a streaming Chat
 * Completions response. OpenAI only emits `usage` in the terminal stream
 * event, and only when `stream_options: { include_usage: true }` is set on
 * the request. This helper centralises the extraction and logging so every
 * streaming entry point reports cache hit rates uniformly.
 */
function extractUsageFromChunk(chunk: any): OpenAiCacheUsage | null {
  const usage = chunk?.usage;
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

/**
 * Stream response from OpenAI with proper system/user message separation
 */
export async function* streamWithOpenai(
  helper: LLMHelper,
  userMessage: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const targetModel = helper.getActiveOpenAiModel();

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  // NAT-CACHE-AUDIT: include_usage surfaces the final usage chunk so we can
  // observe cache hit rates. Stable prompt_cache_key derived from the system
  // prompt fingerprint keeps cache routing consistent across requests with
  // the same prefix (per OpenAI prompt-caching docs §Cache Routing).
  const promptCacheKey = buildPromptCacheKey(systemPrompt);

  let stream;
  try {
    stream = await helper.openaiClient.chat.completions.create({
      model: targetModel,
      messages,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: OPENAI_ANSWER_TEMPERATURE,
      stream_options: { include_usage: true },
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    }, { signal: requestControl.signal });
  } catch (error) {
    if (helper.isModelNotFoundError(error)) {
      const fallbackModel = await helper.resolveOpenAiFallbackModel(targetModel);
      if (fallbackModel && fallbackModel !== targetModel) {
        helper.applyModelFallback({
          provider: 'openai',
          previousModel: targetModel,
          fallbackModel,
          reason: 'model_not_found',
        });
        yield* streamWithOpenaiUsingModel(helper, userMessage, fallbackModel, systemPrompt, abortSignal);
        return;
      }
    }
    requestControl.cleanup();
    throw error;
  }

  let finalUsage: OpenAiCacheUsage | null = null;
  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
      // The terminal chunk has empty `choices` and a populated `usage`. We
      // capture it here rather than reading `stream.usage` afterwards because
      // a stale-stream race could lose it.
      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        finalUsage = usage;
      }
    }
  } finally {
    requestControl.cleanup();
    logOpenAiCacheUsage(`streamWithOpenai model=${targetModel}`, finalUsage);
  }
}

/**
 * Stream multimodal (image + text) response from OpenAI with system/user separation
 */
export async function* streamWithOpenaiMultimodal(
  helper: LLMHelper,
  userMessage: string,
  imagePaths: string[],
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const targetModel = helper.getActiveOpenAiModel();

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const contentParts: any[] = [{ type: "text", text: userMessage }];
  for (const p of imagePaths) {
    if (fs.existsSync(p)) {
      const imageData = await fs.promises.readFile(p);
      contentParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData.toString("base64")}` } });
    }
  }
  messages.push({ role: "user", content: contentParts });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const promptCacheKey = buildPromptCacheKey(systemPrompt);

  let stream;
  try {
    stream = await helper.openaiClient.chat.completions.create({
      model: targetModel,
      messages,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: OPENAI_ANSWER_TEMPERATURE,
      stream_options: { include_usage: true },
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    }, { signal: requestControl.signal });
  } catch (error) {
    if (helper.isModelNotFoundError(error)) {
      const fallbackModel = await helper.resolveOpenAiFallbackModel(targetModel);
      if (fallbackModel && fallbackModel !== targetModel) {
        helper.applyModelFallback({
          provider: 'openai',
          previousModel: targetModel,
          fallbackModel,
          reason: 'model_not_found',
        });
        yield* streamWithOpenaiMultimodalUsingModel(helper, userMessage, imagePaths, fallbackModel, systemPrompt, abortSignal);
        return;
      }
    }
    requestControl.cleanup();
    throw error;
  }

  let finalUsage: OpenAiCacheUsage | null = null;
  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        finalUsage = usage;
      }
    }
  } finally {
    requestControl.cleanup();
    logOpenAiCacheUsage(`streamWithOpenaiMultimodal model=${targetModel}`, finalUsage);
  }
}

export async function* streamWithOpenaiUsingModel(
  helper: LLMHelper,
  userMessage: string,
  model: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const promptCacheKey = buildPromptCacheKey(systemPrompt);
  const stream = await helper.openaiClient.chat.completions.create({
    model,
    messages,
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: OPENAI_ANSWER_TEMPERATURE,
    stream_options: { include_usage: true },
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  }, { signal: requestControl.signal });

  let finalUsage: OpenAiCacheUsage | null = null;
  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        finalUsage = usage;
      }
    }
  } finally {
    requestControl.cleanup();
    logOpenAiCacheUsage(`streamWithOpenaiUsingModel model=${model}`, finalUsage);
  }
}

export async function* streamWithOpenaiMultimodalUsingModel(
  helper: LLMHelper,
  userMessage: string,
  imagePaths: string[],
  model: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const contentParts: any[] = [{ type: "text", text: userMessage }];
  for (const p of imagePaths) {
    if (fs.existsSync(p)) {
      const imageData = await fs.promises.readFile(p);
      contentParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData.toString("base64")}` } });
    }
  }
  messages.push({ role: "user", content: contentParts });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const promptCacheKey = buildPromptCacheKey(systemPrompt);
  const stream = await helper.openaiClient.chat.completions.create({
    model,
    messages,
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: OPENAI_ANSWER_TEMPERATURE,
    stream_options: { include_usage: true },
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  }, { signal: requestControl.signal });

  let finalUsage: OpenAiCacheUsage | null = null;
  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        finalUsage = usage;
      }
    }
  } finally {
    requestControl.cleanup();
    logOpenAiCacheUsage(`streamWithOpenaiMultimodalUsingModel model=${model}`, finalUsage);
  }
}
