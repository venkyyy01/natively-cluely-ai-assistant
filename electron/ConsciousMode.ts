export type ConsciousModeResponseMode = 'reasoning_first' | 'thoughtflow' | 'invalid';

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

export interface ThoughtFlowTestCase {
  input: string;
  expectedOutput: string;
  category: 'basic' | 'edge' | 'complex' | 'performance' | 'empty_null';
}

export interface ThoughtFlowCodeBlock {
  language: string;
  code: string;
}

export interface ThoughtFlowStructuredResponse {
  mode: 'thoughtflow';
  clarifyingQuestions: string[];
  testCases: ThoughtFlowTestCase[];
  walkthrough: string;
  codeBlock: ThoughtFlowCodeBlock | null;
  spokenIntro: string;
}

export type ConsciousModeResponse = ConsciousModeStructuredResponse | ThoughtFlowStructuredResponse;

export interface ReasoningThread {
  rootQuestion: string;
  lastQuestion: string;
  response: ConsciousModeResponse;
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

export function createEmptyThoughtFlowResponse(): ThoughtFlowStructuredResponse {
  return {
    mode: 'thoughtflow',
    clarifyingQuestions: [],
    testCases: [],
    walkthrough: '',
    codeBlock: null,
    spokenIntro: '',
  };
}

function isThoughtFlowResponse(r: ConsciousModeResponse): r is ThoughtFlowStructuredResponse {
  return r.mode === 'thoughtflow';
}

function isStandardResponse(r: ConsciousModeResponse): r is ConsciousModeStructuredResponse {
  return r.mode === 'reasoning_first';
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

export function isValidConsciousModeResponse(response: ConsciousModeResponse | null | undefined): response is ConsciousModeResponse {
  if (!response || response.mode === 'invalid') {
    return false;
  }

  if (isThoughtFlowResponse(response)) {
    return isValidThoughtFlowResponse(response);
  }

  if (isStandardResponse(response)) {
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
  
  return false;
}

export function parseConsciousModeResponse(raw: string): ConsciousModeResponse {
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
    const parsed = JSON.parse(jsonCandidate);
    
    // Detect ThoughtFlow response by checking for its unique fields
    if (parsed.clarifyingQuestions || parsed.testCases || parsed.walkthrough) {
      return normalizeThoughtFlowResponse(parsed);
    }
    
    // Fall back to standard conscious mode parsing
    const normalized = normalizeConsciousModeResponse(parsed);
    return isValidConsciousModeResponse(normalized)
      ? normalized
      : createEmptyConsciousModeResponse('invalid');
  } catch {
    return createEmptyConsciousModeResponse('invalid');
  }
}

function normalizeThoughtFlowResponse(parsed: any): ThoughtFlowStructuredResponse {
  const clarifyingQuestions = normalizeList(parsed.clarifyingQuestions);
  const spokenIntro = normalizeText(parsed.spokenIntro);
  const walkthrough = normalizeText(parsed.walkthrough);
  
  let testCases: ThoughtFlowTestCase[] = [];
  if (Array.isArray(parsed.testCases)) {
    testCases = parsed.testCases
      .filter((tc: any) => tc && (tc.input || tc.expectedOutput))
      .map((tc: any) => ({
        input: normalizeText(tc.input),
        expectedOutput: normalizeText(tc.expectedOutput),
        category: ['basic', 'edge', 'complex', 'performance', 'empty_null'].includes(tc.category)
          ? tc.category
          : 'basic',
      }));
  }
  
  let codeBlock: ThoughtFlowCodeBlock | null = null;
  if (parsed.codeBlock && typeof parsed.codeBlock === 'object') {
    const code = normalizeText(parsed.codeBlock.code);
    if (code) {
      codeBlock = {
        language: normalizeText(parsed.codeBlock.language) || 'javascript',
        code,
      };
    }
  }
  
  return {
    mode: 'thoughtflow',
    clarifyingQuestions,
    testCases,
    walkthrough,
    codeBlock,
    spokenIntro,
  };
}

export function isValidThoughtFlowResponse(response: ConsciousModeResponse): response is ThoughtFlowStructuredResponse {
  if (response.mode !== 'thoughtflow') return false;
  
  // Type narrow to ThoughtFlowStructuredResponse
  const thoughtFlowResponse = response as ThoughtFlowStructuredResponse;
  
  // All required fields must be present
  return Boolean(
    thoughtFlowResponse.walkthrough &&
    thoughtFlowResponse.clarifyingQuestions &&
    thoughtFlowResponse.testCases &&
    thoughtFlowResponse.spokenIntro &&
    // At least one of these should have content
    (thoughtFlowResponse.walkthrough.length > 0 ||
     thoughtFlowResponse.clarifyingQuestions.length > 0 ||
     thoughtFlowResponse.testCases.length > 0)
  );
}

export function formatThoughtFlowResponse(response: ThoughtFlowStructuredResponse): string {
  const lines: string[] = [];

  if (response.spokenIntro) {
    lines.push(`Spoken intro: ${response.spokenIntro}`);
  }

  if (response.clarifyingQuestions.length > 0) {
    lines.push('Clarifying questions:');
    response.clarifyingQuestions.forEach((q, i) => {
      lines.push(`  ${i + 1}. ${q}`);
    });
  }

  if (response.testCases.length > 0) {
    lines.push('Test cases:');
    response.testCases.forEach((tc, i) => {
      lines.push(`  ${i + 1}. [${tc.category}] Input: ${tc.input} → Expected: ${tc.expectedOutput}`);
    });
  }

  if (response.walkthrough) {
    lines.push(`Walkthrough: ${response.walkthrough}`);
  }

  if (response.codeBlock) {
    lines.push(`Code (${response.codeBlock.language}):`);
    lines.push(response.codeBlock.code);
  }

  return lines.join('\n').trim();
}

function mergeList(base: string[], incoming: string[]): string[] {
  return Array.from(new Set([...base, ...incoming].filter(Boolean)));
}

export function mergeConsciousModeResponses(
  base: ConsciousModeResponse,
  incoming: ConsciousModeResponse,
): ConsciousModeResponse {
  // If both are ThoughtFlow responses, merge them as ThoughtFlow
  if (isThoughtFlowResponse(base) && isThoughtFlowResponse(incoming)) {
    return {
      mode: 'thoughtflow',
      clarifyingQuestions: mergeList(base.clarifyingQuestions, incoming.clarifyingQuestions),
      testCases: [...base.testCases, ...incoming.testCases],
      walkthrough: incoming.walkthrough || base.walkthrough,
      codeBlock: incoming.codeBlock || base.codeBlock,
      spokenIntro: incoming.spokenIntro || base.spokenIntro,
    };
  }
  
  // If either is invalid, return the valid one
  if (base.mode === 'invalid') return incoming;
  if (incoming.mode === 'invalid') return base;
  
  // If one is ThoughtFlow and one is standard, prefer ThoughtFlow
  if (isThoughtFlowResponse(base)) return base;
  if (isThoughtFlowResponse(incoming)) return incoming;
  
  // Both are standard reasoning_first responses
  if (isStandardResponse(base) && isStandardResponse(incoming)) {
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
  
  return incoming;
}

function formatSection(label: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return [label, ...values.map(value => `- ${value}`)];
}

export function formatConsciousModeResponse(response: ConsciousModeResponse): string {
  if (isThoughtFlowResponse(response)) {
    return formatThoughtFlowResponse(response);
  }
  
  if (response.mode === 'invalid') {
    return '';
  }

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

function isQuestionLike(lower: string): boolean {
  return /\?$/.test(lower) || /^(how|what|why|when|where|which|who|can|could|would|walk me through|tell me)/i.test(lower);
}

function isSubstantialConversationTurn(lower: string): boolean {
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (isAdministrativePrompt(lower)) return false;
  return isBroadConsciousSeed(lower) || /^(let me (walk through|start with|explain|show)|walk me through|tell me about|describe|give me an example|switch gears and talk about)/i.test(lower);
}

function isBroadConsciousSeed(lower: string): boolean {
  return /(design|architecture|component|service|database|api|scale|scaling|throughput|latency|tradeoff|failure|retry|cache|queue|shard|replica|microservice|monolith|algorithm|data structure|complexity|optimi[sz]e|tell me about a time|describe a situation|give me an example|challenge|conflict|leadership|project)/i.test(lower);
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

function isExplicitTopicShift(lower: string): boolean {
  return /(switch gears|talk about the launch plan|talk about launch|move on to|different topic|new topic)/i.test(lower);
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

  if ((((questionLike && normalizedQuestion.split(/\s+/).length >= 3) && (systemDesignQuestion || isBroadConsciousSeed(lower) || normalizedQuestion.split(/\s+/).length >= 5)) || isSubstantialConversationTurn(lower)) && !isAdministrativePrompt(lower)) {
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
    return classifyConsciousModeQuestion(trimmed, activeReasoningThread).qualifies || isSubstantialConversationTurn(trimmed.toLowerCase());
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
