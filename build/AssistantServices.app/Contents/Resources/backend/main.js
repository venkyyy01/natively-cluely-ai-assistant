// main.ts
import * as readline from "readline";

// settings.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var defaults = {
  isUndetectable: true,
  disguiseMode: "none",
  overlayBounds: null,
  selectedModel: "gpt-4o",
  apiKeys: {},
  featureFlags: {
    usePromptCompiler: true,
    useStreamManager: true,
    useEnhancedCache: true,
    useANEEmbeddings: true,
    useParallelContext: true,
    useAdaptiveWindow: true,
    usePrefetching: true
  }
};
var SettingsManager = class {
  data;
  configPath;
  filePath;
  constructor() {
    this.configPath = join(homedir(), "Library", "Application Support", "natively");
    this.filePath = join(this.configPath, "config.json");
    if (!existsSync(this.configPath)) {
      mkdirSync(this.configPath, { recursive: true });
    }
    this.data = this.load();
  }
  load() {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(content);
        return { ...defaults, ...parsed };
      }
    } catch (error) {
      console.error("[Settings] Failed to load config:", error);
    }
    return { ...defaults };
  }
  save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      console.error("[Settings] Failed to save config:", error);
    }
  }
  get(key) {
    return this.data[key];
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  getAll() {
    return { ...this.data };
  }
  reset() {
    this.data = { ...defaults };
    this.save();
  }
};
var settings = new SettingsManager();

// llm/PromptCompiler.ts
var DEFAULT_OPTIONS = {
  maxTokens: 8192,
  normalizeWhitespace: true,
  useAbbreviations: true,
  removeRedundancy: true,
  condenseRoles: true,
  provider: "generic"
};
var ABBREVIATIONS = [
  [/\bfor example\b/gi, "e.g."],
  [/\bthat is\b/gi, "i.e."],
  [/\bin other words\b/gi, "i.e."],
  [/\band so on\b/gi, "etc."],
  [/\bet cetera\b/gi, "etc."],
  [/\bplease note that\b/gi, "Note:"],
  [/\bit is important to note that\b/gi, "Note:"],
  [/\bkeep in mind that\b/gi, "Note:"],
  [/\bremember that\b/gi, "Note:"],
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bin the event that\b/gi, "if"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the near future\b/gi, "soon"],
  [/\ba large number of\b/gi, "many"],
  [/\ba small number of\b/gi, "few"],
  [/\bthe majority of\b/gi, "most"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\bwith respect to\b/gi, "regarding"],
  [/\bin relation to\b/gi, "about"],
  [/\bas a result of\b/gi, "because"],
  [/\bby means of\b/gi, "by"],
  [/\bin accordance with\b/gi, "per"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"]
];
var REDUNDANT_PHRASES = [
  /\bactually\b/gi,
  /\bbasically\b/gi,
  /\bliterally\b/gi,
  /\bobviously\b/gi,
  /\bclearly\b/gi,
  /\bsimply\b/gi,
  /\bjust\b/gi,
  /\breally\b/gi,
  /\bvery\b/gi,
  /\bextremely\b/gi,
  /\babsolutely\b/gi,
  /\bdefinitely\b/gi,
  /\bcertainly\b/gi,
  /\bperhaps\b/gi,
  /\bmaybe\b/gi,
  /\bpossibly\b/gi,
  /\bprobably\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bI think\b/gi,
  /\bI believe\b/gi,
  /\bI feel\b/gi,
  /\bit seems\b/gi,
  /\bto be honest\b/gi,
  /\bfrankly\b/gi,
  /\bhonestly\b/gi
];
var PromptCompiler = class {
  cache = /* @__PURE__ */ new Map();
  maxCacheSize = 100;
  /**
   * Estimate token count using heuristic (4 chars ≈ 1 token)
   * This is a rough estimate that works well for English text.
   */
  estimateTokens(text) {
    const baseEstimate = Math.ceil(text.length / 4);
    const whitespaceRatio = (text.match(/\s/g)?.length || 0) / Math.max(text.length, 1);
    const whitespaceAdjustment = whitespaceRatio > 0.2 ? 0.9 : 1;
    const codeIndicators = (text.match(/[{}\[\]();:=<>]/g)?.length || 0) / Math.max(text.length, 1);
    const codeAdjustment = codeIndicators > 0.05 ? 1.2 : 1;
    return Math.ceil(baseEstimate * whitespaceAdjustment * codeAdjustment);
  }
  /**
   * Compile messages with optimizations.
   */
  compile(messages, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cacheKey = this.generateCacheKey(messages, opts);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const originalTokens = messages.reduce(
      (sum, m) => sum + this.estimateTokens(m.content),
      0
    );
    let processedMessages = messages.map((m) => ({ ...m }));
    if (opts.normalizeWhitespace) {
      processedMessages = this.normalizeWhitespace(processedMessages);
    }
    if (opts.useAbbreviations) {
      processedMessages = this.applyAbbreviations(processedMessages);
    }
    if (opts.removeRedundancy) {
      processedMessages = this.removeRedundancy(processedMessages);
    }
    if (opts.condenseRoles) {
      processedMessages = this.condenseRoles(processedMessages);
    }
    if (opts.maxTokens) {
      processedMessages = this.truncateToLimit(processedMessages, opts.maxTokens);
    }
    const finalTokens = processedMessages.reduce(
      (sum, m) => sum + this.estimateTokens(m.content),
      0
    );
    const result = {
      messages: processedMessages,
      estimatedTokens: finalTokens,
      compressionRatio: originalTokens > 0 ? 1 - finalTokens / originalTokens : 0
    };
    this.cacheResult(cacheKey, result);
    return result;
  }
  /**
   * Normalize whitespace in messages.
   */
  normalizeWhitespace(messages) {
    return messages.map((m) => ({
      ...m,
      content: m.content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").replace(/[ \t]+\n/g, "\n").trim()
    }));
  }
  /**
   * Apply abbreviations to reduce token count.
   */
  applyAbbreviations(messages) {
    return messages.map((m) => {
      let content = m.content;
      for (const [pattern, replacement] of ABBREVIATIONS) {
        content = content.replace(pattern, replacement);
      }
      return { ...m, content };
    });
  }
  /**
   * Remove redundant phrases.
   */
  removeRedundancy(messages) {
    return messages.map((m) => {
      let content = m.content;
      for (const pattern of REDUNDANT_PHRASES) {
        content = content.replace(pattern, "");
      }
      content = content.replace(/\s{2,}/g, " ").trim();
      return { ...m, content };
    });
  }
  /**
   * Condense consecutive messages with the same role.
   */
  condenseRoles(messages) {
    if (messages.length <= 1)
      return messages;
    const condensed = [];
    let current = null;
    for (const msg of messages) {
      if (current && current.role === msg.role) {
        current.content += "\n\n" + msg.content;
      } else {
        if (current) {
          condensed.push(current);
        }
        current = { ...msg };
      }
    }
    if (current) {
      condensed.push(current);
    }
    return condensed;
  }
  /**
   * Truncate messages to fit within token limit.
   * Uses smart boundary detection to avoid cutting mid-sentence.
   */
  truncateToLimit(messages, maxTokens) {
    const result = [];
    let usedTokens = 0;
    const systemMsg = messages.find((m) => m.role === "system");
    const otherMsgs = messages.filter((m) => m.role !== "system");
    if (systemMsg) {
      const systemTokens = this.estimateTokens(systemMsg.content);
      if (systemTokens <= maxTokens * 0.4) {
        result.push(systemMsg);
        usedTokens += systemTokens;
      } else {
        const truncated = this.smartTruncate(
          systemMsg.content,
          Math.floor(maxTokens * 0.4)
        );
        result.push({ ...systemMsg, content: truncated });
        usedTokens += this.estimateTokens(truncated);
      }
    }
    const remainingBudget = maxTokens - usedTokens;
    const reversedMsgs = [...otherMsgs].reverse();
    const selectedMsgs = [];
    for (const msg of reversedMsgs) {
      const msgTokens = this.estimateTokens(msg.content);
      if (usedTokens + msgTokens <= maxTokens) {
        selectedMsgs.unshift(msg);
        usedTokens += msgTokens;
      } else if (remainingBudget - usedTokens > 100) {
        const availableTokens = maxTokens - usedTokens;
        const truncated = this.smartTruncate(msg.content, availableTokens);
        selectedMsgs.unshift({ ...msg, content: truncated });
        break;
      }
    }
    result.push(...selectedMsgs);
    return result;
  }
  /**
   * Truncate text at sentence boundaries when possible.
   */
  smartTruncate(text, maxTokens) {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) {
      return text;
    }
    const searchWindow = text.substring(0, maxChars + 100);
    const sentenceEnds = /[.!?]\s+/g;
    let lastGoodBreak = maxChars;
    let match;
    while ((match = sentenceEnds.exec(searchWindow)) !== null) {
      if (match.index + match[0].length <= maxChars) {
        lastGoodBreak = match.index + match[0].length;
      }
    }
    if (lastGoodBreak === maxChars) {
      const paragraphBreak = text.lastIndexOf("\n\n", maxChars);
      if (paragraphBreak > maxChars * 0.7) {
        lastGoodBreak = paragraphBreak;
      }
    }
    if (lastGoodBreak === maxChars) {
      const lineBreak = text.lastIndexOf("\n", maxChars);
      if (lineBreak > maxChars * 0.8) {
        lastGoodBreak = lineBreak;
      }
    }
    if (lastGoodBreak === maxChars) {
      const wordBreak = text.lastIndexOf(" ", maxChars);
      if (wordBreak > maxChars * 0.9) {
        lastGoodBreak = wordBreak;
      }
    }
    return text.substring(0, lastGoodBreak).trim() + "...";
  }
  /**
   * Generate cache key for memoization.
   */
  generateCacheKey(messages, opts) {
    const contentHash = messages.map((m) => `${m.role}:${m.content.substring(0, 100)}`).join("|");
    const optsHash = JSON.stringify(opts);
    return `${contentHash}::${optsHash}`;
  }
  /**
   * Cache compiled result with LRU eviction.
   */
  cacheResult(key, result) {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, result);
  }
  /**
   * Clear the compilation cache.
   */
  clearCache() {
    this.cache.clear();
  }
  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize
    };
  }
};
var promptCompiler = new PromptCompiler();

