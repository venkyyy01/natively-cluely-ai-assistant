// electron/llm/postProcessor.ts
// Hard post-processing clamp to enforce constraints
// Even if Gemini misbehaves, this ensures clean output

import { ValidationResult, ResponseQuality } from './types';
import { LLM_SPEAK_BLOCKLIST } from './prompts';

/**
 * Filler phrases to strip from end of responses
 */
const FILLER_PHRASES = [
    "I hope this helps",
    "Let me know if you",
    "Feel free to",
    "Does that make sense",
    "Is there anything else",
    "Hope that answers",
    "Let me know if you have",
    "I'd be happy to",
];

/**
 * Prefixes to strip from start of responses
 */
const PREFIXES = [
    "Refined (rephrase):",
    "Refined (shorten):",
    "Refined (expand):",
    "Refined answer:",
    "Refined:",
    "Answer:",
    "Response:",
    "Suggestion:",
    "Here is the answer:",
    "Here is the refined answer:",
];

/**
 * Clamp response to strict interview copilot constraints
 * @param text - Raw LLM response
 * @param maxSentences - Maximum sentences allowed (default 3)
 * @param maxWords - Maximum words allowed (default 60)
 * @returns Clean, clamped plain text
 */
export function clampResponse(
    text: string,
    maxSentences: number = 3,
    maxWords: number = 60
): string {
    if (!text || typeof text !== "string") {
        return "";
    }

    let result = text.trim();

    // Step 1: Strip markdown
    result = stripMarkdown(result);

    // Step 2: Strip prefixes (labels)
    result = stripPrefixes(result);

    // Step 3: Remove filler phrases from end
    result = stripFillerPhrases(result);

    // CRITICAL: If code blocks were found (preserved from stripMarkdown), DO NOT CLAMP.
    // Code answers need to be full length.
    const hasCodeBlocks = /```/.test(result);

    if (!hasCodeBlocks) {
        // Step 4: Enforce sentence limit (only for prose)
        result = limitSentences(result, maxSentences);

        // Step 5: Enforce word limit (only for prose)
        result = limitWords(result, maxWords);
    }

    // Step 6: Final cleanup
    result = result.trim();

    return result;
}

/**
 * Strip all markdown formatting
 */
/**
 * Strip all markdown formatting but PRESERVE code blocks
 */
function stripMarkdown(text: string): string {
    const codeBlocks: string[] = [];
    let result = text;

    // NAT-047 follow-up: the previous placeholder `__CODE_BLOCK_${i}__`
    // looked like markdown bold/italic and was being mangled by the
    // italic-stripping regex below (the underscores around BLOCK and N
    // matched `_text_`), producing things like `_CODEBLOCK0_` and
    // permanently dropping the code fence on restore. Use a non-printable
    // ASCII control-character sentinel pair (\u0002 ... \u0003) that no
    // markdown rule will ever touch.
    const codeBlockSentinel = (i: number): string => `\u0002CODEBLOCK${i}\u0003`;

    // Extract code blocks to protect them
    result = result.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return codeBlockSentinel(codeBlocks.length - 1);
    });

    // Remove headers (# ## ### etc.)
    result = result.replace(/^#{1,6}\s+/gm, "");

    // Remove bold (**text** or __text__)
    result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
    result = result.replace(/__([^_]+)__/g, "$1");

    // Remove italic (*text* or _text_)
    result = result.replace(/\*([^*]+)\*/g, "$1");
    result = result.replace(/_([^_]+)_/g, "$1");

    // Remove inline code (`text`) - keep content
    result = result.replace(/`([^`]+)`/g, "$1");

    // Remove bullet points (-, *, •)
    result = result.replace(/^[\s]*[-*•]\s+/gm, "");

    // Remove numbered lists
    result = result.replace(/^[\s]*\d+\.\s+/gm, "");

    // Remove blockquotes
    result = result.replace(/^>\s+/gm, "");

    // Remove horizontal rules
    result = result.replace(/^[-*_]{3,}$/gm, "");

    // Remove links [text](url) -> text
    result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    // NAT-047 / audit A-13: previously this branch ran
    //   result = result.replace(/\n+/g, " ");
    //   result = result.replace(/\s+/g, " ");
    // which collapsed *every* newline into a single space, destroying
    // paragraph structure for prose answers and producing wall-of-text
    // output. The fix preserves blank-line paragraph breaks while still
    // collapsing wrap-induced single newlines (and trailing whitespace)
    // into spaces. Code fences are already extracted to placeholders
    // above, so this transformation never touches code formatting.
    //
    // Algorithm:
    //   1. Normalize CRLF and strip trailing whitespace per line, so
    //      "foo  \nbar" doesn't get treated as a structural break.
    //   2. Hold paragraph breaks (>=2 newlines) in a sentinel.
    //   3. Replace remaining single newlines with a space (line wrap).
    //   4. Restore the sentinel as exactly one blank line.
    //   5. Collapse runs of in-line whitespace (spaces/tabs only) so we
    //      never re-collapse paragraph breaks.
    result = result.replace(/\r\n/g, "\n");
    result = result.replace(/[ \t]+\n/g, "\n");
    const PARAGRAPH_SENTINEL = "\u0001PARA\u0001";
    result = result.replace(/\n{2,}/g, PARAGRAPH_SENTINEL);
    result = result.replace(/\n/g, " ");
    result = result.replace(new RegExp(PARAGRAPH_SENTINEL, "g"), "\n\n");
    result = result.replace(/[ \t]+/g, " ");

    // Restore code blocks (using markdown-inert sentinel from above).
    // Add newlines around them for better formatting.
    codeBlocks.forEach((block, index) => {
        result = result.replace(codeBlockSentinel(index), `\n${block}\n`);
    });

    return result.trim();
}

/**
 * Remove trailing filler phrases that add no value
 */
function stripFillerPhrases(text: string): string {
    let result = text;

    for (const phrase of FILLER_PHRASES) {
        const regex = new RegExp(`[.!?]?\\s*${phrase}[^.!?]*[.!?]?\\s*$`, "i");
        result = result.replace(regex, ".");
    }

    // Clean up trailing punctuation issues
    result = result.replace(/\.+$/, ".");
    result = result.replace(/\s+\.$/, ".");

    return result.trim();
}

/**
 * Limit to N sentences
 */
function limitSentences(text: string, maxSentences: number): string {
    // Split on sentence boundaries (., !, ?)
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    if (sentences.length <= maxSentences) {
        return text;
    }

    // Take first N sentences
    return sentences.slice(0, maxSentences).join(" ").trim();
}

/**
 * Limit to N words
 */
function limitWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);

    if (words.length <= maxWords) {
        return text;
    }

    // Take first N words
    let result = words.slice(0, maxWords).join(" ");

    // Try to end at a sentence boundary
    const lastPunctuation = result.search(/[.!?][^.!?]*$/);
    if (lastPunctuation > result.length * 0.6) {
        result = result.substring(0, lastPunctuation + 1);
    } else {
        // Add ellipsis if we cut mid-sentence
        result = result.replace(/[,;:]?\s*$/, "...");
    }

    return result.trim();
}

