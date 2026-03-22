// node-backend/llm/PromptCompiler.ts

/**
 * PromptCompiler - Optimizes prompts to reduce token usage.
 *
 * Features:
 * - Token estimation using heuristics (4 chars ≈ 1 token)
 * - Whitespace normalization
 * - Abbreviation expansion/contraction
 * - Redundancy removal
 * - Role condensation
 * - Context truncation with smart boundary detection
 *
 * Target: 30-40% token reduction
 */

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompiledPrompt {
  messages: Array<{ role: string; content: string }>;
  estimatedTokens: number;
  compressionRatio: number;
}

export interface CompileOptions {
  /** Maximum tokens allowed for the compiled prompt */
  maxTokens?: number;
  /** Enable whitespace normalization */
  normalizeWhitespace?: boolean;
  /** Enable abbreviation contraction */
  useAbbreviations?: boolean;
  /** Enable redundancy removal */
  removeRedundancy?: boolean;
  /** Enable role condensation (merge consecutive same-role messages) */
  condenseRoles?: boolean;
  /** Provider hint for optimization */
  provider?: 'openai' | 'anthropic' | 'generic';
}

const DEFAULT_OPTIONS: Required<Omit<CompileOptions, 'provider'>> & {
  provider: CompileOptions['provider'];
} = {
  maxTokens: 8192,
  normalizeWhitespace: true,
  useAbbreviations: true,
  removeRedundancy: true,
  condenseRoles: true,
  provider: 'generic',
};

// Common abbreviations for compression
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bfor example\b/gi, 'e.g.'],
  [/\bthat is\b/gi, 'i.e.'],
  [/\bin other words\b/gi, 'i.e.'],
  [/\band so on\b/gi, 'etc.'],
  [/\bet cetera\b/gi, 'etc.'],
  [/\bplease note that\b/gi, 'Note:'],
  [/\bit is important to note that\b/gi, 'Note:'],
  [/\bkeep in mind that\b/gi, 'Note:'],
  [/\bremember that\b/gi, 'Note:'],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\ba large number of\b/gi, 'many'],
  [/\ba small number of\b/gi, 'few'],
  [/\bthe majority of\b/gi, 'most'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bwith regard to\b/gi, 'regarding'],
  [/\bwith respect to\b/gi, 'regarding'],
  [/\bin relation to\b/gi, 'about'],
  [/\bas a result of\b/gi, 'because'],
  [/\bby means of\b/gi, 'by'],
  [/\bin accordance with\b/gi, 'per'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
];

// Redundant phrases to remove
const REDUNDANT_PHRASES = [
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
  /\bhonestly\b/gi,
];

export class PromptCompiler {
  private cache = new Map<string, CompiledPrompt>();
  private readonly maxCacheSize = 100;

  /**
   * Estimate token count using heuristic (4 chars ≈ 1 token)
   * This is a rough estimate that works well for English text.
   */
  estimateTokens(text: string): number {
    // Average of ~4 characters per token for English
    // Punctuation and special chars tend to be single tokens
    const baseEstimate = Math.ceil(text.length / 4);

    // Adjust for whitespace-heavy text
    const whitespaceRatio =
      (text.match(/\s/g)?.length || 0) / Math.max(text.length, 1);
    const whitespaceAdjustment = whitespaceRatio > 0.2 ? 0.9 : 1.0;

    // Adjust for code (more tokens per character due to symbols)
    const codeIndicators = (text.match(/[{}\[\]();:=<>]/g)?.length || 0) / Math.max(text.length, 1);
    const codeAdjustment = codeIndicators > 0.05 ? 1.2 : 1.0;

    return Math.ceil(baseEstimate * whitespaceAdjustment * codeAdjustment);
  }

  /**
   * Compile messages with optimizations.
   */
  compile(messages: Message[], options?: CompileOptions): CompiledPrompt {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Generate cache key
    const cacheKey = this.generateCacheKey(messages, opts);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Calculate original token count
    const originalTokens = messages.reduce(
      (sum, m) => sum + this.estimateTokens(m.content),
      0
    );

    // Apply compressions
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

    // Apply token limit with smart truncation
    if (opts.maxTokens) {
      processedMessages = this.truncateToLimit(processedMessages, opts.maxTokens);
    }

    // Calculate final token count
    const finalTokens = processedMessages.reduce(
      (sum, m) => sum + this.estimateTokens(m.content),
      0
    );

    const result: CompiledPrompt = {
      messages: processedMessages,
      estimatedTokens: finalTokens,
      compressionRatio: originalTokens > 0 ? 1 - finalTokens / originalTokens : 0,
    };

    // Cache the result
    this.cacheResult(cacheKey, result);

    return result;
  }

