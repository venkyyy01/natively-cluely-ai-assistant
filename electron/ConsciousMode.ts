import {
	type BufferedUtterance,
	InterviewerUtteranceBuffer,
} from "./buffering/InterviewerUtteranceBuffer";
import { getOptimizationFlags } from "./config/optimizations";
import {
	getDefaultTriggerAuditLog,
	type TriggerAuditLog,
	type TriggerDecisionCohort,
	type TriggerDecisionReasonCode,
} from "./observability/TriggerAuditLog";

export type ConsciousModeResponseMode = "reasoning_first" | "invalid";

export const CONSCIOUS_MODE_SCHEMA_VERSION = "conscious_mode_v1" as const;

export const CONSCIOUS_MODE_RESPONSE_FIELDS = [
	"schemaVersion",
	"mode",
	"openingReasoning",
	"implementationPlan",
	"tradeoffs",
	"edgeCases",
	"scaleConsiderations",
	"pushbackResponses",
	"likelyFollowUps",
	"codeTransition",
	"behavioralAnswer",
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
  "codeTransition": "string",
  "behavioralAnswer": {
    "question": "string",
    "headline": "string",
    "situation": "string",
    "task": "string",
    "action": "string",
    "result": "string",
    "whyThisAnswerWorks": ["string"]
  }
}

CRITICAL RULES — MOST FIELDS SHOULD BE EMPTY:
- Leave ALL array fields as [] unless the interviewer EXPLICITLY asked for that dimension.
- If they asked one thing, answer that ONE thing. Do NOT fill every field.
- openingReasoning: 1-2 sentences MAX. Natural Indian English like "So basically I'd..." or "See, the thing is..."
- tradeoffs: Only if they asked about tradeoffs. ONE tradeoff max, spoken naturally.
- edgeCases: [] unless they specifically asked about edge cases.
- scaleConsiderations: [] unless they specifically asked about scale.
- pushbackResponses: [] unless they challenged your approach.
- likelyFollowUps: 0-2 max. What they might ask next, not a list of everything you know.
- codeTransition: "" unless it's a coding question.

SPEECH STYLE — TALK LIKE A REAL PERSON:
- Write like someone actually talking, not writing an essay
- Indian English naturally: "So basically...", "See...", "The thing is...", "Yeah, what happened was..."
- Contractions everywhere: "I'd", "I'm", "I've", "don't", "won't", "it's"
- Simple words: "use" not "leverage", "build" not "architect", "start" not "commence"
- NO bullet points, numbered lists, or structured formatting in spoken fields
- NO "First, Second, Third" or "In conclusion" — real people don't talk like that
- NO "Let me walk you through" or "Let me break this down" — just say it
- If any field reads like a textbook, tutorial, or presentation, REWRITE it in plain speech