/**
 * Clamp response length but PRESERVE markdown formatting.
 * The UI renders markdown, so we only enforce sentence/word limits.
 * For non-code responses only - code blocks skip clamping.
 */
export function clampProseResponse(
    text: string,
    maxSentences: number = 8,
    maxWords: number = 200
): string {
    if (!text || typeof text !== "string") {
        return "";
    }

    let result = text.trim();

    // Strip prefixes
    result = stripPrefixes(result);

    // Remove filler phrases from end
    result = stripFillerPhrases(result);

    // If code blocks present, don't clamp length
    const hasCodeBlocks = /```[\s\S]*?```/.test(result);
    if (hasCodeBlocks) {
        return result.trim();
    }

    // Sentence limit (operates on markdown text directly - fine for cutting)
    const sentences = result.match(/[^.!?]+[.!?]+/g) || [result];
    if (sentences.length > maxSentences) {
        result = sentences.slice(0, maxSentences).join(' ').trim();
    }

    // Word limit (approximate - markdown tokens add ~10% overhead, acceptable)
    const words = result.split(/\s+/);
    if (words.length > maxWords) {
        result = words.slice(0, maxWords).join(' ').replace(/[,;:]?\s*$/, '...');
    }

    return result.trim();
}

/**
 * Validate response meets constraints
 * Returns true if valid, false if clamping was needed
 */