  /**
   * Normalize whitespace in messages.
   */
  private normalizeWhitespace(messages: Message[]): Message[] {
    return messages.map((m) => ({
      ...m,
      content: m.content
        // Normalize line endings
        .replace(/\r\n/g, '\n')
        // Collapse multiple blank lines into one
        .replace(/\n{3,}/g, '\n\n')
        // Collapse multiple spaces into one
        .replace(/[ \t]+/g, ' ')
        // Remove trailing whitespace from lines
        .replace(/[ \t]+\n/g, '\n')
        // Trim overall
        .trim(),
    }));
  }

  /**
   * Apply abbreviations to reduce token count.
   */
  private applyAbbreviations(messages: Message[]): Message[] {
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
  private removeRedundancy(messages: Message[]): Message[] {
    return messages.map((m) => {
      let content = m.content;
      for (const pattern of REDUNDANT_PHRASES) {
        // Remove the word but keep surrounding space
        content = content.replace(pattern, '');
      }
      // Clean up double spaces
      content = content.replace(/\s{2,}/g, ' ').trim();
      return { ...m, content };
    });
  }

  /**
   * Condense consecutive messages with the same role.
   */
  private condenseRoles(messages: Message[]): Message[] {
    if (messages.length <= 1) return messages;

    const condensed: Message[] = [];
    let current: Message | null = null;

    for (const msg of messages) {
      if (current && current.role === msg.role) {
        // Merge with current
        current.content += '\n\n' + msg.content;
      } else {
        // Start new message
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
  private truncateToLimit(messages: Message[], maxTokens: number): Message[] {
    const result: Message[] = [];
    let usedTokens = 0;

    // Always keep system message if present
    const systemMsg = messages.find((m) => m.role === 'system');
    const otherMsgs = messages.filter((m) => m.role !== 'system');

    if (systemMsg) {
      const systemTokens = this.estimateTokens(systemMsg.content);
      if (systemTokens <= maxTokens * 0.4) {
        // System message can use up to 40% of budget
        result.push(systemMsg);
        usedTokens += systemTokens;
      } else {
        // Truncate system message
        const truncated = this.smartTruncate(
          systemMsg.content,
          Math.floor(maxTokens * 0.4)
        );
        result.push({ ...systemMsg, content: truncated });
        usedTokens += this.estimateTokens(truncated);
      }
    }

    // Process remaining messages in reverse order (most recent first)
    const remainingBudget = maxTokens - usedTokens;
    const reversedMsgs = [...otherMsgs].reverse();
    const selectedMsgs: Message[] = [];

    for (const msg of reversedMsgs) {
      const msgTokens = this.estimateTokens(msg.content);
      if (usedTokens + msgTokens <= maxTokens) {
        selectedMsgs.unshift(msg);
        usedTokens += msgTokens;
      } else if (remainingBudget - usedTokens > 100) {
        // Truncate this message to fit remaining budget
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
  private smartTruncate(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4; // Reverse of token estimation

    if (text.length <= maxChars) {
      return text;
    }

    // Find sentence boundaries near the limit
    const searchWindow = text.substring(0, maxChars + 100);
    const sentenceEnds = /[.!?]\s+/g;
    let lastGoodBreak = maxChars;

    let match;
    while ((match = sentenceEnds.exec(searchWindow)) !== null) {
      if (match.index + match[0].length <= maxChars) {
        lastGoodBreak = match.index + match[0].length;
      }
    }

    // If no sentence break found, try paragraph break
    if (lastGoodBreak === maxChars) {
      const paragraphBreak = text.lastIndexOf('\n\n', maxChars);
      if (paragraphBreak > maxChars * 0.7) {
        lastGoodBreak = paragraphBreak;
      }
    }

    // If still no good break, try line break
    if (lastGoodBreak === maxChars) {
      const lineBreak = text.lastIndexOf('\n', maxChars);
      if (lineBreak > maxChars * 0.8) {
        lastGoodBreak = lineBreak;
      }
    }

    // If still no good break, try word boundary
    if (lastGoodBreak === maxChars) {
      const wordBreak = text.lastIndexOf(' ', maxChars);
      if (wordBreak > maxChars * 0.9) {
        lastGoodBreak = wordBreak;
      }
    }

    return text.substring(0, lastGoodBreak).trim() + '...';
  }

  /**
   * Generate cache key for memoization.
   */
  private generateCacheKey(messages: Message[], opts: CompileOptions): string {
    const contentHash = messages
      .map((m) => `${m.role}:${m.content.substring(0, 100)}`)
      .join('|');
    const optsHash = JSON.stringify(opts);
    return `${contentHash}::${optsHash}`;
  }

  /**
   * Cache compiled result with LRU eviction.
   */
  private cacheResult(key: string, result: CompiledPrompt): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest entry (first key in Map)
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
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
    };
  }
}

// Singleton instance
export const promptCompiler = new PromptCompiler();
