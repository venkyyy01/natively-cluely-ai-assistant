/**
 * HumanLikeConversationEngine
 *
 * Analyzes any user utterance and classifies it into a conversational mode
 * so conscious mode can respond like a human, not a structured-JSON bot.
 *
 * Standard (non-conscious) mode handles many kinds of utterances naturally
 * because it generates free-form text. Conscious mode forces every turn into
 * a 13-field JSON schema with verification gates, which makes casual, social,
 * or clarification turns feel robotic.
 *
 * This engine adds the missing classification layer:
 *   - smalltalk      ("hi", "thanks")
 *   - clarification  ("what do you mean?")
 *   - refinement     ("can you make it shorter?")
 *   - acknowledgement ("got it", "makes sense")
 *   - off_topic_aside ("oh by the way...")
 *   - technical      (default — go through full conscious pipeline)
 *
 * It is intentionally pure (no LLM calls, no I/O) so it stays fast and
 * deterministic. Embeddings and semantic checks happen *upstream* of this
 * — this is the cheap, last-mile router.
 */

export type ConversationKind =
	| "smalltalk"
	| "clarification"
	| "refinement"
	| "acknowledgement"
	| "off_topic_aside"
	| "behavioral"
	| "pushback"
	| "technical";

export interface ConversationClassification {
	kind: ConversationKind;
	confidence: number;
	/** When kind === 'refinement', the specific refinement intent. */
	refinementIntent?: RefinementIntent;
	/** Suggested verification level for this turn. */
	verificationLevel: VerificationLevel;
	/** Whether this turn should bypass the structured JSON schema. */
	preferFreeForm: boolean;
	/** Human-readable reason for the classification (debugging). */
	reason: string;
}

export type RefinementIntent =
	| "shorten"
	| "expand"
	| "rephrase"
	| "simplify"
	| "more_formal"
	| "more_casual"
	| "add_example"
	| "add_detail";

export type VerificationLevel = "strict" | "moderate" | "relaxed" | "skip";

interface PatternMatch {
	pattern: RegExp;
	refinementIntent?: RefinementIntent;
}

const SMALLTALK_PATTERNS: PatternMatch[] = [
	{ pattern: /^\s*(hi|hello|hey|yo|hiya)\b[\s!.,?]*$/i },
	{
		pattern:
			/^\s*(hi|hello|hey|yo|hiya)\s+(there|everyone|everybody|guys|folks|all|team|sir|ma'am|miss|mister)\b[\s!.,?]*$/i,
	},
	{ pattern: /^\s*good\s+(morning|afternoon|evening|day)\b/i },
	{
		pattern: /^\s*(thanks|thank you|thx|ty|cheers|appreciate it)\b[\s!.,?]*$/i,
	},
	{
		pattern:
			/^\s*(how('?| ?i)?s? (are )?(you|it going|things)|what'?s up|how have you been)\b/i,
	},
	{ pattern: /^\s*(nice to meet you|good to see you|pleased to meet you)\b/i },
	{
		pattern:
			/^\s*(bye|goodbye|see you|talk soon|have a (good|nice) (one|day|evening))\b/i,
	},
	{
		pattern:
			/^\s*(welcome|you('re| are) welcome|no problem|np|sure thing)\b[\s!.,?]*$/i,
	},
	// Real transcript patterns: greetings with audience
	{
		pattern:
			/^\s*(hi,?\s+everyone|hello,?\s+everyone|welcome\s+(to|everyone))\b/i,
	},
	{ pattern: /^\s*(cool\.?\s+so|okay\.?\s+so|alright\.?\s+so)\b/i },
];

const CLARIFICATION_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/^\s*(sorry|pardon|excuse me)[,.\s]+(what|come again|can you repeat)/i,
	},
	{
		pattern:
			/^\s*(what (do you|did you|does that|did that) mean|what does that mean)/i,
	},
	{
		pattern:
			/^\s*(can you (clarify|explain|elaborate|repeat)|could you (clarify|explain|repeat))/i,
	},
	{
		pattern: /^\s*(i'?m not sure (what|i)|i don'?t (understand|get|follow))\b/i,
	},
	{ pattern: /^\s*(wait,?\s*(what|hold on|sorry)|huh\??|come again\??)\b/i },
	{
		pattern:
			/^\s*(so (what )?you'?re saying|so that means|so basically you mean)/i,
	},
	{ pattern: /^\s*(repeat that|say that again|one more time|again please)\b/i },
	{ pattern: /^\s*(could you (be more specific|give more detail))/i },
];

const REFINEMENT_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/\b(make it (shorter|brief|concise)|shorten (this|that|it)|cut it down|tldr|too long)\b/i,
		refinementIntent: "shorten",
	},
	{
		pattern:
			/\b(make it (longer|detailed)|expand (on (this|that|it)|more)|elaborate|go deeper|tell me more)\b/i,
		refinementIntent: "expand",
	},
	{
		pattern:
			/\b(rephrase (that|this|it)|say it differently|put it another way|word it differently)\b/i,
		refinementIntent: "rephrase",
	},
	{
		pattern:
			/\b(simplify (this|that|it)|make it simpler|in (plain|simple) (english|words)|like i'?m five|eli5)\b/i,
		refinementIntent: "simplify",
	},
	{
		pattern:
			/\b(more formal|more professional|be more professional|sound professional|formal tone)\b/i,
		refinementIntent: "more_formal",
	},
	{
		pattern:
			/\b(more casual|less formal|sound (relaxed|natural)|casual tone)\b/i,
		refinementIntent: "more_casual",
	},
	{
		pattern:
			/\b(give me an example|provide an (example|instance)|for example|with an example)\b/i,
		refinementIntent: "add_example",
	},
	{
		pattern:
			/\b(more (detail|specific)|be more specific|add (more )?detail)\b/i,
		refinementIntent: "add_detail",
	},
];

const ACKNOWLEDGEMENT_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/^\s*(got it|makes sense|i see|understood|ok(ay)?|alright|fair enough)\b[\s!.,?]*$/i,
	},
	{
		pattern:
			/^\s*(yeah|yes|right|exactly|that'?s right|true|correct)\b[\s!.,?]*$/i,
	},
	{
		pattern:
			/^\s*(no|nope|not really|not quite|i don'?t think so)\b[\s!.,?]*$/i,
	},
	{
		pattern:
			/^\s*(interesting|cool|nice|good (point|to know)|fascinating|wow|huh)\b[\s!.,?]*$/i,
	},
	{ pattern: /^\s*(mm-?hmm|uh-?huh|hmm|oh)\b[\s!.,?]*$/i },
];

const OFF_TOPIC_ASIDE_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/^\s*(by the way|btw|side note|on a (different|separate) note|quick (question|aside)|random question)/i,
	},
	{
		pattern:
			/^\s*(actually,?\s*(can|let me|i)|on second thought|come to think of it)/i,
	},
	{ pattern: /^\s*(speaking of|that reminds me|oh,?\s*(also|and))/i },
];

