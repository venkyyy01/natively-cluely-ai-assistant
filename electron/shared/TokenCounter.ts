type ExternalCountFn = (text: string, options?: { model?: string }) => unknown;

function normalizeExternalCount(result: unknown): number | null {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return Math.max(0, Math.round(result));
  }

  if (typeof result === 'object' && result !== null) {
    const asRecord = result as Record<string, unknown>;
    const candidates = [
      asRecord.totalTokens,
      asRecord.tokens,
      asRecord.count,
      asRecord.tokenCount,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return Math.max(0, Math.round(candidate));
      }
    }
  }

  return null;
}

function resolveExternalCounter(): ExternalCountFn | null {
  try {
    const moduleValue = require('toksclare');
    const candidates: unknown[] = [
      moduleValue?.countTokens,
      moduleValue?.count,
      moduleValue?.default?.countTokens,
      moduleValue?.default?.count,
      moduleValue?.default,
      moduleValue,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'function') {
        return candidate as ExternalCountFn;
      }
    }
  } catch {
    // Optional dependency not installed. Fallback heuristic will be used.
  }

  return null;
}

function containsCjk(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

function isCodeHeavy(text: string): boolean {
  if (/```|`[^`]+`/.test(text)) return true;
  if (/[{}();=<>"]/.test(text)) return true;
  return /\b(function|class|const|let|var|import|export|return|async|await|interface|type)\b/i.test(text);
}

function charsPerTokenForModel(modelHint: string): number {
  const hint = modelHint.toLowerCase();

  if (hint.includes(':code') || hint.includes('code')) return 3.2;
  if (hint.includes('claude') || hint.includes('anthropic')) return 3.8;
  if (hint.includes('gpt') || hint.includes('openai') || hint.includes('o1') || hint.includes('o3')) return 4.0;
  if (hint.includes('gemini')) return 4.1;
  if (hint.includes('llama') || hint.includes('mixtral') || hint.includes('gemma') || hint.includes('groq') || hint.includes('ollama')) {
    return 3.7;
  }
  if (hint.includes('cerebras')) return 3.9;
  return 4.0;
}

const externalCounter = resolveExternalCounter();

export class TokenCounter {
  constructor(private readonly defaultModelHint: string = 'generic') {}

  count(text: string, modelHint: string = this.defaultModelHint): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;

    const hint = modelHint.toLowerCase();

    if (externalCounter) {
      try {
        const result = externalCounter(trimmed, { model: hint });
        const normalized = normalizeExternalCount(result);
        if (normalized !== null) {
          return normalized;
        }
      } catch {
        // External tokenizer failed for this model, fallback to heuristic.
      }
    }

    return this.heuristicCount(trimmed, hint);
  }

  estimateCharacterBudget(tokenBudget: number, modelHint: string = this.defaultModelHint): number {
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
      return 0;
    }

    const charsPerToken = charsPerTokenForModel(modelHint.toLowerCase());
    return Math.max(32, Math.ceil(tokenBudget * charsPerToken));
  }

  private heuristicCount(text: string, modelHint: string): number {
    const words = text.split(/\s+/).filter(Boolean).length;
    const punctuationCount = (text.match(/[.,!?;:()[\]{}<>`]/g) || []).length;
    const cjk = containsCjk(text);
    const codeLike = isCodeHeavy(text) || modelHint.includes(':code');

    const charsPerToken = charsPerTokenForModel(codeLike ? `${modelHint}:code` : modelHint);
    const charBased = cjk
      ? Math.ceil(text.length / Math.max(charsPerToken - 1, 2.4))
      : Math.ceil(text.length / charsPerToken);

    const wordMultiplier = codeLike ? 1.45 : 1.33;
    const wordBased = Math.ceil(words * wordMultiplier);

    const punctuationBoost = Math.ceil(punctuationCount / 10);

    return Math.max(charBased, wordBased) + punctuationBoost;
  }
}
