import type { AnswerRoute } from '../latency/AnswerLatencyTracker';

export interface ConsciousQuestionResolution {
  question: string | null;
  rejectedCandidates: string[];
}

export interface ConsciousCandidateValidationInput {
  answer: string;
  question: string;
  route: AnswerRoute;
  imagePaths?: string[];
}

export interface ConsciousCandidateValidationResult {
  ok: boolean;
  reasons: string[];
}

const PLACEHOLDER_QUESTIONS = new Set([
  'undefined',
  'null',
  'none',
  'n/a',
  'what to answer',
  'inferred',
]);

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeConsciousQuestionCandidate(value: string | null | undefined): string | null {
  const normalized = normalizeSpaces(String(value ?? ''));
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  if (PLACEHOLDER_QUESTIONS.has(lower)) {
    return null;
  }

  return normalized;
}

export function resolveConsciousQuestion(candidates: Array<string | null | undefined>): ConsciousQuestionResolution {
  const rejectedCandidates: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeConsciousQuestionCandidate(candidate);
    if (normalized) {
      return { question: normalized, rejectedCandidates };
    }
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      rejectedCandidates.push(String(candidate));
    }
  }

  return { question: null, rejectedCandidates };
}

function looksLikeCodingQuestion(question: string, imagePaths?: string[]): boolean {
  if (imagePaths?.length) {
    return true;
  }

  return /(write|implement|debug|fix|refactor|solve|code|function|typescript|javascript|python|java|sql|query|algorithm|complexity|test case|leetcode|compiler|runtime|stack trace|terminal|snippet)/i.test(question);
}

function looksLikeCodingAnswer(answer: string): boolean {
  const codeSignals = [
    /```/,
    /\bclass\s+Solution\b/,
    /\bdef\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(/,
    /\bfunction\s+[a-zA-Z_$][\w$]*\s*\(/,
    /\bpublic\s+(?:static\s+)?[\w<>\[\]]+\s+\w+\s*\(/,
    /\btime complexity\b/i,
    /\bspace complexity\b/i,
  ];

  return codeSignals.filter((pattern) => pattern.test(answer)).length >= 2;
}

function hasPersonaLeak(answer: string): boolean {
  return /\b(?:i am|i'm|as)\s+(?:chatgpt|an ai|a large language model|an openai model)\b/i.test(answer)
    || /\bopenai\b/i.test(answer) && /\b(?:model|assistant|chatgpt)\b/i.test(answer);
}

function isNoEvidenceFallback(answer: string): boolean {
  return /^(?:there is no data available|i don't have enough (?:data|context|information)|no context available)\.?$/i.test(answer.trim());
}

export function validateConsciousCandidate(input: ConsciousCandidateValidationInput): ConsciousCandidateValidationResult {
  const reasons: string[] = [];
  const answer = normalizeSpaces(input.answer);
  const question = normalizeConsciousQuestionCandidate(input.question);

  if (!question) {
    reasons.push('missing_resolved_question');
  }

  if (answer.length < 5) {
    reasons.push('answer_too_short');
  }

  if (hasPersonaLeak(answer)) {
    reasons.push('persona_leak');
  }

  if (question && isNoEvidenceFallback(answer)) {
    reasons.push('unsupported_no_evidence_fallback');
  }

  if (question && looksLikeCodingAnswer(answer) && !looksLikeCodingQuestion(question, input.imagePaths)) {
    reasons.push('coding_answer_for_non_coding_question');
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