const BEHAVIORAL_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/\b(tell me about a time|describe a situation|describe a time|have you ever|give me an example of)\b/i,
	},
	{
		pattern:
			/\b(walk me through|how did you handle|how would you handle|what was your role)\b/i,
	},
	{
		pattern:
			/\b(a project where|describe.*when you|tell me about.*(led|managed|worked on))\b/i,
	},
];

const PUSHBACK_PATTERNS: PatternMatch[] = [
	{
		pattern:
			/\b(but what about|why not|why did you|are you sure|doesn'?t that|wouldn'?t that)\b/i,
	},
	{
		pattern:
			/\b(how would that|what if|would that still|but then|isn'?t that)\b/i,
	},
];

const ALL_PATTERNS: ReadonlyArray<{
	kind: Exclude<ConversationKind, "technical">;
	patterns: PatternMatch[];
}> = [
	{ kind: "refinement", patterns: REFINEMENT_PATTERNS },
	{ kind: "pushback", patterns: PUSHBACK_PATTERNS },
	{ kind: "behavioral", patterns: BEHAVIORAL_PATTERNS },
	{ kind: "clarification", patterns: CLARIFICATION_PATTERNS },
	{ kind: "smalltalk", patterns: SMALLTALK_PATTERNS },
	{ kind: "acknowledgement", patterns: ACKNOWLEDGEMENT_PATTERNS },
	{ kind: "off_topic_aside", patterns: OFF_TOPIC_ASIDE_PATTERNS },
];

const TECHNICAL_KEYWORDS = [
	"system design",
	"architecture",
	"algorithm",
	"data structure",
	"database",
	"cache",
	"queue",
	"api",
	"sdk",
	"microservice",
	"scalability",
	"latency",
	"throughput",
	"concurrency",
	"distributed",
	"tradeoff",
	"tradeoffs",
	"optimize",
	"optimization",
	"performance",
	"redis",
	"kafka",
	"postgres",
	"mysql",
	"mongodb",
	"kubernetes",
	"docker",
	"aws",
	"gcp",
	"azure",
	"s3",
	"lambda",
	"time complexity",
	"space complexity",
	"big o",
	"leetcode",
	"implement",
	"function",
	"class",
	"method",
];

const BEHAVIORAL_INDICATORS = [
	"tell me about a time",
	"describe a situation",
	"walk me through",
	"have you ever",
	"how did you handle",
	"how would you handle",
	"give me an example of",
	"what was your role",
	"a project where",
];

export class HumanLikeConversationEngine {
	/**
	 * Classify a user utterance into a conversational kind.
	 *
	 * Pure function: no I/O, no LLM. Safe to call on the hot path.
	 */
	classify(utterance: string): ConversationClassification {
		const trimmed = utterance.trim();

		if (!trimmed) {
			return {
				kind: "smalltalk",
				confidence: 0.3,
				verificationLevel: "skip",
				preferFreeForm: true,
				reason: "empty_utterance",
			};
		}

		// Check most specific patterns first (refinement > clarification > smalltalk > ack > aside).
		for (const { kind, patterns } of ALL_PATTERNS) {
			for (const { pattern, refinementIntent } of patterns) {
				if (pattern.test(trimmed)) {
					return this.buildClassification(kind, trimmed, refinementIntent);
				}
			}
		}

		// No conversational pattern matched → treat as a real, technical question.
		return {
			kind: "technical",
			confidence: this.scoreTechnicalConfidence(trimmed),
			verificationLevel: "strict",
			preferFreeForm: false,
			reason: "no_conversational_pattern_matched",
		};
	}

	/**
	 * Quick check: should this utterance bypass the structured conscious schema?
	 *
	 * Returns true for any non-technical conversation kind, so the orchestrator
	 * can route it through a free-form path that feels human.
	 */
	shouldBypassStructuredSchema(utterance: string): boolean {
		const result = this.classify(utterance);
		return result.kind !== "technical" && result.confidence >= 0.5;
	}

	/**
	 * For a given conversation kind, what verification rigor is appropriate?
	 *
	 * - smalltalk / acknowledgement: skip provenance entirely (no factual claims).
	 * - clarification / refinement: relaxed (the previous turn already passed).
	 * - off_topic_aside: moderate (might still be a real question).
	 * - technical: strict (full pipeline).
	 */
	recommendVerificationLevel(kind: ConversationKind): VerificationLevel {
		switch (kind) {
			case "smalltalk":
			case "acknowledgement":
				return "skip";
			case "clarification":
			case "refinement":
				return "relaxed";
			case "off_topic_aside":
				return "moderate";
			case "behavioral":
				return "moderate";
			case "pushback":
				return "strict";
			default:
				return "strict";
		}
	}

	/**
	 * Heuristic confidence that a non-conversational utterance is technical.
	 * Used so callers can decide whether to spend the full conscious budget.
	 */
	private scoreTechnicalConfidence(utterance: string): number {
		const lowered = utterance.toLowerCase();
		let hits = 0;
		for (const keyword of TECHNICAL_KEYWORDS) {
			if (lowered.includes(keyword)) {
				hits += 1;
			}
		}
		for (const indicator of BEHAVIORAL_INDICATORS) {
			if (lowered.includes(indicator)) {
				hits += 1;
			}
		}
		if (hits === 0) {
			// Default: assume technical with moderate confidence so we don't degrade
			// genuine novel questions. The verification gates remain in place.
			return 0.6;
		}
		return Math.min(0.95, 0.6 + hits * 0.1);
	}

	private buildClassification(
		kind: Exclude<ConversationKind, "technical">,
		utterance: string,
		refinementIntent?: RefinementIntent,
	): ConversationClassification {
		const verificationLevel = this.recommendVerificationLevel(kind);
		// Behavioral and pushback should use structured responses (not free-form)
		const preferFreeForm = kind !== "behavioral" && kind !== "pushback";
		return {
			kind,
			confidence: this.confidenceForKind(kind, utterance),
			refinementIntent,
			verificationLevel,
			preferFreeForm,
			reason: `matched_${kind}_pattern`,
		};
	}

	private confidenceForKind(kind: ConversationKind, utterance: string): number {
		const wordCount = utterance.trim().split(/\s+/).filter(Boolean).length;
		switch (kind) {
			case "smalltalk":
			case "acknowledgement":
				// Short utterances strengthen these classifications.
				return wordCount <= 4 ? 0.95 : 0.75;
			case "clarification":
				return 0.9;
			case "refinement":
				return 0.92;
			case "off_topic_aside":
				return 0.85;
			case "behavioral":
				return 0.88;
			case "pushback":
				return 0.9;
			default:
				return 0.7;
		}
	}
}