If the interviewer wants more, THEY WILL ASK. Your job is to give a focused answer, not anticipate every possible follow-up and dump it all at once.`;

export interface ConsciousBehavioralAnswer {
	question: string;
	headline: string;
	situation: string;
	task: string;
	action: string;
	result: string;
	whyThisAnswerWorks: string[];
}

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
	behavioralAnswer?: ConsciousBehavioralAnswer | null;
}

export interface ReasoningThread {
	/** When set, matches `ConversationThread.id` from ThreadManager (design view). NAT-055 */
	threadId?: string;
	rootQuestion: string;
	lastQuestion: string;
	response: ConsciousModeStructuredResponse;
	followUpCount: number;
	updatedAt: number;
	/** Cached embedding for semantic thread continuation compatibility checks */
	embedding?: number[];
}

export type ConsciousModeThreadAction =
	| "start"
	| "continue"
	| "reset"
	| "ignore";

export interface ConsciousModeQuestionRoute {
	qualifies: boolean;
	threadAction: ConsciousModeThreadAction;
}

const BEHAVIORAL_ACTIONABLE_QUESTION_PATTERNS = [
	/^tell me about a time\b/i,
	/^describe a time\b/i,
	/^describe a situation\b/i,
	/^share an experience\b/i,
	/^give me an example\b/i,
	// Broader walk-me-through: catches "walk me through your approach", "walk me through how you", etc.
	/^walk me through\b/i,
	/^talk about\b/i,
	/^how do you handle\b/i,
	/^how do you manage\b/i,
	/^what is your .*style\b/i,
	/^how do you make .*decision/i,
	/^how do you influence\b/i,
	/^how do you prioritize\b/i,
	/\bleadership\b/i,
	/\bconflict\b/i,
	/\bdisagreed\b/i,
	/\bdisagreement\b/i,
	/\bfeedback\b/i,
	/\bfailure\b/i,
	/\bmistake\b/i,
	/\bproject you led\b/i,
	/\bowned end to end\b/i,
	/\bteam challenge\b/i,
	/\bculture\b/i,
	/\bvalues\b/i,
	/\bmentor\b/i,
	/\bstakeholder\b/i,
];

export function isBehavioralQuestionText(
	value: string | null | undefined,
): boolean {
	const normalized = normalizeText(value).toLowerCase();
	if (!normalized) {
		return false;
	}

	return BEHAVIORAL_ACTIONABLE_QUESTION_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}

function isBehavioralActionableQuestion(lower: string): boolean {
	return isBehavioralQuestionText(lower);
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
		sourceUtteranceId?: string;
	}): Promise<void>;
}

export interface TranscriptSuggestionInput {
	speaker: string;
	text: string;
	final: boolean;
	confidence?: number;
	consciousModeEnabled: boolean;
	intelligenceManager: TranscriptSuggestionIntelligenceManager;
	utteranceBuffer?: InterviewerUtteranceBuffer;
	triggerAuditLog?: TriggerAuditLog;
}

const defaultInterviewerUtteranceBuffer = new InterviewerUtteranceBuffer();

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return Array.from(new Set(value.map(normalizeText).filter(Boolean)));
	}

	const text = normalizeText(value);
	return text ? [text] : [];
}

function normalizeBehavioralAnswer(
	value: unknown,
): ConsciousBehavioralAnswer | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const behavioral = value as Record<string, unknown>;
	const normalized: ConsciousBehavioralAnswer = {
		question: normalizeText(behavioral.question),
		headline: normalizeText(behavioral.headline),
		situation: normalizeText(behavioral.situation),
		task: normalizeText(behavioral.task),
		action: normalizeText(behavioral.action),
		result: normalizeText(behavioral.result),
		whyThisAnswerWorks: normalizeList(behavioral.whyThisAnswerWorks),
	};

	if (
		!normalized.question &&
		!normalized.headline &&
		!normalized.situation &&
		!normalized.task &&
		!normalized.action &&
		!normalized.result &&
		normalized.whyThisAnswerWorks.length === 0
	) {
		return null;
	}

	return normalized;
}

function hasBehavioralAnswerSubstance(
	value: ConsciousBehavioralAnswer | null | undefined,
): boolean {
	return Boolean(
		value?.question ||
			value?.headline ||
			value?.situation ||
			value?.task ||
			value?.action ||
			value?.result ||
			value?.whyThisAnswerWorks.length,
	);
}

export function createEmptyConsciousModeResponse(
	mode: ConsciousModeResponseMode = "reasoning_first",
): ConsciousModeStructuredResponse {
	return {
		mode,
		openingReasoning: "",
		implementationPlan: [],
		tradeoffs: [],
		edgeCases: [],
		scaleConsiderations: [],
		pushbackResponses: [],
		likelyFollowUps: [],
		codeTransition: "",
		behavioralAnswer: null,
	};
}

function normalizePushbackResponses(value: unknown): string[] {
	if (Array.isArray(value)) {
		return normalizeList(value);
	}

	if (value && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([concern, response]) => {
				const normalizedResponse = normalizeText(response);
				return normalizedResponse
					? `${normalizeText(concern)}: ${normalizedResponse}`
					: "";
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

	if (!codeBlock || typeof codeBlock !== "object") {
		return "";
	}

	const block = codeBlock as { language?: unknown; code?: unknown };
	const code = normalizeText(block.code);
	if (!code) {
		return "";
	}

	const language = normalizeText(block.language);
	return `Here is the code path I would walk through:\n\`\`\`${language}\n${code}\n\`\`\``;
}