// llm/StreamManager.ts
var StreamManager = class {
  providers = /* @__PURE__ */ new Map();
  activeStreams = /* @__PURE__ */ new Map();
  constructor() {
    this.registerProvider("openai", this.streamOpenAI.bind(this));
    this.registerProvider("anthropic", this.streamAnthropic.bind(this));
    this.registerProvider("generic", this.streamGenericOpenAI.bind(this));
  }
  /**
   * Register a custom provider streaming function.
   */
  registerProvider(name, streamFn) {
    this.providers.set(name, streamFn);
  }
  /**
   * Stream a single request.
   */
  async *stream(request) {
    const startTime = Date.now();
    let firstTokenTime = null;
    let fullResponse = "";
    const controller = new AbortController();
    if (request.signal) {
      request.signal.addEventListener("abort", () => controller.abort());
    }
    this.activeStreams.set(request.id, controller);
    try {
      const providerFn = this.providers.get(request.provider) || this.providers.get("generic");
      if (!providerFn) {
        throw new Error(`Unknown provider: ${request.provider}`);
      }
      const stream = providerFn({
        ...request,
        signal: controller.signal
      });
      for await (const token of stream) {
        if (controller.signal.aborted) {
          break;
        }
        const now = Date.now();
        if (firstTokenTime === null) {
          firstTokenTime = now;
        }
        fullResponse += token;
        yield {
          requestId: request.id,
          type: "token",
          text: token,
          timestamp: now,
          latencyMs: now - startTime
        };
      }
      yield {
        requestId: request.id,
        type: "complete",
        response: fullResponse,
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime
      };
    } catch (error) {
      yield {
        requestId: request.id,
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime
      };
    } finally {
      this.activeStreams.delete(request.id);
    }
  }
  /**
   * Stream multiple requests in parallel, yielding chunks as they arrive.
   * Useful for racing multiple providers or models.
   */
  async *streamParallel(requests) {
    const streams = requests.map((req) => this.stream(req));
    const iterators = streams.map((s) => s[Symbol.asyncIterator]());
    const active = new Set(iterators.map((_, i) => i));
    const pending = /* @__PURE__ */ new Map();
    for (const [index, iterator] of iterators.entries()) {
      pending.set(
        index,
        iterator.next().then((result) => ({ index, result }))
      );
    }
    while (active.size > 0) {
      const promises = Array.from(pending.values());
      const { index, result } = await Promise.race(promises);
      if (result.done) {
        active.delete(index);
        pending.delete(index);
      } else {
        yield result.value;
        if (active.has(index)) {
          const iterator = iterators[index];
          pending.set(
            index,
            iterator.next().then((r) => ({ index, result: r }))
          );
        }
      }
    }
  }
  /**
   * Stream with first-wins semantics.
   * Starts multiple requests and returns the first successful completion.
   */
  async streamFirstWins(requests, config) {
    return new Promise((resolve, reject) => {
      const controllers = [];
      const completions = /* @__PURE__ */ new Map();
      let resolved = false;
      const cleanup = () => {
        for (const ctrl of controllers) {
          try {
            ctrl.abort();
          } catch {
          }
        }
      };
      const processStream = async (request) => {
        const controller = new AbortController();
        controllers.push(controller);
        let response = "";
        try {
          for await (const chunk of this.stream({
            ...request,
            signal: controller.signal
          })) {
            if (resolved)
              return;
            if (chunk.type === "token" && chunk.text) {
              response += chunk.text;
              config?.onToken?.(chunk.text, request.id);
            } else if (chunk.type === "complete") {
              completions.set(request.id, {
                response: chunk.response || response,
                latencyMs: chunk.latencyMs || 0
              });
              if (!resolved) {
                resolved = true;
                cleanup();
                config?.onComplete?.(chunk.response || response, request.id);
                resolve({
                  requestId: request.id,
                  response: chunk.response || response,
                  latencyMs: chunk.latencyMs || 0
                });
              }
            } else if (chunk.type === "error") {
              config?.onError?.(new Error(chunk.error), request.id);
            }
          }
        } catch (error) {
          if (!resolved) {
            config?.onError?.(
              error instanceof Error ? error : new Error(String(error)),
              request.id
            );
          }
        }
      };
      Promise.allSettled(requests.map(processStream)).then((results) => {
        if (!resolved) {
          const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
          reject(
            new Error(
              `All streams failed: ${errors.map((e) => e.message).join(", ")}`
            )
          );
        }
      });
    });
  }
  /**
   * Cancel an active stream.
   */
  cancelStream(requestId) {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
      return true;
    }
    return false;
  }
  /**
   * Cancel all active streams.
   */
  cancelAll() {
    for (const [id, controller] of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();
  }
  /**
   * Get count of active streams.
   */
  getActiveStreamCount() {
    return this.activeStreams.size;
  }
  // Provider implementations
  /**
   * Stream from OpenAI-compatible API.
   */
  async *streamOpenAI(request) {
    const baseUrl = request.baseUrl || "https://api.openai.com/v1";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true
      }),
      signal: request.signal
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }
    if (!response.body) {
      throw new Error("No response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]")
            continue;
          if (!trimmed.startsWith("data: "))
            continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  /**
   * Stream from Anthropic API.
   */
  async *streamAnthropic(request) {
    const baseUrl = request.baseUrl || "https://api.anthropic.com/v1";
    const systemMessage = request.messages.find((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: request.model,
        system: systemMessage?.content,
        messages: otherMessages,
        max_tokens: request.maxTokens || 4096,
        stream: true
      }),
      signal: request.signal
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }
    if (!response.body) {
      throw new Error("No response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: "))
            continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            if (json.type === "content_block_delta") {
              const text = json.delta?.text;
              if (text) {
                yield text;
              }
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  /**
   * Stream from generic OpenAI-compatible API.
   * Works with Ollama, Together AI, Groq, etc.
   */
  async *streamGenericOpenAI(request) {
    yield* this.streamOpenAI(request);
  }
};
var streamManager = new StreamManager();

// cache/EnhancedCache.ts
var DEFAULT_CONFIG = {
  maxSize: 1e3,
  ttlMs: 30 * 60 * 1e3,
  // 30 minutes
  enableSemanticLookup: true,
  similarityThreshold: 0.85,
  name: "cache"
};
var EnhancedCache = class {
  lru = /* @__PURE__ */ new Map();
  embeddings = null;
  config;
  // Stats
  stats = {
    hits: 0,
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0
  };
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.enableSemanticLookup) {
      this.embeddings = /* @__PURE__ */ new Map();
    }
    setInterval(() => this.cleanupExpired(), 6e4);
  }
  /**
   * Get a value from cache.
   * Tries exact match first, then semantic match if enabled.
   */
  get(key, embedding) {
    const stringKey = this.keyToString(key);
    const exact = this.lru.get(stringKey);
    if (exact && !this.isExpired(exact)) {
      this.touchEntry(stringKey, exact);
      this.stats.hits++;
      this.stats.exactHits++;
      return {
        value: exact.value,
        createdAt: exact.createdAt,
        lastAccessed: exact.lastAccessed,
        semanticMatch: false
      };
    }
    if (exact) {
      this.lru.delete(stringKey);
      this.embeddings?.delete(stringKey);
      this.stats.expirations++;
    }
    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      const similar = this.findSimilar(embedding);
      if (similar) {
        this.stats.hits++;
        this.stats.semanticHits++;
        return similar;
      }
    }
    this.stats.misses++;
    return null;
  }
  /**
   * Set a value in cache.
   */
  set(key, value, embedding) {
    const stringKey = this.keyToString(key);
    while (this.lru.size >= this.config.maxSize) {
      this.evictOldest();
    }
    const now = Date.now();
    this.lru.set(stringKey, {
      value,
      createdAt: now,
      lastAccessed: now,
      embedding
    });
    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      this.embeddings.set(stringKey, embedding);
    }
  }
  /**
   * Check if key exists (without updating access time).
   */
  has(key) {
    const stringKey = this.keyToString(key);
    const entry = this.lru.get(stringKey);
    return entry !== void 0 && !this.isExpired(entry);
  }
  /**
   * Delete a key from cache.
   */
  delete(key) {
    const stringKey = this.keyToString(key);
    this.embeddings?.delete(stringKey);
    return this.lru.delete(stringKey);
  }
  /**
   * Clear all entries.
   */
  clear() {
    this.lru.clear();
    this.embeddings?.clear();
    this.resetStats();
  }
  /**
   * Get cache statistics.
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      size: this.lru.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      exactHits: this.stats.exactHits,
      semanticHits: this.stats.semanticHits,
      misses: this.stats.misses,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0,
      evictions: this.stats.evictions,
      expirations: this.stats.expirations,
      memoryEstimate: this.estimateMemoryUsage()
    };
  }
  /**
   * Reset statistics.
   */
  resetStats() {
    this.stats = {
      hits: 0,
      exactHits: 0,
      semanticHits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0
    };
  }
  /**
   * Get all keys (for debugging).
   */
  keys() {
    return Array.from(this.lru.keys());
  }
  /**
   * Get cache size.
   */
  get size() {
    return this.lru.size;
  }
  // Private methods
  /**
   * Convert key to string for storage.
   */
  keyToString(key) {
    if (typeof key === "string") {
      return key;
    }
    return JSON.stringify(key);
  }
  /**
   * Check if entry has expired.
   */
  isExpired(entry) {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }
  /**
   * Update last accessed time and move to end of LRU.
   */
  touchEntry(key, entry) {
    entry.lastAccessed = Date.now();
    this.lru.delete(key);
    this.lru.set(key, entry);
  }
  /**
   * Evict oldest entry (first in Map).
   */
  evictOldest() {
    const firstKey = this.lru.keys().next().value;
    if (firstKey !== void 0) {
      this.lru.delete(firstKey);
      this.embeddings?.delete(firstKey);
      this.stats.evictions++;
    }
  }
  /**
   * Find similar entry by embedding.
   */
  findSimilar(queryEmbedding) {
    if (!this.embeddings)
      return null;
    let bestMatch = null;
    for (const [key, storedEmbedding] of this.embeddings) {
      const entry = this.lru.get(key);
      if (!entry || this.isExpired(entry))
        continue;
      const similarity = this.cosineSimilarity(queryEmbedding, storedEmbedding);
      if (similarity >= this.config.similarityThreshold && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { key, similarity, entry };
      }
    }
    if (bestMatch) {
      this.touchEntry(bestMatch.key, bestMatch.entry);
      return {
        value: bestMatch.entry.value,
        createdAt: bestMatch.entry.createdAt,
        lastAccessed: bestMatch.entry.lastAccessed,
        semanticMatch: true,
        similarity: bestMatch.similarity
      };
    }
    return null;
  }
  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length) {
      return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0)
      return 0;
    return dotProduct / denominator;
  }
  /**
   * Clean up expired entries.
   */
  cleanupExpired() {
    const keysToDelete = [];
    for (const [key, entry] of this.lru) {
      if (this.isExpired(entry)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.lru.delete(key);
      this.embeddings?.delete(key);
      this.stats.expirations++;
    }
  }
  /**
   * Estimate memory usage in bytes.
   */
  estimateMemoryUsage() {
    let total = 0;
    for (const [key, entry] of this.lru) {
      total += key.length * 2;
      const valueStr = JSON.stringify(entry.value);
      total += valueStr.length * 2;
      if (entry.embedding) {
        total += entry.embedding.length * 8;
      }
      total += 100;
    }
    return total;
  }
};
function generateCacheKey(messages, model) {
  const content = messages.map((m) => `${m.role}:${m.content}`).join("|");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const prefix = model ? `${model}:` : "";
  return `${prefix}${hash.toString(36)}`;
}
var responseCache = new EnhancedCache({
  maxSize: 500,
  ttlMs: 60 * 60 * 1e3,
  // 1 hour
  enableSemanticLookup: true,
  similarityThreshold: 0.9,
  name: "response"
});
var embeddingCache = new EnhancedCache({
  maxSize: 2e3,
  ttlMs: 24 * 60 * 60 * 1e3,
  // 24 hours
  enableSemanticLookup: false,
  // No semantic lookup for embeddings
  name: "embedding"
});

