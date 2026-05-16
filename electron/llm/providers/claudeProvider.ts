import { LLMHelper } from '../../LLMHelper';
import { createRequestAbortController, CLAUDE_MODEL, CLAUDE_MAX_OUTPUT_TOKENS, LLM_API_TIMEOUT_MS } from '../../LLMHelper';
import fs from 'fs';
import { buildClaudeSystemParam, logClaudeCacheUsage, type ClaudeCacheUsage } from './cacheTelemetry';

/**
 * NAT-ACCURACY: temperature for primary answer generation. Same rationale
 * as OpenAI — low enough to reduce hallucination, high enough for natural
 * conversational tone. Claude's temperature scale is identical to OpenAI's.
 */
const CLAUDE_ANSWER_TEMPERATURE = 0.4;

/**
 * NAT-CACHE-AUDIT: aggregate Anthropic usage across the streaming events.
 * `message_start` carries the initial usage (input tokens + cache read/create),
 * `message_delta` carries the running output token count and cumulative
 * cache creation totals. We accumulate from both so we never under-report
 * the cache write counts on requests where caching just engaged.
 */
function mergeClaudeUsage(running: ClaudeCacheUsage | null, fresh: any): ClaudeCacheUsage {
  return {
    inputTokens: typeof fresh?.input_tokens === 'number' ? fresh.input_tokens : running?.inputTokens,
    outputTokens: typeof fresh?.output_tokens === 'number' ? fresh.output_tokens : running?.outputTokens,
    cacheReadInputTokens: typeof fresh?.cache_read_input_tokens === 'number'
      ? fresh.cache_read_input_tokens
      : running?.cacheReadInputTokens,
    cacheCreationInputTokens: typeof fresh?.cache_creation_input_tokens === 'number'
      ? fresh.cache_creation_input_tokens
      : running?.cacheCreationInputTokens,
  };
}

/**
 * Stream response from Claude with proper system/user message separation.
 *
 * NAT-CACHE-AUDIT: when the system prompt is large enough to plausibly
 * benefit from prompt caching (≥600 chars / ~150 tokens), wrap it in a
 * single TextBlockParam with `cache_control: { type: 'ephemeral' }`. Per
 * Anthropic docs, the breakpoint should sit on the LAST block that is
 * identical across requests — for a stable system prompt that is the system
 * block itself. Conscious-mode system prompts are stable across the same
 * mode/turn-shape pair, so this should produce real cache hits with the
 * 5-minute default TTL.
 */
export async function* streamWithClaude(
  helper: LLMHelper,
  userMessage: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.claudeClient) throw new Error("Claude client not initialized");

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const systemParam = buildClaudeSystemParam(systemPrompt);

  const stream = await helper.claudeClient.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
    temperature: CLAUDE_ANSWER_TEMPERATURE,
    ...(systemParam ? { system: systemParam } : {}),
    messages: [{ role: "user", content: userMessage }],
  } as any, { signal: requestControl.signal });

  let usage: ClaudeCacheUsage | null = null;
  try {
    for await (const event of stream) {
      if (requestControl.signal.aborted) {
        return;
      }
      if (event.type === 'message_start' && (event as any).message?.usage) {
        usage = mergeClaudeUsage(usage, (event as any).message.usage);
      } else if (event.type === 'message_delta' && (event as any).usage) {
        usage = mergeClaudeUsage(usage, (event as any).usage);
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } finally {
    requestControl.cleanup();
    logClaudeCacheUsage(`streamWithClaude model=${CLAUDE_MODEL}`, usage);
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
  abortSignal?: AbortSignal
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
          data: imageData.toString("base64")
        }
      });
    }
  }

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const systemParam = buildClaudeSystemParam(systemPrompt);

  const stream = await helper.claudeClient.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
    temperature: CLAUDE_ANSWER_TEMPERATURE,
    ...(systemParam ? { system: systemParam } : {}),
    messages: [{
      role: "user",
      content: [
        ...imageContentParts,
        { type: "text", text: userMessage }
      ]
    }],
  } as any, { signal: requestControl.signal });

  let usage: ClaudeCacheUsage | null = null;
  try {
    for await (const event of stream) {
      if (requestControl.signal.aborted) {
        return;
      }
      if (event.type === 'message_start' && (event as any).message?.usage) {
        usage = mergeClaudeUsage(usage, (event as any).message.usage);
      } else if (event.type === 'message_delta' && (event as any).usage) {
        usage = mergeClaudeUsage(usage, (event as any).usage);
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } finally {
    requestControl.cleanup();
    logClaudeCacheUsage(`streamWithClaudeMultimodal model=${CLAUDE_MODEL}`, usage);
  }
}