export function normalizeConsciousModeResponse(
	value:
		| (Partial<ConsciousModeStructuredResponse> & {
				schemaVersion?: unknown;
				spokenResponse?: unknown;
				codeBlock?: unknown;
				pushbackResponses?: unknown;
		  })
		| null
		| undefined,
): ConsciousModeStructuredResponse {
	const hasCanonicalMode = value?.mode === "reasoning_first";
	const hasAdaptableLegacyPayload = Boolean(
		normalizeText(value?.openingReasoning) ||
			normalizeText(value?.spokenResponse) ||
			normalizeList(value?.implementationPlan).length ||
			normalizeList(value?.tradeoffs).length ||
			normalizeCodeTransition(value?.codeTransition, value?.codeBlock) ||
			hasBehavioralAnswerSubstance(
				normalizeBehavioralAnswer(
					(value as Record<string, unknown> | undefined)?.behavioralAnswer,
				),
			),
	);
	const mode =
		hasCanonicalMode || hasAdaptableLegacyPayload
			? "reasoning_first"
			: "invalid";
	const behavioralAnswer = normalizeBehavioralAnswer(
		(value as Record<string, unknown> | undefined)?.behavioralAnswer,
	);
	const openingReasoning =
		normalizeText(value?.openingReasoning) ||
		normalizeText(value?.spokenResponse) ||
		behavioralAnswer?.headline ||
		"";
	return {
		mode,
		openingReasoning,
		implementationPlan: normalizeList(value?.implementationPlan),
		tradeoffs: normalizeList(value?.tradeoffs),
		edgeCases: normalizeList(value?.edgeCases),
		scaleConsiderations: normalizeList(value?.scaleConsiderations),
		pushbackResponses: normalizePushbackResponses(value?.pushbackResponses),
		likelyFollowUps: normalizeList(value?.likelyFollowUps),
		codeTransition: normalizeCodeTransition(
			value?.codeTransition,
			value?.codeBlock,
		),
		behavioralAnswer,
	};
}

export function isValidConsciousModeResponse(
	response: ConsciousModeStructuredResponse | null | undefined,
): response is ConsciousModeStructuredResponse {
	if (!response || response.mode !== "reasoning_first") {
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
			response.codeTransition ||
			hasBehavioralAnswerSubstance(response.behavioralAnswer),
	);
}

