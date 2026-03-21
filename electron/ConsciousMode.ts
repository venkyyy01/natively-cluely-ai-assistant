export type ConsciousModeResponseMode = 'reasoning_first' | 'invalid';

export interface ConsciousModeStructuredResponse {
  mode: ConsciousModeResponseMode;
  openingReasoning: string;
  implementationPlan: string[];
  tradeoffs: string[];
  edgeCases: string[];
  scaleConsiderations: string[];
  pushbackResponses: string[];
  likelyFollowUps: string[];
  codeTransition: string;
}

export interface ReasoningThread {
  rootQuestion: string;
  lastQuestion: string;
  response: ConsciousModeStructuredResponse;
  followUpCount: number;
  updatedAt: number;
}

export type ConsciousModeThreadAction = 'start' | 'continue' | 'reset' | 'ignore';

export interface ConsciousModeQuestionRoute {
  qualifies: boolean;
  threadAction: ConsciousModeThreadAction;
}

export interface TranscriptSuggestionDecision {
  shouldTrigger: boolean;
  lastQuestion: string;
}

export interface TranscriptSuggestionIntelligenceManager {
  getActiveReasoningThread(): ReasoningThread | null;
  getFormattedContext(lastSeconds: number): string;
  handleSuggestionTrigger(trigger: {
    context: string;
    lastQuestion: string;
    confidence: number;
  }): Promise<void>;
}

export interface TranscriptSuggestionInput {
  speaker: string;
  text: string;
  final: boolean;
  confidence?: number;
  consciousModeEnabled: boolean;
  intelligenceManager: TranscriptSuggestionIntelligenceManager;
}

const STOP_WORDS = new Set([
  'a', 'again', 'an', 'and', 'are', 'do', 'for', 'how', 'if', 'in', 'is', 'it', 'me', 'of', 'on',
  'or', 'please', 'the', 'their', 'them', 'this', 'through', 'to', 'what', 'why', 'with', 'would',
  'you', 'your'
]);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(normalizeText).filter(Boolean)));
  }

  const text = normalizeText(value);
  return text ? [text] : [];
}

export function createEmptyConsciousModeResponse(mode: ConsciousModeResponseMode = 'reasoning_first'): ConsciousModeStructuredResponse {
  return {
    mode,
    openingReasoning: '',
    implementationPlan: [],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  };
}

export function normalizeConsciousModeResponse(value: Partial<ConsciousModeStructuredResponse> | null | undefined): ConsciousModeStructuredResponse {
  const mode = value?.mode === 'reasoning_first' ? 'reasoning_first' : 'invalid';
  return {
    mode,
    openingReasoning: normalizeText(value?.openingReasoning),
    implementationPlan: normalizeList(value?.implementationPlan),
    tradeoffs: normalizeList(value?.tradeoffs),
    edgeCases: normalizeList(value?.edgeCases),
    scaleConsiderations: normalizeList(value?.scaleConsiderations),
    pushbackResponses: normalizeList(value?.pushbackResponses),
    likelyFollowUps: normalizeList(value?.likelyFollowUps),
    codeTransition: normalizeText(value?.codeTransition),
  };
}

export function isValidConsciousModeResponse(response: ConsciousModeStructuredResponse | null | undefined): response is ConsciousModeStructuredResponse {
  if (!response || response.mode !== 'reasoning_first') {
    return false;
  }

  return Boolean(
    response.openingReasoning ||
    response.implementationPlan.length ||
    response.tradeoffs.length ||
    response.edgeCases.length ||
    response.scaleConsiderations.length ||
    response.pushbackResponses.length ||
    response.likelyFollowUps.length ||
    response.codeTransition
  );
}

export function parseConsciousModeResponse(raw: string): ConsciousModeStructuredResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    return createEmptyConsciousModeResponse('invalid');
  }

  const jsonCandidate = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const normalized = normalizeConsciousModeResponse(JSON.parse(jsonCandidate));
    return isValidConsciousModeResponse(normalized)
      ? normalized
      : createEmptyConsciousModeResponse('invalid');
  } catch {
    return createEmptyConsciousModeResponse('invalid');
  }
}

function mergeList(base: string[], incoming: string[]): string[] {
  return Array.from(new Set([...base, ...incoming].filter(Boolean)));
}

export function mergeConsciousModeResponses(
  base: ConsciousModeStructuredResponse,
  incoming: ConsciousModeStructuredResponse,
): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: incoming.openingReasoning || base.openingReasoning,
    implementationPlan: mergeList(base.implementationPlan, incoming.implementationPlan),
    tradeoffs: mergeList(base.tradeoffs, incoming.tradeoffs),
    edgeCases: mergeList(base.edgeCases, incoming.edgeCases),
    scaleConsiderations: mergeList(base.scaleConsiderations, incoming.scaleConsiderations),
    pushbackResponses: mergeList(base.pushbackResponses, incoming.pushbackResponses),
    likelyFollowUps: mergeList(base.likelyFollowUps, incoming.likelyFollowUps),
    codeTransition: incoming.codeTransition || base.codeTransition,
  };
}

function formatSection(label: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return [label, ...values.map(value => `- ${value}`)];
}