export function validateResponse(
    text: string,
    maxSentences: number = 3,
    maxWords: number = 60
): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for markdown
    if (/[#*_`]/.test(text)) {
        issues.push("Contains markdown");
    }

    // Check sentence count
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    if (sentences.length > maxSentences) {
        issues.push(`Too many sentences (${sentences.length}/${maxSentences})`);
    }

    // Check word count
    const words = text.split(/\s+/);
    if (words.length > maxWords) {
        issues.push(`Too many words (${words.length}/${maxWords})`);
    }

    return {
        valid: issues.length === 0,
        issues,
    };
}

/**
 * Strip common prefixes/labels
 */
function stripPrefixes(text: string): string {
    let result = text;
    for (const prefix of PREFIXES) {
        if (result.toLowerCase().startsWith(prefix.toLowerCase())) {
            result = result.substring(prefix.length).trim();
        }
    }
    // Handle "Refined (...):" regex pattern
    result = result.replace(/^Refined \([^)]+\):\s*/i, "");

    return result.trim();
}

/**
 * Validate response quality against MIT Pyramid structure and constraints
 */
export function validateResponseQuality(response: string): ValidationResult {
  const sentences = splitIntoSentences(response);
  const violations: string[] = [];
  
  // Sentence limit check
  if (sentences.length > 2) {
    violations.push(`Too many sentences: ${sentences.length}/2`);
  }
  
  // Word limit per sentence
  let maxWordsPerSentence = 0;
  sentences.forEach((sentence, i) => {
    const wordCount = sentence.trim().split(/\s+/).length;
    maxWordsPerSentence = Math.max(maxWordsPerSentence, wordCount);
    if (wordCount > 25) {
      violations.push(`Sentence ${i+1} too long: ${wordCount}/25 words`);
    }
  });
  
  // Anti-pattern check
  const blockedPhrases = LLM_SPEAK_BLOCKLIST.filter(phrase => 
    response.toLowerCase().includes(phrase.toLowerCase())
  );
  if (blockedPhrases.length > 0) {
    violations.push(`Contains AI-speak: ${blockedPhrases.slice(0, 2).join(', ')}`);
  }
  
  // Estimate speaking time (150 words per minute average)
  const totalWords = response.split(/\s+/).length;
  const estimatedSpeakingTime = (totalWords / 150) * 60; // seconds
  
  return {
    isValid: violations.length === 0,
    violations,
    regenerationHint: violations.length > 0 ? generateRewriteHint(violations) : undefined,
    metrics: {
      sentenceCount: sentences.length,
      maxWordsPerSentence,
      estimatedSpeakingTime
    }
  };
}

function splitIntoSentences(text: string): string[] {
  // Simple sentence splitting - can be enhanced
  return text.split(/[.!?]+/).filter(s => s.trim().length > 0);
}

function generateRewriteHint(violations: string[]): string {
  const hints = [];
  
  if (violations.some(v => v.includes('Too many sentences'))) {
    hints.push('Combine or remove sentences');
  }
  
  if (violations.some(v => v.includes('too long'))) {
    hints.push('Shorten sentences to under 25 words each');
  }
  
  if (violations.some(v => v.includes('AI-speak'))) {
    hints.push('Remove conversational fluff phrases');
  }
  
  return `Rewrite to fix: ${hints.join(', ')}`;
}

/**
 * Log validation metrics for monitoring and debugging
 */
export function logValidationMetrics(validation: ValidationResult, prompt: string): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('Response Validation Metrics:', {
      isValid: validation.isValid,
      violations: validation.violations,
      sentenceCount: validation.metrics.sentenceCount,
      maxWordsPerSentence: validation.metrics.maxWordsPerSentence,
      speakingTime: `${validation.metrics.estimatedSpeakingTime.toFixed(1)}s`,
      promptType: detectPromptType(prompt)
    });
  }
}

function detectPromptType(prompt: string): string {
  if (prompt.includes('coding') || prompt.includes('algorithm')) return 'technical';
  if (prompt.includes('define') || prompt.includes('what is')) return 'definition';
  return 'general';
}
