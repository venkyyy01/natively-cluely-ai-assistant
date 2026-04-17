export type ConsciousModeResponseMode = 'reasoning_first' | 'invalid';

export const CONSCIOUS_MODE_SCHEMA_VERSION = 'conscious_mode_v1' as const;

export const CONSCIOUS_MODE_RESPONSE_FIELDS = [
  'schemaVersion',
  'mode',
  'openingReasoning',
  'implementationPlan',
  'tradeoffs',
  'edgeCases',
  'scaleConsiderations',
  'pushbackResponses',
  'likelyFollowUps',
  'codeTransition',
] as const;

export const CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS = `RESPONSE SCHEMA VERSION: ${CONSCIOUS_MODE_SCHEMA_VERSION}

Return ONLY valid JSON with these canonical keys:
{
  "schemaVersion": "${CONSCIOUS_MODE_SCHEMA_VERSION}",
  "mode": "reasoning_first",
  "openingReasoning": "string",
  "implementationPlan": ["string"],
  "tradeoffs": ["string"],
  "edgeCases": ["string"],
  "scaleConsiderations": ["string"],
  "pushbackResponses": ["string"],
  "likelyFollowUps": ["string"],
  "codeTransition": "string"
}

Canonical field rules:
- schemaVersion SHOULD be "${CONSCIOUS_MODE_SCHEMA_VERSION}".
- mode MUST be "reasoning_first".
- openingReasoning is the first spoken sentence or two.
- Array fields MUST be arrays of concise strings. Use [] when empty.
- codeTransition MUST be a string. Use "" when no code bridge is needed.`;

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

const BEHAVIORAL_ACTIONABLE_QUESTION_PATTERNS = [
  /^tell me about a time\b/i,
  /^describe a situation\b/i,
  /^share an experience\b/i,
  /^how do you handle\b/i,
  /\bleadership\b/i,
  /\bconflict\b/i,
  /\bdisagreement\b/i,
  /\bfeedback\b/i,
  /\bfailure\b/i,
  /\bmistake\b/i,
  /\bteam challenge\b/i,
  /\bculture\b/i,
  /\bvalues\b/i,
  /\bmentor\b/i,
  /\bstakeholder\b/i,
];

function isBehavioralActionableQuestion(lower: string): boolean {
  return BEHAVIORAL_ACTIONABLE_QUESTION_PATTERNS.some((pattern) => pattern.test(lower));
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

function normalizePushbackResponses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeList(value);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([concern, response]) => {
        const normalizedResponse = normalizeText(response);
        return normalizedResponse ? `${normalizeText(concern)}: ${normalizedResponse}` : '';
      })
      .filter(Boolean);
  }

  return normalizeList(value);
}

function normalizeCodeTransition(value: unknown, codeBlock: unknown): string {
  const direct = normalizeText(value);
  if (direct) {
    return direct;
  }

  if (!codeBlock || typeof codeBlock !== 'object') {
    return '';
  }

  const block = codeBlock as { language?: unknown; code?: unknown };
  const code = normalizeText(block.code);
  if (!code) {
    return '';
  }

  const language = normalizeText(block.language);
  return `Here is the code path I would walk through:\n\`\`\`${language}\n${code}\n\`\`\``;
}