// llm/LLMClient.ts
var LLMClient = class {
  compiler;
  streamer;
  cache;
  options;
  // Stats
  stats = {
    totalRequests: 0,
    cacheHits: 0,
    totalTokensSaved: 0,
    totalLatencyMs: 0
  };
  constructor(options) {
    this.compiler = promptCompiler;
    this.streamer = streamManager;
    this.cache = responseCache;
    this.options = {
      defaultModel: options?.defaultModel || "gpt-4o",
      defaultProvider: options?.defaultProvider || "openai",
      apiKeys: options?.apiKeys || {},
      baseUrls: options?.baseUrls || {},
      enableCache: options?.enableCache ?? true,
      enableCompiler: options?.enableCompiler ?? true
    };
  }
  /**
   * Generate a response (streaming).
   * Returns an async iterable that yields tokens.
   */
  async *generate(request) {
    const startTime = Date.now();
    this.stats.totalRequests++;
    const model = request.model || this.options.defaultModel;
    const provider = request.provider || this.options.defaultProvider;
    const useCache = request.useCache ?? this.options.enableCache;
    const useCompiler = request.useCompiler ?? this.options.enableCompiler;
    if (useCache) {
      const cacheKey = generateCacheKey(request.messages, model);
      const cached = this.cache.get(cacheKey, request.embedding);
      if (cached) {
        this.stats.cacheHits++;
        yield cached.value;
        return;
      }
    }
    let messages = request.messages;
    let compressionRatio = 0;
    if (useCompiler) {
      const compiled = this.compiler.compile(messages, request.compilerOptions);
      messages = compiled.messages;
      compressionRatio = compiled.compressionRatio;
      this.stats.totalTokensSaved += Math.floor(
        compiled.estimatedTokens * compressionRatio
      );
    }
    const apiKey = request.apiKey || this.options.apiKeys[provider] || process.env[`${provider.toUpperCase()}_API_KEY`] || "";
    if (!apiKey) {
      throw new Error(`No API key configured for provider: ${provider}`);
    }
    const baseUrl = request.baseUrl || this.options.baseUrls[provider];
    const streamRequest = {
      id: `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      provider,
      model,
      messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      apiKey,
      baseUrl,
      signal: request.signal
    };
    let fullResponse = "";
    let firstTokenTime = null;
    for await (const chunk of this.streamer.stream(streamRequest)) {
      if (chunk.type === "token" && chunk.text) {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now() - startTime;
        }
        fullResponse += chunk.text;
        yield chunk.text;
      } else if (chunk.type === "error") {
        throw new Error(chunk.error);
      }
    }
    if (useCache && fullResponse) {
      const cacheKey = generateCacheKey(request.messages, model);
      this.cache.set(cacheKey, fullResponse, request.embedding);
    }
    this.stats.totalLatencyMs += Date.now() - startTime;
  }
  /**
   * Generate a response (non-streaming).
   * Returns the complete response.
   */
  async generateComplete(request) {
    const startTime = Date.now();
    let firstTokenTime = null;
    let response = "";
    for await (const token of this.generate(request)) {
      if (firstTokenTime === null) {
        firstTokenTime = Date.now() - startTime;
      }
      response += token;
    }
    const cacheKey = generateCacheKey(
      request.messages,
      request.model || this.options.defaultModel
    );
    const wasCached = this.cache.has(cacheKey);
    const tokensUsed = this.compiler.estimateTokens(response);
    let compressionRatio;
    if (request.useCompiler ?? this.options.enableCompiler) {
      const compiled = this.compiler.compile(
        request.messages,
        request.compilerOptions
      );
      compressionRatio = compiled.compressionRatio;
    }
    return {
      response,
      cached: wasCached,
      tokensUsed,
      compressionRatio,
      timeToFirstToken: firstTokenTime || void 0,
      latencyMs: Date.now() - startTime
    };
  }
  /**
   * Generate with multiple providers/models in parallel.
   * Returns the first successful response.
   */
  async generateRace(requests) {
    const streamRequests = requests.map((req, i) => {
      const provider = req.provider || this.options.defaultProvider;
      const model = req.model || this.options.defaultModel;
      const apiKey = req.apiKey || this.options.apiKeys[provider] || process.env[`${provider.toUpperCase()}_API_KEY`] || "";
      let messages = req.messages;
      if (req.useCompiler ?? this.options.enableCompiler) {
        const compiled = this.compiler.compile(messages, req.compilerOptions);
        messages = compiled.messages;
      }
      return {
        id: `race-${i}-${Date.now()}`,
        provider,
        model,
        messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        apiKey,
        baseUrl: req.baseUrl || this.options.baseUrls[provider],
        signal: req.signal
      };
    });
    const result = await this.streamer.streamFirstWins(streamRequests);
    const winningRequest = streamRequests.find((r) => r.id === result.requestId);
    return {
      response: result.response,
      provider: winningRequest?.provider || "unknown",
      model: winningRequest?.model || "unknown"
    };
  }
  /**
   * Set API key for a provider.
   */
  setApiKey(provider, apiKey) {
    this.options.apiKeys[provider] = apiKey;
  }
  /**
   * Set base URL for a provider.
   */
  setBaseUrl(provider, baseUrl) {
    this.options.baseUrls[provider] = baseUrl;
  }
  /**
   * Clear the response cache.
   */
  clearCache() {
    this.cache.clear();
  }
  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return this.cache.getStats();
  }
  /**
   * Get client statistics.
   */
  getStats() {
    const cacheStats = this.cache.getStats();
    return {
      ...this.stats,
      cacheHitRate: cacheStats.hitRate,
      cacheSize: cacheStats.size,
      averageLatencyMs: this.stats.totalRequests > 0 ? this.stats.totalLatencyMs / this.stats.totalRequests : 0
    };
  }
  /**
   * Reset statistics.
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      totalTokensSaved: 0,
      totalLatencyMs: 0
    };
  }
};
var llmClient = new LLMClient();

// context/ParallelContextAssembler.ts
var DEFAULT_SCORING_CONFIG = {
  bm25Weight: 0.35,
  semanticWeight: 0.35,
  recencyWeight: 0.15,
  priorityWeight: 0.15
};
var TOKENS_PER_CHAR = 0.25;
var ParallelContextAssembler = class {
  scoringConfig;
  // BM25 parameters
  k1 = 1.5;
  b = 0.75;
  constructor(config) {
    this.scoringConfig = { ...DEFAULT_SCORING_CONFIG, ...config };
  }
  /**
   * Assemble context from multiple sources in parallel.
   *
   * @param sources - Array of context sources to fetch from
   * @param budget - Maximum token budget
   * @param query - Query string for relevance scoring
   * @param queryEmbedding - Optional precomputed query embedding
   * @returns Assembled context within budget
   */
  async assemble(sources, budget, query, queryEmbedding) {
    const startTime = Date.now();
    const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);
    const fetchPromises = sortedSources.map(
      (source) => this.fetchSource(source)
    );
    const results = await Promise.allSettled(fetchPromises);
    const allChunks = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { chunks, priority } = result.value;
        for (const chunk of chunks) {
          allChunks.push({ ...chunk, sourcePriority: priority });
        }
      }
    }
    const scoredChunks = this.scoreChunks(
      allChunks,
      query,
      queryEmbedding
    );
    scoredChunks.sort((a, b) => b.score - a.score);
    const selected = this.selectWithinBudget(scoredChunks, budget);
    const byType = {
      transcript: 0,
      knowledge: 0,
      conversation: 0,
      system: 0
    };
    let totalTokens = 0;
    for (const chunk of selected) {
      byType[chunk.type]++;
      totalTokens += chunk.tokenCount || this.estimateTokens(chunk.content);
    }
    return {
      chunks: selected,
      totalTokens,
      budget,
      byType,
      latencyMs: Date.now() - startTime,
      consideredCount: allChunks.length,
      selectedCount: selected.length
    };
  }
  /**
   * Fetch chunks from a single source with error handling.
   */
  async fetchSource(source) {
    try {
      const chunks = await source.fetch();
      const limitedChunks = source.maxChunks ? chunks.slice(0, source.maxChunks) : chunks;
      return {
        type: source.type,
        chunks: limitedChunks,
        priority: source.priority
      };
    } catch (error) {
      console.error(
        `ParallelContextAssembler: Failed to fetch from ${source.type}:`,
        error
      );
      return {
        type: source.type,
        chunks: [],
        priority: source.priority,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
  /**
   * Score all chunks for relevance.
   */
  scoreChunks(chunks, query, queryEmbedding) {
    if (chunks.length === 0)
      return [];
    const bm25Scores = this.computeBM25Scores(
      query,
      chunks.map((c) => c.content)
    );
    const maxBM25 = Math.max(...bm25Scores, 1e-3);
    const maxPriority = Math.max(...chunks.map((c) => c.sourcePriority), 1);
    const now = Date.now();
    const maxAge = Math.max(
      ...chunks.map((c) => now - c.timestamp),
      1
    );
    return chunks.map((chunk, i) => {
      const bm25Score = bm25Scores[i] / maxBM25;
      let semanticScore = 0;
      if (queryEmbedding && chunk.embedding) {
        semanticScore = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      }
      const age = now - chunk.timestamp;
      const recencyScore = 1 - age / maxAge;
      const priorityScore = chunk.sourcePriority / maxPriority;
      const score = this.scoringConfig.bm25Weight * bm25Score + this.scoringConfig.semanticWeight * semanticScore + this.scoringConfig.recencyWeight * recencyScore + this.scoringConfig.priorityWeight * priorityScore;
      const { sourcePriority, ...rest } = chunk;
      return {
        ...rest,
        score,
        bm25Score,
        semanticScore
      };
    });
  }
  /**
   * Compute BM25 scores for a query against multiple documents.
   */
  computeBM25Scores(query, documents) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return documents.map(() => 0);
    }
    const docFreqs = /* @__PURE__ */ new Map();
    for (const doc of documents) {
      const docTerms = new Set(this.tokenize(doc));
      for (const term of docTerms) {
        docFreqs.set(term, (docFreqs.get(term) || 0) + 1);
      }
    }
    const avgDocLen = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;
    return documents.map((doc) => {
      const docTerms = this.tokenize(doc);
      const termFreqs = /* @__PURE__ */ new Map();
      for (const term of docTerms) {
        termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
      }
      let score = 0;
      const docLen = doc.length;
      const N = documents.length;
      for (const term of queryTerms) {
        const tf = termFreqs.get(term) || 0;
        if (tf === 0)
          continue;
        const df = docFreqs.get(term) || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen)));
        score += idf * tfNorm;
      }
      return score;
    });
  }
  /**
   * Simple tokenization for BM25.
   */
  tokenize(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  }
  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
      return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0)
      return 0;
    return dotProduct / denominator;
  }
  /**
   * Select chunks within token budget using greedy selection.
   */
  selectWithinBudget(chunks, budget) {
    const selected = [];
    let usedTokens = 0;
    for (const chunk of chunks) {
      const tokens = chunk.tokenCount || this.estimateTokens(chunk.content);
      if (usedTokens + tokens <= budget) {
        selected.push({ ...chunk, tokenCount: tokens });
        usedTokens += tokens;
      }
      if (usedTokens >= budget * 0.95)
        break;
    }
    return selected;
  }
  /**
   * Estimate token count for text.
   */
  estimateTokens(text) {
    return Math.ceil(text.length * TOKENS_PER_CHAR);
  }
  /**
   * Update scoring configuration.
   */
  setScoringConfig(config) {
    this.scoringConfig = { ...this.scoringConfig, ...config };
  }
};
var contextAssembler = new ParallelContextAssembler();

// prefetch/PredictivePrefetcher.ts
var PHASE_FOLLOWUP_PATTERNS = {
  intro: [
    "Tell me about yourself",
    "Why are you interested in this role?",
    "What do you know about our company?",
    "Walk me through your resume",
    "What are you looking for in your next role?"
  ],
  technical: [
    "Can you explain how that works in more detail?",
    "What are the tradeoffs of that approach?",
    "How would you handle edge cases?",
    "What about scalability?",
    "Can you give me a concrete example?",
    "What alternatives did you consider?",
    "How would you test this?"
  ],
  behavioral: [
    "Can you give me another example?",
    "What would you do differently?",
    "How did you handle the conflict?",
    "What did you learn from that experience?",
    "How did you measure success?",
    "Tell me about a time when you failed",
    "How do you handle disagreements with teammates?"
  ],
  experience: [
    "What was your specific contribution?",
    "What technologies did you use?",
    "How big was the team?",
    "What were the main challenges?",
    "What impact did the project have?",
    "How long did it take?"
  ],
  system_design: [
    "How would you handle millions of users?",
    "What about data consistency?",
    "How would you ensure reliability?",
    "What happens if this component fails?",
    "How would you monitor this system?",
    "What about security considerations?",
    "How would you handle caching?"
  ],
  coding: [
    "Can you optimize this solution?",
    "What is the time complexity?",
    "What is the space complexity?",
    "Can you write tests for this?",
    "How would you handle this edge case?",
    "Are there any bugs in your code?"
  ],
  closing: [
    "Do you have any questions for us?",
    "What are your salary expectations?",
    "When can you start?",
    "Is there anything else you would like to add?",
    "What questions do you have about the role?"
  ],
  unknown: [
    "Can you tell me more about that?",
    "What do you mean by that?",
    "Can you give me an example?"
  ]
};
var TOPIC_FOLLOWUPS = {
  architecture: [
    "How would you scale this?",
    "What about microservices vs monolith?",
    "How do you handle service communication?"
  ],
  database: [
    "SQL or NoSQL for this use case?",
    "How would you handle data migration?",
    "What about database sharding?"
  ],
  api: [
    "REST or GraphQL?",
    "How do you handle API versioning?",
    "What about rate limiting?"
  ],
  testing: [
    "How do you approach test coverage?",
    "Unit tests vs integration tests?",
    "How do you handle test data?"
  ],
  leadership: [
    "How do you motivate your team?",
    "How do you handle underperformers?",
    "How do you make decisions?"
  ],
  conflict: [
    "What was the outcome?",
    "How did you resolve it?",
    "What would you do differently?"
  ]
};
var PredictivePrefetcher = class {
  prefetchCache;
  isUserSpeaking = false;
  currentPhase = "unknown";
  recentQuestions = [];
  activeTopics = /* @__PURE__ */ new Set();
  contextGenerator;
  prefetchInProgress = false;
  abortController;
  constructor() {
    this.prefetchCache = new EnhancedCache({
      maxSize: 50,
      ttlMs: 15 * 60 * 1e3,
      // 15 minutes
      enableSemanticLookup: true,
      similarityThreshold: 0.8,
      name: "prefetch"
    });
  }
  /**
   * Set the context generator callback.
   */
  setContextGenerator(generator) {
    this.contextGenerator = generator;
  }
  /**
   * Update the current interview phase.
   */
  setPhase(phase) {
    this.currentPhase = phase;
  }
  /**
   * Add a question to the recent questions list.
   */
  addQuestion(question) {
    this.recentQuestions.unshift(question);
    if (this.recentQuestions.length > 10) {
      this.recentQuestions.pop();
    }
    this.extractTopics(question);
  }
  /**
   * Add a topic to track.
   */
  addTopic(topic) {
    this.activeTopics.add(topic.toLowerCase());
  }
  /**
   * Signal that user started speaking.
   */
  onUserSpeaking() {
    this.isUserSpeaking = true;
    this.abortPrefetching();
  }
  /**
   * Signal that user stopped speaking (silence detected).
   */
  onSilenceStart() {
    this.isUserSpeaking = false;
  }
  /**
   * Predict likely next questions based on context.
   */
  predictNextQuestions(context) {
    const predictions = [];
    const phasePatterns = PHASE_FOLLOWUP_PATTERNS[context.phase] || [];
    for (const pattern of phasePatterns.slice(0, 3)) {
      predictions.push({
        question: pattern,
        confidence: 0.6 + Math.random() * 0.2,
        // 0.6-0.8
        reason: `Common ${context.phase} phase question`,
        topic: context.phase
      });
    }
    for (const topic of context.topics.slice(0, 3)) {
      const topicPatterns = TOPIC_FOLLOWUPS[topic.toLowerCase()] || [];
      for (const pattern of topicPatterns.slice(0, 2)) {
        predictions.push({
          question: pattern,
          confidence: 0.5 + Math.random() * 0.2,
          // 0.5-0.7
          reason: `Follow-up on ${topic}`,
          topic
        });
      }
    }
    if (context.recentQuestions.length > 0) {
      const lastQuestion = context.recentQuestions[0];
      if (lastQuestion.toLowerCase().includes("tell me about") || lastQuestion.toLowerCase().includes("describe")) {
        predictions.push({
          question: "Can you tell me more about your specific role?",
          confidence: 0.7,
          reason: "Follow-up to experience question"
        });
        predictions.push({
          question: "What were the main challenges you faced?",
          confidence: 0.65,
          reason: "Follow-up to experience question"
        });
      }
      if (lastQuestion.toLowerCase().includes("how would you") || lastQuestion.toLowerCase().includes("design")) {
        predictions.push({
          question: "What about scalability concerns?",
          confidence: 0.6,
          reason: "Technical follow-up"
        });
      }
    }
    const seen = /* @__PURE__ */ new Set();
    return predictions.filter((p) => {
      const key = p.question.toLowerCase();
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }
  /**
   * Prefetch responses for predicted questions.
   */
  async prefetchResponses(questions) {
    if (!this.contextGenerator) {
      return {
        questions: [],
        cacheWarmed: 0,
        latencyMs: 0,
        interrupted: false
      };
    }
    if (this.prefetchInProgress) {
      this.abortPrefetching();
    }
    const startTime = Date.now();
    this.prefetchInProgress = true;
    this.abortController = new AbortController();
    let cacheWarmed = 0;
    const prefetchedQuestions = [];
    try {
      for (const question of questions) {
        if (this.abortController.signal.aborted || this.isUserSpeaking) {
          break;
        }
        const existing = this.prefetchCache.get(question);
        if (existing) {
          continue;
        }
        try {
          const { context, embedding } = await this.contextGenerator(question);
          this.prefetchCache.set(question, {
            question,
            context,
            embedding,
            confidence: 0.7,
            prefetchedAt: Date.now()
          });
          cacheWarmed++;
          prefetchedQuestions.push(question);
        } catch {
          console.error(
            `PredictivePrefetcher: Failed to prefetch for "${question.slice(0, 50)}..."`
          );
        }
      }
    } finally {
      this.prefetchInProgress = false;
    }
    return {
      questions: prefetchedQuestions,
      cacheWarmed,
      latencyMs: Date.now() - startTime,
      interrupted: this.abortController?.signal.aborted || false
    };
  }
  /**
   * Get prefetched context for a question.
   */
  getPrefetchedContext(question, embedding) {
    const result = this.prefetchCache.get(question, embedding);
    return result?.value || null;
  }
  /**
   * Start background prefetching based on current context.
   */
  async startPrefetching() {
    if (this.isUserSpeaking) {
      return {
        questions: [],
        cacheWarmed: 0,
        latencyMs: 0,
        interrupted: true
      };
    }
    const context = {
      phase: this.currentPhase,
      recentQuestions: this.recentQuestions,
      topics: Array.from(this.activeTopics)
    };
    const predictions = this.predictNextQuestions(context);
    const questions = predictions.map((p) => p.question);
    return this.prefetchResponses(questions);
  }
  /**
   * Abort ongoing prefetching.
   */
  abortPrefetching() {
    this.abortController?.abort();
  }
  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return this.prefetchCache.getStats();
  }
  /**
   * Clear prefetch cache.
   */
  clearCache() {
    this.prefetchCache.clear();
  }
  /**
   * Extract topics from question text.
   */
  extractTopics(question) {
    const text = question.toLowerCase();
    const topicKeywords = {
      architecture: ["architecture", "system", "design", "scale"],
      database: ["database", "sql", "nosql", "data", "query"],
      api: ["api", "rest", "graphql", "endpoint"],
      testing: ["test", "testing", "coverage", "qa"],
      leadership: ["team", "lead", "manage", "mentor"],
      conflict: ["conflict", "disagree", "challenge", "difficult"]
    };
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some((kw) => text.includes(kw))) {
        this.activeTopics.add(topic);
      }
    }
  }
};
var predictivePrefetcher = new PredictivePrefetcher();

// rpc-handlers.ts
var parallelContextAssembler = new ParallelContextAssembler();
var predictivePrefetcher2 = new PredictivePrefetcher();
var RpcHandlers = class {
  server;
  constructor(server2) {
    this.server = server2;
    this.configureLLMClient();
  }
  configureLLMClient() {
    const apiKeys = settings.get("apiKeys") || {};
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (key) {
        llmClient.setApiKey(provider, key);
      }
    }
  }
  async handle(method, params) {
    const handlerName = method.replace(/[:.]/g, "_");
    const handler = this[handlerName];
    if (typeof handler === "function") {
      return handler.call(this, params);
    }
    throw new Error(`Unknown method: ${method}`);
  }
  // MARK: - Ping/Pong
  async ping(_params) {
    return "pong";
  }
  // MARK: - Settings
  async settings_get(params) {
    return settings.get(params.key);
  }
  async settings_set(params) {
    settings.set(
      params.key,
      params.value
    );
    if (params.key === "apiKeys") {
      this.configureLLMClient();
    }
    return true;
  }
  async settings_getAll(_params) {
    return settings.getAll();
  }
  // MARK: - App State
  async app_getState(_params) {
    return {
      isUndetectable: settings.get("isUndetectable"),
      disguiseMode: settings.get("disguiseMode"),
      selectedModel: settings.get("selectedModel")
    };
  }
  async app_setUndetectable(params) {
    settings.set("isUndetectable", params.enabled);
    this.server.sendNotification("app:stateChanged", {
      isUndetectable: params.enabled
    });
    return true;
  }
  // MARK: - LLM
  async llm_generate(params) {
    const featureFlags = settings.get("featureFlags") || {};
    const request = {
      messages: params.messages,
      model: params.model || settings.get("selectedModel") || "gpt-4o",
      provider: params.provider || "openai",
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      useCache: params.useCache ?? featureFlags.useEnhancedCache ?? true,
      useCompiler: params.useCompiler ?? featureFlags.usePromptCompiler ?? true
    };
    if (params.stream !== false) {
      let fullResponse = "";
      let tokenCount = 0;
      for await (const token of llmClient.generate(request)) {
        fullResponse += token;
        tokenCount++;
        this.server.sendNotification("llm:token", {
          text: token,
          tokenIndex: tokenCount
        });
      }
      return {
        response: fullResponse,
        tokenCount,
        cached: llmClient.getCacheStats().hitRate > 0
      };
    }
    const result = await llmClient.generateComplete(request);
    return {
      response: result.response,
      cached: result.cached,
      tokensUsed: result.tokensUsed,
      compressionRatio: result.compressionRatio,
      latencyMs: result.latencyMs,
      timeToFirstToken: result.timeToFirstToken
    };
  }
  async llm_generateComplete(params) {
    return this.llm_generate({ ...params, stream: false });
  }
  async llm_clearCache(_params) {
    llmClient.clearCache();
    return true;
  }
  async llm_getStats(_params) {
    return llmClient.getStats();
  }
  // MARK: - Cache
  async cache_getStats(_params) {
    return {
      response: responseCache.getStats(),
      embedding: embeddingCache.getStats(),
      llm: llmClient.getCacheStats()
    };
  }
  async cache_clear(params) {
    const type = params.type || "all";
    if (type === "response" || type === "all") {
      responseCache.clear();
    }
    if (type === "embedding" || type === "all") {
      embeddingCache.clear();
    }
    if (type === "all") {
      llmClient.clearCache();
    }
    return true;
  }
  async cache_resetStats(_params) {
    responseCache.resetStats();
    embeddingCache.resetStats();
    llmClient.resetStats();
    return true;
  }
  // MARK: - Embedding
  async embedding_generate(params) {
    const cached = embeddingCache.get(params.text);
    if (cached) {
      return {
        embedding: cached.value,
        latencyMs: 0,
        cached: true
      };
    }
    const startTime = Date.now();
    const embedding = [];
    const latencyMs = Date.now() - startTime;
    embeddingCache.set(params.text, embedding);
    return {
      embedding,
      latencyMs,
      cached: false
    };
  }
  // MARK: - Context Assembly
  async context_assemble(params) {
    const sources = params.sources.map((source) => ({
      type: source.type,
      priority: source.priority,
      maxChunks: 10,
      fetch: async () => {
        return [{
          id: `mock-${source.type}-1`,
          content: `Mock content for ${source.type}`,
          type: source.type,
          timestamp: Date.now(),
          tokenCount: 50
        }];
      }
    }));
    const query = params.query || "default query";
    const assembled = await parallelContextAssembler.assemble(sources, params.budget, query);
    return assembled;
  }
  // MARK: - Predictive Prefetching
  async prefetch_predict(params) {
    const questions = predictivePrefetcher2.predictNextQuestions(params);
    return { questions };
  }
  async prefetch_warm(params) {
    const startTime = Date.now();
    await predictivePrefetcher2.prefetchResponses(params.questions);
    const latencyMs = Date.now() - startTime;
    return {
      warmed: params.questions.length,
      latencyMs
    };
  }
  async prefetch_getStats(_params) {
    return {
      cache: predictivePrefetcher2.getCacheStats(),
      predictions: {
        totalPredictions: 0,
        // Would track in production
        successfulPrefetches: 0,
        cacheHits: 0
      }
    };
  }
};

// main.ts
var JsonRpcServer = class {
  handlers;
  rl;
  constructor() {
    this.handlers = new RpcHandlers(this);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => {
      console.error("[Backend] stdin closed, exiting");
      process.exit(0);
    });
    console.error("[Backend] JSON-RPC server started");
  }
  async handleLine(line) {
    if (!line.trim())
      return;
    try {
      const request = JSON.parse(line);
      await this.handleRequest(request);
    } catch (error) {
      console.error("[Backend] Parse error:", error);
    }
  }
  async handleRequest(request) {
    const { id, method, params } = request;
    try {
      const result = await this.handlers.handle(method, params || {});
      if (id !== void 0) {
        this.sendResponse({ jsonrpc: "2.0", id, result });
      }
    } catch (error) {
      if (id !== void 0) {
        this.sendResponse({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32e3,
            message: error instanceof Error ? error.message : "Unknown error"
          }
        });
      }
    }
  }
  sendResponse(response) {
    console.log(JSON.stringify(response));
  }
  sendNotification(method, params) {
    console.log(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
};
var server = new JsonRpcServer();
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
