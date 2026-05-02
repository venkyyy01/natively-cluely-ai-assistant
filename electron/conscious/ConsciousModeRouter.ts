import { LocalConsciousEmbeddingClassifier } from "./LocalConsciousEmbeddingClassifier";

/**
 * ConsciousModeRouter
 *
 * Unified router for conscious mode. This single module handles:
 *   - Utterance classification (smalltalk, clarification, refinement, technical, etc.)
 *   - Strategy determination (STAR format, code-first, structured answers)
 *   - Verification level selection (strict, moderate, relaxed, skip)
 *   - Response routing (structured vs free-form, bypass decisions)
 *
 * Design principles:
 *   - Single source of truth for conscious mode routing logic
 *   - Hybrid classification: fast embedding-based matching + LLM fallback for low confidence
 *   - Embedding-based classification (~1-2ms) for semantic understanding without LLM latency
 *   - LLM fallback only for ambiguous cases to augment performance loss
 *   - Context-aware for follow-up questions and conversation history
 *   - Clear, predictable behavior
 *   - Feature-flagged for safe rollout
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

export type RefinementIntent =
	| "shorten"
	| "expand"
	| "rephrase"
	| "more_casual"
	| "more_formal"
	| "simplify"
	| "add_example";

export type VerificationLevel = "strict" | "moderate" | "relaxed" | "skip";

export type ResponseShape = "structured" | "free_form";

export interface ConsciousTurnPlan {
	/** The classified conversation kind. */
	kind: ConversationKind;
	/** Confidence score (0-1). */
	confidence: number;
	/** When kind === 'refinement', the specific intent. */
	refinementIntent?: RefinementIntent;
	/** Verification level for this turn. */
	verificationLevel: VerificationLevel;
	/** Which verifiers to run. */
	verification: VerificationPlan;
	/** Response shape: structured JSON or free-form text. */
	responseShape: ResponseShape;
	/** Whether to bypass conscious mode entirely (let standard mode handle it). */
	shouldBypassConscious: boolean;
	/** Strategy hint for the LLM (e.g., "Use STAR format"). */
	strategyHint?: string;
	/** Tone and speech constraints for senior interview answers. */
	tonePreamble?: string;
	/** Human-readable explanation for debugging. */
	reason: string;
}

export interface VerificationPlan {
	/** Run rule-based provenance checks. */
	runProvenance: boolean;
	/** Run deterministic verification. */
	runDeterministic: boolean;
	/** Run LLM judge. */
	runJudge: boolean;
	/** Explanation. */
	reason: string;
}

export interface RouterOptions {
	/** When false, returns legacy strict plan (backward compatibility). */
	enabled: boolean;
	/** Whether the system is in degraded mode. */
	isDegraded?: boolean;
	/** Whether to run provenance in degraded mode. */
	useDegradedProvenanceCheck?: boolean;
	/** Context: inside an active reasoning thread. */
	isInsideThread?: boolean;
	/** Context: mid-coding task. */
	isLiveCoding?: boolean;
	/** Conversation history for context-aware classification (last N utterances). */
	conversationHistory?: string[];
	/** Last question asked (for follow-up detection). */
	lastQuestion?: string;
	/** LLMHelper instance for LLM-based classification. */
	llmHelper?: any;
}

/**
 * Pattern matchers for each conversation kind.
 */