export function normalizeConsciousModeResponse(value: (Partial<ConsciousModeStructuredResponse> & {
  schemaVersion?: unknown;
  spokenResponse?: unknown;
  codeBlock?: unknown;
  pushbackResponses?: unknown;
}) | null | undefined): ConsciousModeStructuredResponse {
  const hasCanonicalMode = value?.mode === 'reasoning_first';
  const hasAdaptableLegacyPayload = Boolean(
    normalizeText(value?.openingReasoning) ||
    normalizeText(value?.spokenResponse) ||
    normalizeList(value?.implementationPlan).length ||
    normalizeList(value?.tradeoffs).length ||
    normalizeCodeTransition(value?.codeTransition, value?.codeBlock)
  );
  const mode = hasCanonicalMode || hasAdaptableLegacyPayload ? 'reasoning_first' : 'invalid';
  const openingReasoning = normalizeText(value?.openingReasoning) || normalizeText(value?.spokenResponse);
  return {
    mode,
    openingReasoning,
    implementationPlan: normalizeList(value?.implementationPlan),
    tradeoffs: normalizeList(value?.tradeoffs),
    edgeCases: normalizeList(value?.edgeCases),
    scaleConsiderations: normalizeList(value?.scaleConsiderations),
    pushbackResponses: normalizePushbackResponses(value?.pushbackResponses),
    likelyFollowUps: normalizeList(value?.likelyFollowUps),
    codeTransition: normalizeCodeTransition(value?.codeTransition, value?.codeBlock),
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
  return [label, ...values.map(value => `- ${value}`)];
}

export function formatConsciousModeResponseChunks(response: ConsciousModeStructuredResponse): string[] {
  const chunks: string[] = [];

  if (response.openingReasoning) {
    chunks.push(`Opening reasoning: ${response.openingReasoning}`);
  }

  chunks.push(formatSection('Implementation plan:', response.implementationPlan).join('\n'));
  chunks.push(formatSection('Tradeoffs:', response.tradeoffs).join('\n'));
  chunks.push(formatSection('Edge cases:', response.edgeCases).join('\n'));
  chunks.push(formatSection('Scale considerations:', response.scaleConsiderations).join('\n'));
  chunks.push(formatSection('Pushback responses:', response.pushbackResponses).join('\n'));
  chunks.push(formatSection('Likely follow-ups:', response.likelyFollowUps).join('\n'));
  chunks.push(response.codeTransition ? `Code transition: ${response.codeTransition}` : 'Code transition:');

  return chunks.filter(Boolean);
}

export function formatConsciousModeResponse(response: ConsciousModeStructuredResponse): string {
  return formatConsciousModeResponseChunks(response).join('\n').trim();
}

export function tryParseConsciousModeOpeningReasoning(raw: string): string | null {
  const match = raw.match(/"openingReasoning"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) {
    return null;
  }

  try {
    return normalizeText(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

function isQuestionLike(lower: string): boolean {
  return /\?$/.test(lower) || /^(how|what|why|when|where|which|who|can|could|would|walk me through|tell me)/i.test(lower);
}

function isSubstantialConversationTurn(lower: string): boolean {
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (isAdministrativePrompt(lower)) return false;
  return isBroadConsciousSeed(lower) || /^(let me (walk through|start with|explain|show)|walk me through|switch gears and talk about)/i.test(lower);
}

function isBroadConsciousSeed(lower: string): boolean {
  return /(design|architecture|component|service|database|api|scale|scaling|throughput|latency|tradeoff|failure|retry|cache|queue|shard|replica|microservice|monolith|algorithm|data structure|complexity|optimi[sz]e|partition|failover|bottleneck|consistency|availability|backpressure|hotspot|rate limiter|data model|ledger|notification system|streaming system|distributed)/i.test(lower);
}

function isBehavioralPrompt(lower: string): boolean {
  return /(tell me about a time|describe a situation|share an experience|leadership|conflict|mentor|stakeholder|failure|mistake|team challenge|culture|values)/i.test(lower);
}

function isAdministrativePrompt(lower: string): boolean {
  return /(repeat that|say that again|calendar invite|sounds good|okay|ok|got it|fine|warmup is done|done already|all set)/i.test(lower);
}

function isSystemDesignQuestion(lower: string): boolean {
  return /(^how would you design\b|\bsystem design\b|\barchitect\b|\bhigh[- ]level design\b|\bdistributed system\b|\brate limiter\b|\bpartition\b|\bmonolith to microservices\b|\bmigrate a monolith\b|\bdesign the data model\b|\bdesign a .*system\b|\bdesign an .*system\b|\bdesign the .*system\b|\bdesign a .*service\b|\bdesign an .*service\b|\bdesign the .*service\b)/i.test(lower);
}

function isQuestionContinuationPhrase(lower: string): boolean {
  return /^(what are the tradeoffs\??|how would you shard this\??|what happens during failover\??|what metrics would you watch( first)?\??)$/i.test(lower);
}

function isColdStartContinuationPhrase(lower: string): boolean {
  return /^(what are the tradeoffs\??|how would you shard this\??)$/i.test(lower);
}

function isExplicitTopicShift(lower: string): boolean {
  return /(switch gears|talk about the launch plan|talk about launch|move on to|different topic|new topic|let(?:'s| us) talk about)/i.test(lower);
}

function isShortActionablePrompt(lower: string): boolean {
  return /^(why this approach|why this|why not|how so|go deeper|can you go deeper|walk me through that|talk through that|and then|what about reliability|what about scale|what about failure handling|what about bottlenecks)$/i.test(lower);
}

function isActionableInterviewerPrompt(lower: string): boolean {
  if (isAdministrativePrompt(lower)) {
    return false;
  }

  const words = lower.split(/\s+/).filter(Boolean);
  if (isShortActionablePrompt(lower)) {
    return true;
  }

  return (isQuestionLike(lower) && words.length >= 4) || isBroadConsciousSeed(lower);
}

export function classifyConsciousModeQuestion(
  question: string | null | undefined,
  activeThread: ReasoningThread | null,
): ConsciousModeQuestionRoute {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    return { qualifies: false, threadAction: 'ignore' };
  }

  const lower = normalizedQuestion.toLowerCase();
  const questionLike = isQuestionLike(lower);
  const systemDesignQuestion = isSystemDesignQuestion(lower);
  const explicitContinuation = isQuestionContinuationPhrase(lower);
  const behavioralQuestion = isBehavioralActionableQuestion(lower);

  if (behavioralQuestion) {
    if (activeThread) {
      return { qualifies: true, threadAction: 'reset' };
    }

    return { qualifies: true, threadAction: 'start' };
  }

  if (activeThread) {
    if (explicitContinuation) {
      return { qualifies: true, threadAction: 'continue' };
    }

    if (questionLike && systemDesignQuestion) {
      return { qualifies: true, threadAction: 'reset' };
    }

    if (isExplicitTopicShift(lower)) {
      return { qualifies: true, threadAction: 'reset' };
    }

    if (((questionLike && normalizedQuestion.split(/\s+/).length >= 3) || isSubstantialConversationTurn(lower)) && !isAdministrativePrompt(lower)) {
      return { qualifies: true, threadAction: 'continue' };
    }

    return { qualifies: false, threadAction: 'ignore' };
  }

  if ((systemDesignQuestion || isColdStartContinuationPhrase(lower) || (isSubstantialConversationTurn(lower) && !questionLike)) && !isAdministrativePrompt(lower)) {
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
    const lower = trimmed.toLowerCase();
    return classifyConsciousModeQuestion(trimmed, activeReasoningThread).qualifies
      || isSubstantialConversationTurn(lower)
      || isActionableInterviewerPrompt(lower);
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
  console.log('[AUTO-TRIGGER] 🔍 Processing transcript:', {
    speaker: input.speaker,
    final: input.final,
    textLength: input.text.length,
    textPreview: input.text.substring(0, 50) + (input.text.length > 50 ? '...' : ''),
    consciousMode: input.consciousModeEnabled,
    confidence: input.confidence,
    hasIntelligenceManager: !!input.intelligenceManager
  });
  
  if (input.speaker !== 'interviewer') {
    console.log(`[AUTO-TRIGGER] ❌ Rejected: speaker is "${input.speaker}", need "interviewer"`);
    return false;
  }
  
  if (!input.final) {
    console.log('[AUTO-TRIGGER] ❌ Rejected: transcript not final (interim transcript)');
    return false;
  }

  const activeThread = input.intelligenceManager.getActiveReasoningThread();
  console.log(`[AUTO-TRIGGER] 🧠 Active reasoning thread: ${!!activeThread}`);
  
  const decision = getTranscriptSuggestionDecision(
    input.text,
    input.consciousModeEnabled,
    activeThread,
  );

  console.log('[AUTO-TRIGGER] 📊 Decision analysis:', {
    shouldTrigger: decision.shouldTrigger,
    lastQuestion: decision.lastQuestion.substring(0, 50) + (decision.lastQuestion.length > 50 ? '...' : ''),
    questionLength: decision.lastQuestion.length,
    hasActiveThread: !!activeThread,
    consciousModeEnabled: input.consciousModeEnabled
  });

  if (!decision.shouldTrigger) {
    console.log('[AUTO-TRIGGER] ❌ Decision logic declined to trigger');
    return false;
  }

  try {
    const context = input.intelligenceManager.getFormattedContext(180);
    console.log(`[AUTO-TRIGGER] 📝 Context length: ${context ? context.length : 0} chars`);
    console.log('[AUTO-TRIGGER] 🚀 Calling handleSuggestionTrigger...');
    
    await input.intelligenceManager.handleSuggestionTrigger({
      context: context,
      lastQuestion: decision.lastQuestion,
      confidence: input.confidence ?? 0.8,
    });
    
    console.log('[AUTO-TRIGGER] ✅ Successfully triggered LLM response');
    return true;
  } catch (error) {
    console.error('[AUTO-TRIGGER] 🚨 Failed to trigger:', error);
    return false;
  }
}
