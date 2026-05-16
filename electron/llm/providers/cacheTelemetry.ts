/**
 * NAT-CACHE-AUDIT: Provider-agnostic prompt-cache telemetry.
 *
 * Why this exists:
 *   - OpenAI Chat Completions streaming only reports `usage.prompt_tokens_details.cached_tokens`
 *     when the request opts into `stream_options: { include_usage: true }`. Without that flag
 *     we get zero observability into cache hit rates for streaming calls.
 *   - Anthropic Messages streaming reports `cache_read_input_tokens` and
 *     `cache_creation_input_tokens` on the `message_start` event and again on
 *     `message_delta`. We need to consume them to know whether our `cache_control`
 *     breakpoints are actually working.
 *
 * What this does NOT do:
 *   - It does not log prompt text, system prompts, or any user content. Only
 *     numeric token counts and a short opaque cache-key fingerprint go to the
 *     log to keep the surface area PII-free.
 *
 * Tests:
 *   electron/tests/cacheTelemetry.test.ts pin the public surface so a Codex
 *   review can verify the contract without re-deriving it from logs.
 */

import { createHash } from 'crypto';
import { Metrics } from '../../runtime/Metrics';

export interface OpenAiCacheUsage {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ClaudeCacheUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Build a stable, low-cardinality cache-key fingerprint suitable for OpenAI's
 * `prompt_cache_key`. Per OpenAI docs, the parameter is hashed alongside the
 * prefix to influence routing — what matters is that it stays IDENTICAL across
 * requests that share the same large static prefix (system prompt + tool
 * defs), and DIFFERS when prefixes differ.
 *
 * We hash the system prompt content. This means:
 *   - Same system prompt (verbatim) → same key → consistent routing.
 *   - Different system prompt → different key → don't pollute another prefix's
 *     cache pool.
 *   - No user PII reaches the cache key (only the system prompt, which is
 *     application-controlled).
 */
export function buildPromptCacheKey(systemPrompt: string | undefined | null): string | undefined {
  const normalized = (systemPrompt || '').trim();
  if (!normalized) return undefined;
  // 16 hex chars = 64 bits — well under the 256-byte limit, plenty unique.
  return `sys_${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export function logOpenAiCacheUsage(label: string, usage: OpenAiCacheUsage | null | undefined): void {
  if (!usage || typeof usage.promptTokens !== 'number') return;
  const cached = usage.cachedTokens ?? 0;
  const prompt = usage.promptTokens ?? 0;
  // Avoid divide-by-zero; avoid logging when prompt is tiny enough that cache
  // wouldn't have applied anyway (under 1024-token threshold).
  const hitRatio = prompt > 0 ? cached / prompt : 0;
  Metrics.counter('llm.openai.prompt_tokens_total', prompt);
  Metrics.counter('llm.openai.cached_tokens_total', cached);
  Metrics.counter('llm.openai.completion_tokens_total', usage.completionTokens ?? 0);
  if (cached > 0) {
    Metrics.counter('llm.openai.cache_hit_requests_total', 1);
  }
  console.log('[LLMCache:openai]', label, JSON.stringify({
    promptTokens: prompt,
    cachedTokens: cached,
    completionTokens: usage.completionTokens ?? 0,
    cacheHitRatio: Number(hitRatio.toFixed(3)),
  }));
}

export function logClaudeCacheUsage(label: string, usage: ClaudeCacheUsage | null | undefined): void {
  if (!usage) return;
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const totalInput = input + cacheRead + cacheWrite;
  const hitRatio = totalInput > 0 ? cacheRead / totalInput : 0;
  Metrics.counter('llm.claude.input_tokens_total', input);
  Metrics.counter('llm.claude.cache_read_tokens_total', cacheRead);
  Metrics.counter('llm.claude.cache_creation_tokens_total', cacheWrite);
  Metrics.counter('llm.claude.output_tokens_total', usage.outputTokens ?? 0);
  if (cacheRead > 0) {
    Metrics.counter('llm.claude.cache_hit_requests_total', 1);
  }
  if (cacheWrite > 0) {
    Metrics.counter('llm.claude.cache_write_requests_total', 1);
  }
  console.log('[LLMCache:claude]', label, JSON.stringify({
    inputTokens: input,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    outputTokens: usage.outputTokens ?? 0,
    cacheHitRatio: Number(hitRatio.toFixed(3)),
  }));
}

/**
 * Build a Claude `system` parameter that opts the system prompt into prompt
 * caching when it's long enough to plausibly hit the model's minimum cache
 * size (~1024 tokens for Sonnet, ~4096 for Opus/Haiku 4.5).
 *
 * If the system prompt is missing or trivially short, return undefined so the
 * caller can skip the `system` parameter entirely (matches the legacy
 * behavior). When present, we wrap the system prompt in a single text block
 * with `cache_control: { type: 'ephemeral' }`. Anthropic recommends placing
 * the breakpoint on the LAST identical block — for a fixed system prompt that
 * is the system block itself.
 *
 * We do NOT add a TTL (so it defaults to the 5-minute cache, which is
 * refreshed for free on every hit). Switching to 1h would double the cache
 * write cost; only worth it for prompts used on the hour cadence.
 *
 * Approximate token budget: 1 token ≈ 4 chars for English. We require at
 * least ~600 chars (≈150 tokens) before bothering to mark cacheable; below
 * that the cache won't engage and the marker is a no-op anyway, but adding it
 * to short prompts increases the chance of accidentally tripping a 4-block
 * cache slot limit.
 */
const CLAUDE_CACHE_MIN_CHARS = 600;

export function buildClaudeSystemParam(systemPrompt: string | undefined | null):
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  | undefined {
  const trimmed = (systemPrompt || '').trim();
  if (!trimmed) return undefined;
  if (trimmed.length < CLAUDE_CACHE_MIN_CHARS) {
    // Below the cache breakeven; passing as a plain string preserves legacy
    // behavior and avoids consuming a cache_control slot for nothing.
    return trimmed;
  }
  return [
    {
      type: 'text',
      text: trimmed,
      cache_control: { type: 'ephemeral' },
    },
  ];
}