const _PATTERNS: Record<Exclude<ConversationKind, "technical">, RegExp[]> = {
	smalltalk: [
		/^(hi|hello|hey|good morning|good afternoon|good evening)/i,
		/^(how are you|how's it going|what's up)/i,
		/^(thanks|thank you|appreciate it)/i,
		/^(nice to meet you|good to see you)/i,
		/^(bye|goodbye|see you|have a good one)/i,
	],
	clarification: [
		/^(what do you mean|what does that mean)/i,
		/^(can you explain|could you clarify)/i,
		/^(i don't understand|not sure what you mean)/i,
		/^(wait, what|huh)/i,
		/^(so you're saying|so that means)/i,
	],
	refinement: [
		/make it shorter|shorten this|be brief/i,
		/make it longer|expand on this|elaborate more/i,
		/rephrase that|say it differently|put it another way/i,
		/give me an example|provide an instance/i,
		/make it more confident|be more assertive|sound stronger/i,
		/make it casual|be less formal|sound relaxed/i,
		/make it formal|be more professional|sound professional/i,
		/simplify this|make it simpler|explain specifically/i,
	],
	acknowledgement: [
		/^(got it|makes sense|understood|gotcha|ok|okay|right)/i,
		/^(i see|i understand|that makes sense)/i,
		/^(fair|fair enough|sounds good)/i,
		/^(cool|awesome|great|perfect)/i,
	],
	off_topic_aside: [
		/^(oh by the way|btw|one more thing|also)/i,
		/^(can i ask|quick question|side note)/i,
		/^(by the way|before we continue|just curious)/i,
	],
	behavioral: [
		/tell me about a time|describe a situation|describe a time|have you ever|give me an example/i,
		/walk me through.*(time|situation|experience|conflict|failure|project you led)/i,
	],
	pushback: [
		/but what about|why not|why did you|are you sure|doesn't that|wouldn't that/i,
	],
};

const SENIOR_TONE_PREAMBLE = [
	'Use natural Indian English with crisp signposting phrases like "There are three parts..." and "The key tradeoff is...".',
	"Keep each block short: 1-3 sentences, no rambling, no textbook voice.",
	'No filler phrases such as "Let me break this down", "In conclusion", or generic preambles.',
].join(" ");

const BEHAVIORAL_STRATEGY_HINT =
	"Direct answer (1-2 lines). STAR format (Situation, Task, Action, Result). Tradeoff: why this approach over alternatives.";
const CODING_STRATEGY_HINT =
	"Direct answer (1-2 lines). Code-first approach: show implementation, then explain. Tradeoff: performance vs. readability.";
const DEEP_DIVE_STRATEGY_HINT =
	"Direct answer (1-2 lines). Structured approach: constraints → design → tradeoffs → alternatives. Tradeoff: complexity vs. maintainability.";
const PUSHBACK_STRATEGY_HINT =
	'Reframe concern with architectural reasoning. Use template: "That would be a concern if X. In our case, we did Y because Z."';

const _REFINEMENT_PATTERNS: { pattern: RegExp; intent: RefinementIntent }[] = [
	{ pattern: /make it shorter|shorten this|be brief/i, intent: "shorten" },
	{
		pattern: /make it longer|expand on this|elaborate more/i,
		intent: "expand",
	},
	{
		pattern: /rephrase that|say it differently|put it another way/i,
		intent: "rephrase",
	},
	{ pattern: /give me an example|provide an instance/i, intent: "add_example" },
	{
		pattern: /make it more confident|be more assertive|sound stronger/i,
		intent: "more_formal",
	},
	{
		pattern: /make it casual|be less formal|sound relaxed/i,
		intent: "more_casual",
	},
	{
		pattern: /make it formal|be more professional|sound professional/i,
		intent: "more_formal",
	},
	{
		pattern: /simplify this|make it simpler|explain specifically/i,
		intent: "simplify",
	},
];

export class ConsciousModeRouter {
	private localEmbeddingClassifier: LocalConsciousEmbeddingClassifier;
	private classificationCache: Map<string, ConsciousTurnPlan> = new Map();
	private modelInitialized = false;
	private initializationPromise: Promise<void> | null = null;
	private static readonly CACHE_MAX_SIZE = 256;

	constructor() {
		this.localEmbeddingClassifier = new LocalConsciousEmbeddingClassifier();
	}

	/**
	 * Initialize the local embedding model.
	 * Should be called when the app starts or when ConsciousMode initializes.
	 */
	async initialize(): Promise<void> {
		if (this.modelInitialized) {
			return;
		}

		// Guard against concurrent initialize() calls
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		this.initializationPromise = (async () => {
			try {
				await this.localEmbeddingClassifier.initialize();
				this.modelInitialized = true;
				console.log("[ConsciousModeRouter] Local embedding model initialized");
			} catch (error) {
				console.error(
					"[ConsciousModeRouter] Failed to initialize local embedding model:",
					error,
				);
				// Continue without local embeddings - LLM fallback will handle classification
			} finally {
				this.initializationPromise = null;
			}
		})();

		return this.initializationPromise;
	}

	/**
	 * Plan a single conscious turn.
	 *
	 * This is the single entry point for all conscious mode routing decisions.
	 * Uses hybrid classification: fast embedding-based matching + LLM fallback for low confidence.
	 */
	async plan(
		utterance: string,
		options: RouterOptions = { enabled: false },
	): Promise<ConsciousTurnPlan> {
		if (!options.enabled) {
			return this.legacyPlan();
		}

		// Initialize local embedding model if not already done
		if (!this.modelInitialized) {
			await this.initialize();
		}

		// Check cache first
		const cacheKey = this.getCacheKey(utterance, options);
		if (this.classificationCache.has(cacheKey)) {
			const cached = this.classificationCache.get(cacheKey);
			if (cached) return cached;
		}

		// Evict oldest entry if cache is full
		if (this.classificationCache.size >= ConsciousModeRouter.CACHE_MAX_SIZE) {
			const firstKey = this.classificationCache.keys().next().value;
			if (firstKey !== undefined) this.classificationCache.delete(firstKey);
		}

		// In tests and high-confidence hosted routing, prefer the provided LLM helper.
		// The local embedding model can be overconfident on short utterances, so do
		// not let it override an explicit classifier dependency.
		if (options.llmHelper) {
			const plan = await this.llmBasedPlan(utterance, options);
			this.classificationCache.set(cacheKey, plan);
			return plan;
		}

		// Try embedding-based classification first (fast, ~1-2ms)
		const embeddingResult = await this.classifyWithEmbeddings(
			utterance,
			options,
		);
		if (embeddingResult.confidence > 0.75) {
			const plan = this.buildPlanFromClassification(
				embeddingResult,
				utterance,
				options,
				"embedding_classification",
			);
			this.classificationCache.set(cacheKey, plan);
			return plan;
		}

		// Low confidence - fall through to LLM classification (slower, but more accurate)
		const plan = await this.llmBasedPlan(utterance, options);
		this.classificationCache.set(cacheKey, plan);
		return plan;
	}

	/**
	 * Classify utterance using embedding-based semantic matching.
	 * Fast (~1-2ms) and provides semantic understanding without LLM latency.
	 */
	private async classifyWithEmbeddings(
		utterance: string,
		_options: RouterOptions,
	): Promise<{
		kind: ConversationKind;
		confidence: number;
		refinementIntent?: RefinementIntent;
	}> {
		try {
			// Use local embedding classifier if available
			if (this.modelInitialized) {
				return await this.localEmbeddingClassifier.classify(utterance);
			}

			// Fallback to hash-based classification if model not initialized
			return { kind: "technical", confidence: 0.5 };
		} catch (error) {
			console.error(
				"[ConsciousModeRouter] Embedding classification failed:",
				error,
			);
			return { kind: "technical", confidence: 0.5 };
		}
	}

	/**
	 * Generate cache key for classification result.
	 */
	private getCacheKey(utterance: string, options: RouterOptions): string {
		return [
			utterance.trim().toLowerCase(),
			options.isInsideThread,
			options.isLiveCoding,
			options.isDegraded,
			options.useDegradedProvenanceCheck,
			Boolean(options.llmHelper),
		].join("_");
	}

	/**
	 * Legacy plan: always structured, always strict verification.
	 * Used when feature flag is OFF for backward compatibility.
	 */
	private legacyPlan(): ConsciousTurnPlan {
		return {
			kind: "technical",
			confidence: 1.0,
			verificationLevel: "strict",
			verification: this.getVerificationPlan("strict", false, false),
			responseShape: "structured",
			shouldBypassConscious: false,
			reason: "legacy_strict_plan",
		};
	}

	/**
	 * LLM-based plan: classify utterance using LLM for real-world accuracy.
	 * Uses existing LLMHelper infrastructure with fast models.
	 */
	private async llmBasedPlan(
		utterance: string,
		options: RouterOptions,
	): Promise<ConsciousTurnPlan> {
		if (!options.llmHelper) {
			// Fallback to technical plan if no LLMHelper available
			console.warn(
				"[ConsciousModeRouter] No LLMHelper provided, falling back to technical plan",
			);
			return this.technicalPlan(utterance, options);
		}

		try {
			const classification = await this.classifyWithLLM(utterance, options);
			return this.buildPlanFromClassification(
				classification,
				utterance,
				options,
			);
		} catch (error) {
			console.error("[ConsciousModeRouter] LLM classification failed:", error);
			// Fallback to technical plan on error
			return this.technicalPlan(utterance, options);
		}
	}

	/**
	 * Classify utterance using LLMHelper with fast models.
	 */
	private async classifyWithLLM(
		utterance: string,
		options: RouterOptions,
	): Promise<{
		kind: ConversationKind;
		confidence: number;
		refinementIntent?: RefinementIntent;
	}> {
		const context = this.buildContextString(options);

		const prompt = `Classify the following user utterance into one of these categories:
- smalltalk: greetings, thanks, casual conversation
- clarification: asking for clarification or explanation
- refinement: asking to modify previous response (shorten, expand, rephrase, etc.)
- acknowledgement: confirming understanding, agreeing
- off_topic_aside: side note, unrelated question
- behavioral: STAR format interview questions (tell me about a time, describe a situation)
- pushback: interviewer challenge, objection, or skepticism about the answer
- technical: actual interview question (coding, system design, deep dive, etc.)

Utterance: "${utterance}"

${context}

Return JSON with keys: kind (one of the categories above), confidence (0-1), refinementIntent (if kind is refinement, one of: shorten, expand, rephrase, more_casual, more_formal, simplify, add_example)`;

		try {
			const stream = options.llmHelper.streamChat(
				prompt,
				undefined,
				undefined,
				"Classify the utterance concisely. Return JSON only.",
			);
			let response = "";
			for await (const chunk of stream) {
				response += chunk;
			}

			// Parse JSON response
			// Strip markdown code fences if LLM wraps JSON in ```json ... ```
			const cleaned = response
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, "")
				.trim();
			const parsed = JSON.parse(cleaned);
			const validKinds: ConversationKind[] = [
				"smalltalk",
				"clarification",
				"refinement",
				"acknowledgement",
				"off_topic_aside",
				"behavioral",
				"pushback",
				"technical",
			];
			const kind: ConversationKind = validKinds.includes(parsed.kind)
				? parsed.kind
				: "technical";
			const confidence =
				typeof parsed.confidence === "number" &&
				parsed.confidence >= 0 &&
				parsed.confidence <= 1
					? parsed.confidence
					: 0.7;
			return { kind, confidence, refinementIntent: parsed.refinementIntent };
		} catch (error) {
			console.error(
				"[ConsciousModeRouter] Failed to parse LLM classification response:",
				error,
			);
			return { kind: "technical", confidence: 0.5 };
		}
	}

	/**
	 * Build context string from conversation history.
	 */
	private buildContextString(options: RouterOptions): string {
		const parts: string[] = [];

		if (options.lastQuestion) {
			parts.push(`Previous question: ${options.lastQuestion}`);
		}

		if (options.conversationHistory && options.conversationHistory.length > 0) {
			parts.push(
				`Conversation history: ${options.conversationHistory.slice(-3).join(" | ")}`,
			);
		}

		if (options.isInsideThread) {
			parts.push("Context: Inside active reasoning thread");
		}

		if (options.isLiveCoding) {
			parts.push("Context: Live coding session");
		}

		return parts.length > 0 ? parts.join("\n") : "";
	}

	/**
	 * Build plan from LLM classification result.
	 */
	private buildPlanFromClassification(
		classification: {
			kind: ConversationKind;
			confidence: number;
			refinementIntent?: RefinementIntent;
		},
		utterance: string,
		options: RouterOptions,
		reason: string = "llm_classification",
	): ConsciousTurnPlan {
		if (classification.kind === "technical") {
			return this.technicalPlan(utterance, options);
		}

		if (classification.kind === "behavioral") {
			return this.behavioralPlan(classification.confidence, reason, options);
		}

		if (classification.kind === "pushback") {
			return this.pushbackPlan(classification.confidence, reason, options);
		}

		const verificationLevel = this.defaultVerificationLevel(
			classification.kind,
		);
		const verification = this.getVerificationPlan(
			verificationLevel,
			options.isDegraded ?? false,
			options.useDegradedProvenanceCheck ?? false,
		);

		return {
			kind: classification.kind,
			confidence: classification.confidence,
			refinementIntent: classification.refinementIntent,
			verificationLevel,
			verification,
			responseShape: "free_form",
			shouldBypassConscious:
				classification.kind === "smalltalk" ||
				classification.kind === "acknowledgement",
			reason,
		};
	}

	/**
	 * Build a plan for technical questions.
	 */
	private technicalPlan(
		utterance: string,
		options: RouterOptions,
	): ConsciousTurnPlan {
		let verificationLevel: VerificationLevel = "strict";
		let strategyHint: string | undefined;

		// Detect behavioral question patterns (broadened to catch real transcript variations)
		if (
			/\b(tell me about a time|describe a situation|describe a time|have you ever|give me an example|walk me through)\b/i.test(
				utterance,
			)
		) {
			return this.behavioralPlan(0.7, "behavioral_question_detected", options);
		}
		// Detect coding/technical patterns
		else if (
			/\b(design a|implement|build|architect|algorithm|data structure|system design)\b/i.test(
				utterance,
			)
		) {
			strategyHint = CODING_STRATEGY_HINT;
		}
		// Detect deep dive patterns
		else if (
			/\b(explain how|how does|complexity|scalability|latency|throughput|concurrency)\b/i.test(
				utterance,
			)
		) {
			strategyHint = DEEP_DIVE_STRATEGY_HINT;
		}

		// Detect pushback patterns - boost verification
		if (
			/\b(but what about|why not|why did you|are you sure|doesn't that|wouldn't that)\b/i.test(
				utterance,
			)
		) {
			return this.pushbackPlan(0.7, "pushback_detected", options);
		}

		// Context adjustments
		if (options.isInsideThread) {
			verificationLevel = "strict";
		}

		if (options.isLiveCoding) {
			strategyHint = "Focus on code correctness and edge cases. Be concise.";
		}

		const verification = this.getVerificationPlan(
			verificationLevel,
			options.isDegraded ?? false,
			options.useDegradedProvenanceCheck ?? false,
		);

		return {
			kind: "technical",
			confidence: 0.7,
			verificationLevel,
			verification,
			responseShape: "structured",
			shouldBypassConscious: false,
			strategyHint,
			tonePreamble: SENIOR_TONE_PREAMBLE,
			reason: "technical_question_detected",
		};
	}

	private behavioralPlan(
		confidence: number,
		reason: string,
		options: RouterOptions,
	): ConsciousTurnPlan {
		const verificationLevel: VerificationLevel = "moderate";
		const verification = this.getVerificationPlan(
			verificationLevel,
			options.isDegraded ?? false,
			options.useDegradedProvenanceCheck ?? false,
		);
		return {
			kind: "behavioral",
			confidence,
			verificationLevel,
			verification,
			responseShape: "structured",
			shouldBypassConscious: false,
			strategyHint: BEHAVIORAL_STRATEGY_HINT,
			tonePreamble: SENIOR_TONE_PREAMBLE,
			reason,
		};
	}

	private pushbackPlan(
		confidence: number,
		reason: string,
		options: RouterOptions,
	): ConsciousTurnPlan {
		const verificationLevel: VerificationLevel = "strict";
		const verification = this.getVerificationPlan(
			verificationLevel,
			options.isDegraded ?? false,
			options.useDegradedProvenanceCheck ?? false,
		);
		return {
			kind: "pushback",
			confidence,
			verificationLevel,
			verification,
			responseShape: "structured",
			shouldBypassConscious: false,
			strategyHint: PUSHBACK_STRATEGY_HINT,
			tonePreamble: SENIOR_TONE_PREAMBLE,
			reason,
		};
	}

	/**
	 * Get verification plan for a given level.
	 */
	private getVerificationPlan(
		level: VerificationLevel,
		isDegraded: boolean,
		useDegradedProvenance: boolean,
	): VerificationPlan {
		const basePlan: VerificationPlan = (() => {
			switch (level) {
				case "strict":
					return {
						runProvenance: true,
						runDeterministic: true,
						runJudge: true,
						reason: "strict_verification_all_checkers",
					};
				case "moderate":
					return {
						runProvenance: true,
						runDeterministic: true,
						runJudge: false,
						reason: "moderate_verification_skip_judge",
					};
				case "relaxed":
					return {
						runProvenance: true,
						runDeterministic: false,
						runJudge: false,
						reason: "relaxed_verification_provenance_only",
					};
				case "skip":
					return {
						runProvenance: false,
						runDeterministic: false,
						runJudge: false,
						reason: "skip_verification_all_disabled",
					};
				default:
					return {
						runProvenance: true,
						runDeterministic: true,
						runJudge: true,
						reason: "unknown_level_default_strict",
					};
			}
		})();

		if (!isDegraded) {
			return basePlan;
		}

		// In degraded mode, skip judge, optionally run provenance
		return {
			runProvenance: useDegradedProvenance && basePlan.runProvenance,
			runDeterministic: basePlan.runDeterministic,
			runJudge: false,
			reason: `${basePlan.reason}_degraded_mode`,
		};
	}

	/**
	 * Get default verification level for a conversation kind.
	 */
	private defaultVerificationLevel(
		kind: Exclude<ConversationKind, "technical">,
	): VerificationLevel {
		switch (kind) {
			case "smalltalk":
			case "acknowledgement":
				return "skip";
			case "clarification":
			case "off_topic_aside":
				return "relaxed";
			case "refinement":
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
	 * Check if a refinement would be useful for a given response.
	 */
	isRefinementUseful(input: {
		intent: RefinementIntent;
		previousAnswer: string;
	}): boolean {
		const { intent, previousAnswer } = input;

		if (intent === "shorten" && previousAnswer.length < 40) {
			return false;
		}

		if (intent === "expand" && previousAnswer.length > 80) {
			return false;
		}

		if (intent === "simplify" && this.isAlreadySimple(previousAnswer)) {
			return false;
		}

		return true;
	}

	/**
	 * Generate LLM prompt instruction for a refinement request.
	 */
	buildRefinementPrompt(input: {
		previousAnswer: string;
		refinementIntent: RefinementIntent;
		lastQuestion?: string;
		userRequest: string;
	}): string {
		const instructions: Record<RefinementIntent, string> = {
			shorten:
				"Make this response more concise while keeping the key points. Remove unnecessary details.",
			expand:
				"Expand this response with more detail and explanation. Add relevant context.",
			rephrase:
				"Rephrase this response in different words while keeping the same meaning.",
			more_casual:
				"Make this response more casual and conversational. Use contractions and simpler language.",
			more_formal:
				"Make this response more formal and professional. Use proper grammar and formal language.",
			simplify:
				"Simplify this response. Use simpler words and shorter sentences.",
			add_example: "Add a concrete example to illustrate this response.",
		};

		const instruction = instructions[input.refinementIntent];

		return `Original response: "${input.previousAnswer}"

${instruction}

${input.lastQuestion ? `Question: ${input.lastQuestion}` : ""}

User request: "${input.userRequest}"

Provide the refined response.`;
	}

	private isAlreadySimple(response: string): boolean {
		const words = response.split(/\s+/);
		if (words.length === 0) return true;

		const avgWordLength =
			words.reduce((sum, word) => sum + word.length, 0) / words.length;
		const sentenceCount = response.split(/[.!?]/).length;
		const avgSentenceLength = words.length / sentenceCount;

		return avgWordLength < 4 && avgSentenceLength < 15;
	}
}