export function parseConsciousModeResponse(
	raw: string,
): ConsciousModeStructuredResponse {
	const trimmed = raw.trim();
	if (!trimmed) {
		return createEmptyConsciousModeResponse("invalid");
	}

	const jsonCandidate = trimmed
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/```$/i, "")
		.trim();

	try {
		const normalized = normalizeConsciousModeResponse(
			JSON.parse(jsonCandidate),
		);
		return isValidConsciousModeResponse(normalized)
			? normalized
			: createEmptyConsciousModeResponse("invalid");
	} catch {
		return createEmptyConsciousModeResponse("invalid");
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
		mode: "reasoning_first",
		openingReasoning: incoming.openingReasoning || base.openingReasoning,
		implementationPlan: mergeList(
			base.implementationPlan,
			incoming.implementationPlan,
		),
		tradeoffs: mergeList(base.tradeoffs, incoming.tradeoffs),
		edgeCases: mergeList(base.edgeCases, incoming.edgeCases),
		scaleConsiderations: mergeList(
			base.scaleConsiderations,
			incoming.scaleConsiderations,
		),
		pushbackResponses: mergeList(
			base.pushbackResponses,
			incoming.pushbackResponses,
		),
		likelyFollowUps: mergeList(base.likelyFollowUps, incoming.likelyFollowUps),
		codeTransition: incoming.codeTransition || base.codeTransition,
		behavioralAnswer:
			incoming.behavioralAnswer || base.behavioralAnswer || null,
	};
}

function formatSection(label: string, values: string[]): string[] {
	if (values.length === 0) return [];
	if (values.length === 1) return [`${label} ${values[0]}`];
	return [
		label,
		...values.map((value, i) => {
			if (i === 0) return `So, ${value[0].toLowerCase()}${value.slice(1)}`;
			return `Also, ${value[0].toLowerCase()}${value.slice(1)}`;
		}),
	];
}

function formatBehavioralAnswer(answer: ConsciousBehavioralAnswer): string[] {
	const parts: string[] = [];
	if (answer.question) {
		parts.push(`Question: ${answer.question}`);
	}
	if (answer.headline) {
		parts.push("Headline:");
		parts.push(answer.headline);
	}
	if (answer.situation) {
		parts.push(`Situation: ${answer.situation}`);
	}
	if (answer.task) {
		parts.push(`Task: ${answer.task}`);
	}
	if (answer.action) {
		parts.push(`Action: ${answer.action}`);
	}
	if (answer.result) {
		parts.push(`Result: ${answer.result}`);
	}
	if (answer.whyThisAnswerWorks.length > 0) {
		parts.push("Why this answer works:");
		parts.push(...answer.whyThisAnswerWorks.map((value) => `- ${value}`));
	}
	return parts.filter(Boolean);
}

export function formatConsciousModeResponseChunks(
	response: ConsciousModeStructuredResponse,
): string[] {
	if (
		response.behavioralAnswer &&
		hasBehavioralAnswerSubstance(response.behavioralAnswer)
	) {
		return formatBehavioralAnswer(response.behavioralAnswer);
	}

	const chunks: string[] = [];

	if (response.openingReasoning) {
		chunks.push(response.openingReasoning);
	}

	const implSection = formatSection("", response.implementationPlan);
	if (implSection.length) chunks.push(implSection.join(" "));

	const tradeoffSection = formatSection("The tradeoff is,", response.tradeoffs);
	if (tradeoffSection.length) chunks.push(tradeoffSection.join(" "));

	const edgeSection = formatSection("Edge case —", response.edgeCases);
	if (edgeSection.length) chunks.push(edgeSection.join(" "));

	const scaleSection = formatSection("At scale,", response.scaleConsiderations);
	if (scaleSection.length) chunks.push(scaleSection.join(" "));

	const pushbackSection = formatSection(
		"If they push back,",
		response.pushbackResponses,
	);
	if (pushbackSection.length) chunks.push(pushbackSection.join(" "));

	if (response.codeTransition) {
		chunks.push(response.codeTransition);
	}

	return chunks.filter(Boolean);
}

export function formatConsciousModeResponse(
	response: ConsciousModeStructuredResponse,
): string {
	return formatConsciousModeResponseChunks(response).join("\n").trim();
}

export function tryParseConsciousModeOpeningReasoning(
	raw: string,
): string | null {
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
	return /\?$/.test(lower) || hasQuestionPrefix(lower);
}

function hasTerminalPunctuation(text: string): boolean {
	return /[.!?]$/.test(text.trim());
}

function hasQuestionPrefix(lower: string): boolean {
	return /^(how|what|what's|why|when|where|which|who|can|could|would|should|tell me|give me|describe|explain|walk me through|talk about|share|how would you|what is your approach|what's your approach)\b/i.test(
		lower,
	);
}

function stripTrailingPunctuation(text: string): string {
	return text.replace(/[.!?]+$/, "");
}

function isSubstantialConversationTurn(lower: string): boolean {
	const words = lower.split(/\s+/).filter(Boolean);
	if (words.length < 4) return false;
	if (isAdministrativePrompt(lower)) return false;
	return (
		isBroadConsciousSeed(lower) ||
		/^(let me (walk through|start with|explain|show)|walk me through|switch gears and talk about)/i.test(
			lower,
		)
	);
}

function isBroadConsciousSeed(lower: string): boolean {
	// Strip trailing punctuation so "limiters?" matches "limiters" word boundary
	const clean = stripTrailingPunctuation(lower);
	return /\b(design|architecture|component|components|service|services|database|databases|api|apis|scale|scaling|throughput|latency|tradeoff|tradeoffs|failure|retry|cache|caching|queue|queues|shard|sharding|replica|replication|microservice|microservices|monolith|algorithm|algorithms|complexity|optimization|optimisation|optimize|optimise|partition|partitioning|failover|bottleneck|consistency|availability|backpressure|hotspot|ledger|distributed|testing|deployment|monitoring|observability|ci.?cd|data pipeline|state management|authentication|authorization|security|performance|reliability|error handling|logging|tracing|load balanc|rate limit|circuit breaker|message queue|event sourc|CQRS|saga|workflow|orchestrat|choreograph)\b|\b(data structure|data structures|rate limiter|rate limiters|data model|notification system|streaming system)\b/i.test(
		clean,
	);
}

function _isBehavioralPrompt(lower: string): boolean {
	return isBehavioralQuestionText(lower);
}

function isAdministrativePrompt(lower: string): boolean {
	return /(repeat that|say that again|calendar invite|sounds good|okay|ok|got it|fine|warmup is done|done already|all set)/i.test(
		lower,
	);
}

function isSystemDesignQuestion(lower: string): boolean {
	// NOTE: removed ^ anchors so phrases like "So how would you design..." match.
	// Added \b word boundaries to prevent false positives.
	// Strip trailing punctuation so "limiter?" matches "limiter" word boundary
	const clean = stripTrailingPunctuation(lower);
	return /(\bhow would you design\b|\bsystem design\b|\barchitect\b|\bhigh[- ]level design\b|\bdistributed system\b|\brate limiter\b|\bpartition\b|\bmonolith to microservices\b|\bmigrate a monolith\b|\bdesign the data model\b|\bdesign a .*system\b|\bdesign an .*system\b|\bdesign the .*system\b|\bdesign a .*service\b|\bdesign an .*service\b|\bdesign the .*service\b|\bdesign this\b|\bdesign that\b|\bwhat(?:'s| is) your approach\b|\bwhat(?:'s| is) the best way\b|\bhow (?:do|would) you approach\b|\bhow (?:do|would) you handle\b|\bhow (?:do|would) you solve\b|\bhow (?:do|would) you build\b|\bhow (?:do|would) you implement\b|\bhow (?:do|would) you structure\b|\bhow (?:do|would) you organize\b|\bhow should (?:I|we)\b|\bwalk (?:me )?through (?:your |how )?\b|\bdescribe your approach\b|\bwhat .*(?:approach|strategy) would\b|\bdesign decision\b|\byour approach for\b|\bgiven.*how would\b|\bif you were.*how\b|\bwhat would you\b|\btrade[ -]?offs?\b.*\bdesign\b|\bhow do I choose\b)/i.test(
		clean,
	);
}

function isQuestionContinuationPhrase(lower: string): boolean {
	return /^(what are the tradeoffs\??|how would you shard this\??|what happens during failover\??|what metrics would you watch( first)?\??)$/i.test(
		lower,
	);
}

function isColdStartContinuationPhrase(lower: string): boolean {
	return /^(what are the tradeoffs\??|how would you shard this\??)$/i.test(
		lower,
	);
}

function isExplicitTopicShift(lower: string): boolean {
	return /(switch gears|talk about the launch plan|talk about launch|move on to|different topic|new topic|let(?:'s| us) talk about)/i.test(
		lower,
	);
}

function isShortActionablePrompt(lower: string): boolean {
	return /^(why this approach|why this|why not|how so|go deeper|can you go deeper|walk me through that|walk me through it|talk through that|and then|what about reliability|what about scale|what about failure handling|what about bottlenecks|what's your approach|what is your approach)$/i.test(
		lower,
	);
}

function isActionableInterviewerPrompt(lower: string): boolean {
	if (isAdministrativePrompt(lower)) {
		return false;
	}

	const words = lower.split(/\s+/).filter(Boolean);
	if (isShortActionablePrompt(lower)) {
		return true;
	}

	return (
		(isQuestionLike(lower) && words.length >= 4) ||
		(words.length >= 6 && isBroadConsciousSeed(lower))
	);
}

export function classifyConsciousModeQuestion(
	question: string | null | undefined,
	activeThread: ReasoningThread | null,
): ConsciousModeQuestionRoute {
	const normalizedQuestion = normalizeText(question);
	if (!normalizedQuestion) {
		return { qualifies: false, threadAction: "ignore" };
	}

	const lower = normalizedQuestion.toLowerCase();
	const questionLike = isQuestionLike(lower);
	const systemDesignQuestion = isSystemDesignQuestion(lower);
	const explicitContinuation = isQuestionContinuationPhrase(lower);
	const behavioralQuestion = isBehavioralActionableQuestion(lower);

	if (behavioralQuestion) {
		if (activeThread) {
			return { qualifies: true, threadAction: "reset" };
		}

		return { qualifies: true, threadAction: "start" };
	}

	if (activeThread) {
		if (explicitContinuation) {
			return { qualifies: true, threadAction: "continue" };
		}

		if (questionLike && systemDesignQuestion) {
			return { qualifies: true, threadAction: "reset" };
		}

		if (isExplicitTopicShift(lower)) {
			return { qualifies: true, threadAction: "reset" };
		}

		if (
			((questionLike && normalizedQuestion.split(/\s+/).length >= 3) ||
				isSubstantialConversationTurn(lower)) &&
			!isAdministrativePrompt(lower)
		) {
			return { qualifies: true, threadAction: "continue" };
		}

		return { qualifies: false, threadAction: "ignore" };
	}

	if (
		(systemDesignQuestion ||
			isColdStartContinuationPhrase(lower) ||
			(isSubstantialConversationTurn(lower) && !questionLike)) &&
		!isAdministrativePrompt(lower)
	) {
		return { qualifies: true, threadAction: "start" };
	}

	return { qualifies: false, threadAction: "ignore" };
}

export function shouldAutoTriggerSuggestionFromTranscript(
	text: string,
	consciousModeEnabled: boolean,
	activeReasoningThread: ReasoningThread | null,
	_isBufferFlushEvent: boolean = false,
): boolean {
	const trimmed = normalizeText(text);
	if (!trimmed) {
		return false;
	}

	if (consciousModeEnabled) {
		const lower = trimmed.toLowerCase();
		return (
			classifyConsciousModeQuestion(trimmed, activeReasoningThread).qualifies ||
			isSubstantialConversationTurn(lower) ||
			isActionableInterviewerPrompt(lower)
		);
	}

	const lower = trimmed.toLowerCase();
	const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
	return (
		hasTerminalPunctuation(trimmed) ||
		(hasQuestionPrefix(lower) && wordCount >= 4)
	);
}

export function getTranscriptSuggestionDecision(
	text: string,
	consciousModeEnabled: boolean,
	activeReasoningThread: ReasoningThread | null,
	isBufferFlushEvent: boolean = false,
): TranscriptSuggestionDecision {
	const lastQuestion = normalizeText(text);
	return {
		shouldTrigger: shouldAutoTriggerSuggestionFromTranscript(
			lastQuestion,
			consciousModeEnabled,
			activeReasoningThread,
			isBufferFlushEvent,
		),
		lastQuestion,
	};
}

function snippet(text: string): string {
	const normalized = normalizeText(text);
	return normalized.length > 120
		? `${normalized.slice(0, 117)}...`
		: normalized;
}

function auditTriggerDecision(
	log: TriggerAuditLog,
	input: {
		utteranceId?: string;
		speaker: string;
		text: string;
		reasonCode: TriggerDecisionReasonCode;
		outcome: "accepted" | "declined" | "stale" | "completed";
		cohort: TriggerDecisionCohort;
		requestOutcome?: string;
	},
): void {
	log.record({
		timestamp: Date.now(),
		utteranceId: input.utteranceId,
		speaker: input.speaker,
		textSnippet: snippet(input.text),
		reasonCode: input.reasonCode,
		outcome: input.outcome,
		cohort: input.cohort,
		requestOutcome: input.requestOutcome,
	});
}

async function triggerFromCandidate(
	input: TranscriptSuggestionInput,
	candidate: {
		text: string;
		speaker: string;
		sourceUtteranceId?: string;
		isBufferFlushEvent: boolean;
		auditLog: TriggerAuditLog;
		cohort: TriggerDecisionCohort;
	},
): Promise<boolean> {
	const activeThread = input.intelligenceManager.getActiveReasoningThread();
	console.log(`[AUTO-TRIGGER] 🧠 Active reasoning thread: ${!!activeThread}`);

	const decision = getTranscriptSuggestionDecision(
		candidate.text,
		input.consciousModeEnabled,
		activeThread,
		candidate.isBufferFlushEvent,
	);

	console.log("[AUTO-TRIGGER] 📊 Decision analysis:", {
		shouldTrigger: decision.shouldTrigger,
		lastQuestion:
			decision.lastQuestion.substring(0, 50) +
			(decision.lastQuestion.length > 50 ? "..." : ""),
		questionLength: decision.lastQuestion.length,
		hasActiveThread: !!activeThread,
		consciousModeEnabled: input.consciousModeEnabled,
		sourceUtteranceId: candidate.sourceUtteranceId,
	});

	if (!decision.shouldTrigger) {
		console.log("[AUTO-TRIGGER] ❌ Decision logic declined to trigger");
		auditTriggerDecision(candidate.auditLog, {
			utteranceId: candidate.sourceUtteranceId,
			speaker: candidate.speaker,
			text: candidate.text,
			reasonCode: decision.lastQuestion
				? "declined_no_punctuation"
				: "declined_too_short",
			outcome: "declined",
			cohort: candidate.cohort,
		});
		return false;
	}

	try {
		const context = input.intelligenceManager.getFormattedContext(180);
		console.log(
			`[AUTO-TRIGGER] 📝 Context length: ${context ? context.length : 0} chars`,
		);
		console.log("[AUTO-TRIGGER] 🚀 Calling handleSuggestionTrigger...");
		auditTriggerDecision(candidate.auditLog, {
			utteranceId: candidate.sourceUtteranceId,
			speaker: candidate.speaker,
			text: candidate.text,
			reasonCode: "fired",
			outcome: "accepted",
			cohort: candidate.cohort,
		});

		const trigger = {
			context,
			lastQuestion: decision.lastQuestion,
			confidence: input.confidence ?? 0.8,
			...(candidate.sourceUtteranceId
				? { sourceUtteranceId: candidate.sourceUtteranceId }
				: {}),
		};
		await input.intelligenceManager.handleSuggestionTrigger(trigger);

		auditTriggerDecision(candidate.auditLog, {
			utteranceId: candidate.sourceUtteranceId,
			speaker: candidate.speaker,
			text: candidate.text,
			reasonCode: "completed",
			outcome: "completed",
			cohort: candidate.cohort,
			requestOutcome: "completed",
		});
		console.log("[AUTO-TRIGGER] ✅ Successfully triggered LLM response");
		return true;
	} catch (error) {
		console.error("[AUTO-TRIGGER] 🚨 Failed to trigger:", error);
		return false;
	}
}

export async function maybeHandleSuggestionTriggerFromTranscript(
	input: TranscriptSuggestionInput,
): Promise<boolean> {
	const flags = getOptimizationFlags();
	const auditLog = input.triggerAuditLog ?? getDefaultTriggerAuditLog();
	const cohort: TriggerDecisionCohort = flags.useUtteranceLevelTriggering
		? "utterance_level"
		: "legacy_fragment";
	console.log("[AUTO-TRIGGER] 🔍 Processing transcript:", {
		speaker: input.speaker,
		final: input.final,
		textLength: input.text.length,
		textPreview:
			input.text.substring(0, 50) + (input.text.length > 50 ? "..." : ""),
		consciousMode: input.consciousModeEnabled,
		confidence: input.confidence,
		hasIntelligenceManager: !!input.intelligenceManager,
	});

	const speakerAllowed =
		input.speaker === "interviewer" ||
		(input.speaker === "user" && flags.useMicTranscriptTriggers);
	if (!speakerAllowed) {
		console.log(
			`[AUTO-TRIGGER] ❌ Rejected: speaker is "${input.speaker}", need "interviewer"`,
		);
		auditTriggerDecision(auditLog, {
			speaker: input.speaker,
			text: input.text,
			reasonCode: "declined_speaker",
			outcome: "declined",
			cohort,
		});
		return false;
	}

	// NAT-006 / audit A-6: never let an interim (non-final) transcript drive
	// `handleSuggestionTrigger`. Interim hypotheses are routinely revised or
	// outright discarded by the STT provider; acting on them produces an
	// answer for a question the user never finished asking, which the user
	// then sees and which we either have to hide (UX flicker) or replace
	// (wasted token spend + provenance confusion).
	//
	// Speculative paths (prefetch / planner warm-up) live elsewhere
	// (ConsciousAccelerationOrchestrator) and remain free to act on
	// interim text — but only the *final* transcript is allowed to commit
	// to a user-visible answer.
	if (!input.final) {
		console.log(
			`[AUTO-TRIGGER] ❌ Rejected: transcript is interim (final=false, confidence=${input.confidence ?? "n/a"})`,
		);
		auditTriggerDecision(auditLog, {
			speaker: input.speaker,
			text: input.text,
			reasonCode: "declined_no_punctuation",
			outcome: "declined",
			cohort,
		});
		return false;
	}

	// Belt-and-suspenders: even when `final === true`, refuse low-confidence
	// finals. Some providers emit best-effort finals on UtteranceEnd timers
	// (see NAT-009) which can be unreliable.
	if (input.confidence != null && input.confidence < 0.5) {
		console.log(
			"[AUTO-TRIGGER] ❌ Rejected: final transcript with low confidence",
		);
		auditTriggerDecision(auditLog, {
			speaker: input.speaker,
			text: input.text,
			reasonCode: "declined_too_short",
			outcome: "declined",
			cohort,
		});
		return false;
	}

	if (flags.useUtteranceLevelTriggering) {
		const buffer = input.utteranceBuffer ?? defaultInterviewerUtteranceBuffer;
		const pendingFlushes: Promise<boolean>[] = [];
		buffer.setOnUtterance((utterance: BufferedUtterance) => {
			const pending = triggerFromCandidate(input, {
				text: utterance.text,
				speaker: utterance.speaker,
				sourceUtteranceId: utterance.utteranceId,
				isBufferFlushEvent: true,
				auditLog,
				cohort,
			});
			pendingFlushes.push(pending);
			void pending;
		});

		const flushed = buffer.pushFragment(input.speaker, input.text, input.final);
		if (flushed.length === 0) {
			auditTriggerDecision(auditLog, {
				speaker: input.speaker,
				text: input.text,
				reasonCode: "declined_no_punctuation",
				outcome: "declined",
				cohort,
			});
			return false;
		}

		const results = await Promise.all(pendingFlushes);
		return results.some(Boolean);
	}

	return triggerFromCandidate(input, {
		text: input.text,
		speaker: input.speaker,
		isBufferFlushEvent: false,
		auditLog,
		cohort,
	});
}