export function formatConsciousModeResponse(response: ConsciousModeStructuredResponse): string {
  const lines: string[] = [];

  if (response.openingReasoning) {
    lines.push(`Opening reasoning: ${response.openingReasoning}`);
  }

  lines.push(...formatSection('Implementation plan:', response.implementationPlan));
  lines.push(...formatSection('Tradeoffs:', response.tradeoffs));
  lines.push(...formatSection('Edge cases:', response.edgeCases));
  lines.push(...formatSection('Scale considerations:', response.scaleConsiderations));
  lines.push(...formatSection('Pushback responses:', response.pushbackResponses));
  lines.push(...formatSection('Likely follow-ups:', response.likelyFollowUps));

  if (response.codeTransition) {
    lines.push(`Code transition: ${response.codeTransition}`);
  }

  return lines.join('\n').trim();
}

function tokenizeQuestion(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

function countTopicOverlap(currentQuestion: string, rootQuestion: string): number {
  const currentTokens = new Set(tokenizeQuestion(currentQuestion));
  const rootTokens = new Set(tokenizeQuestion(rootQuestion));

  let overlap = 0;
  for (const token of currentTokens) {
    if (rootTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function isQuestionLike(lower: string): boolean {
  return /\?$/.test(lower) || /^(how|what|why|when|where|which|who|can|could|would|walk me through|tell me)/i.test(lower);
}

function isTechnicalQuestion(lower: string): boolean {
  return /(how would you|walk me through|design|implement|build|architect|migrate|optimize|debug|approach would you take|how do you)/i.test(lower);
}

function isQuestionContinuationPhrase(lower: string): boolean {
  return /(walk me through your thinking again|walk through your thinking again|walk me through your thinking|why this approach|why this|what are the tradeoffs|what if .*|edge cases|failure modes|how would this scale|how does this scale|what metrics would you watch first|which metrics would you watch first)/i.test(lower);
}

function isGenericPushback(lower: string): boolean {
  return /^what if\??$/i.test(lower);
}

function isStandaloneSpecPushback(lower: string): boolean {
  return /^(why this approach\??|what are the tradeoffs\??|what if this scales\??|what if the input is 10x larger\??)$/i.test(lower);
}

function isExplicitTopicShift(lower: string): boolean {
  return /(switch gears|talk about the launch plan|talk about launch|move on to|different topic|new topic)/i.test(lower);
}

export function classifyConsciousModeQuestion(
  question: string | null | undefined,
  activeThread: ReasoningThread | null,
  intent: string | null = null,
): ConsciousModeQuestionRoute {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    return { qualifies: false, threadAction: 'ignore' };
  }

  const lower = normalizedQuestion.toLowerCase();
  const questionLike = isQuestionLike(lower);
  const technicalQuestion = isTechnicalQuestion(lower);
  const overlap = activeThread ? countTopicOverlap(normalizedQuestion, activeThread.rootQuestion) : 0;
  const explicitContinuation = isQuestionContinuationPhrase(lower);
  const codingIntent = intent === 'coding';
  const standaloneSpecPushback = isStandaloneSpecPushback(lower);

  if (activeThread) {
    if (explicitContinuation && (!isGenericPushback(lower) || overlap >= 2 || /again/.test(lower) || standaloneSpecPushback)) {
      return { qualifies: true, threadAction: 'continue' };
    }

    if (questionLike && overlap >= 2) {
      return { qualifies: true, threadAction: 'continue' };
    }

    if (questionLike && (technicalQuestion || codingIntent)) {
      return { qualifies: true, threadAction: 'reset' };
    }

    if (isExplicitTopicShift(lower)) {
      return { qualifies: false, threadAction: 'reset' };
    }

    return { qualifies: false, threadAction: 'ignore' };
  }

  if (questionLike && (technicalQuestion || codingIntent || standaloneSpecPushback)) {
    return { qualifies: true, threadAction: 'start' };
  }

  return { qualifies: false, threadAction: 'ignore' };
}

export function shouldAutoTriggerSuggestionFromTranscript(
  text: string,
  consciousModeEnabled: boolean,
  activeReasoningThread: ReasoningThread | null,
): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }

  if (consciousModeEnabled) {
    return classifyConsciousModeQuestion(trimmed, activeReasoningThread).qualifies;
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return trimmed.endsWith('?') || wordCount >= 5;
}

export function getTranscriptSuggestionDecision(
  text: string,
  consciousModeEnabled: boolean,
  activeReasoningThread: ReasoningThread | null,
): TranscriptSuggestionDecision {
  const lastQuestion = normalizeText(text);
  return {
    shouldTrigger: shouldAutoTriggerSuggestionFromTranscript(lastQuestion, consciousModeEnabled, activeReasoningThread),
    lastQuestion,
  };
}

export async function maybeHandleSuggestionTriggerFromTranscript(
  input: TranscriptSuggestionInput,
): Promise<boolean> {
  if (input.speaker !== 'interviewer' || !input.final) {
    return false;
  }

  const decision = getTranscriptSuggestionDecision(
    input.text,
    input.consciousModeEnabled,
    input.intelligenceManager.getActiveReasoningThread(),
  );

  if (!decision.shouldTrigger) {
    return false;
  }

  await input.intelligenceManager.handleSuggestionTrigger({
    context: input.intelligenceManager.getFormattedContext(180),
    lastQuestion: decision.lastQuestion,
    confidence: input.confidence ?? 0.8,
  });

  return true;
}
