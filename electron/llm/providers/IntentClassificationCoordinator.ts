import { Metrics } from "../../runtime/Metrics";
import {
	endSpan,
	setSpanAttribute,
	startSpan,
	startTrace,
	traceLogger,
} from "../../tracing";
import { getAnswerShapeGuidance, type IntentResult } from "../IntentClassifier";
import { getIntentConfidenceService } from "../IntentConfidenceService";
import { PIPELINE_INTENT_THRESHOLDS } from "../intentConfidenceCalibration";
import {
	getIntentProviderErrorCode,
	type IntentClassificationInput,
	type IntentInferenceProvider,
	type IntentProviderErrorType,
} from "./IntentInferenceProvider";

export interface CoordinatedIntentResult extends IntentResult {
	provider: string;
	retryCount: number;
	fallbackReason?:
		| "primary_unavailable"
		| "primary_retries_exhausted"
		| "primary_failed"
		| "primary_low_confidence"
		| "primary_contradiction";
}

export interface IntentClassificationCoordinatorOptions {
	maxPrimaryRetries?: number;
	baseBackoffMs?: number;
	jitterMs?: number;
	minimumPrimaryConfidence?: number;
	contradictionDeltaConfidence?: number;
	pairwiseDisambiguationMargin?: number;
	delayFn?: (ms: number) => Promise<void>;
	randomFn?: () => number;
	// NAT-039: when set to 0, disables in-process dedupe entirely (used by
	// tests that rely on counting raw provider invocations). Negative values
	// are clamped to 0. Inputs without a `transcriptRevision` always bypass
	// the cache regardless of this value, since we have no isolation key.
	dedupeTtlMs?: number;
	// NAT-039: injectable clock so tests can deterministically advance the
	// dedupe TTL without sleeping. Defaults to `Date.now`.
	nowFn?: () => number;
}

const DEFAULT_MAX_PRIMARY_RETRIES = 2;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_JITTER_MS = 50;
const DEFAULT_CONTRADICTION_DELTA_CONFIDENCE = 0.18;
const DEFAULT_PAIRWISE_DISAMBIGUATION_MARGIN = 0.08;

// NAT-039 / audit P-4: in-process dedupe TTL for `(revision, question)`.
// Sized for the worst-case window between a speculative classify-on-pause
// and the actual user-driven classify on commit; long enough to absorb
// duplicate calls from a single turn, short enough that a stale entry
// cannot survive into a new turn even if the consumer forgot to bump
// the revision (defense in depth alongside the explicit revision key).
const DEFAULT_DEDUPE_TTL_MS = 1500;

const FOLLOW_UP_CUES = [
	"what happened next",
	"then what",
	"after that",
	"next",
];

const SUMMARY_PROBE_CUES = [
	"so you are saying",
	"so you're saying",
	"so you re saying",
	"let me make sure",
	"to summarize",
	"so to summarize",
	"if i understood correctly",
	"am i right",
	"just to confirm",
	"do i have this right",
	"to confirm",
	"if i understand correctly",
	"correct me if i am wrong",
	"correct me if i'm wrong",
];

const EXAMPLE_REQUEST_CUES = [
	"concrete example",
	"specific example",
	"concrete instance",
	"specific case",
	"concrete case",
	"real example",
	"practical example",
	"real incident",
	"scenario where",
	"one concrete",
	"one specific",
	"for example",
	"for instance",
	"specific instance",
];

const CLARIFICATION_CUES = [
	"clarify",
	"what do you mean",
	"can you explain",
	"can you unpack",
	"unpack",
	"break down",
	"when you say",
	"when you said",
	"what behavior should i expect",
	"what behavior should we expect",
	"what should i expect",
	"what exactly do you mean",
	"what exactly is",
	"how so",
];

const BEHAVIORAL_CUES = [
	"tell me about a time",
	"describe a time",
	"describe a situation",
	"walk me through a failure",
	"stakeholder",
	"leadership",
	"influence",
	"conflict with",
	"disagreed",
];

const BEHAVIORAL_AMBIGUOUS_CUES = [
	"tell me about your experience",
	"describe a situation",
	"how do you manage",
	"how do you prioritize",
	"give me an example",
	"walk me through your experience",
	"what is your",
	"style",
];

const CODING_CUES = [
	"implement",
	"write code",
	"debug",
	"algorithm",
	"lru",
	"typescript",
	"javascript",
	"api payload",
	"handler code",
	"function",
	"refactor",
	"snippet",
];

const DEEP_DIVE_CUES = [
	"tradeoff",
	"trade-off",
	"why would you choose",
	"why choose",
	"why not",
	"compare",
	"versus",
	"vs ",
	"consistency",
	"availability",
	"latency",
	"freshness",
	"throughput",
	"distributed systems",
	"microservice",
	"load balancer",
	"consensus",
	"raft",
	"sharding",
	"replication",
	"rate limiting",
	"circuit breaker",
	"idempotency",
	"backpressure",
	"system design",
	"design a",
	"design an",
	"how would you build",
	"how would you design",
	"how would you scale",
	"how would you handle",
	"how would you approach",
	"architecture",
	"scalability",
	"partition tolerance",
	"eventual consistency",
	"strong consistency",
	"concurrency",
	"parallelism",
	"deadlock",
	"race condition",
	"big o",
	"time complexity",
	"hash table",
	"binary search",
	"graph",
	"sorting",
	"dynamic programming",
	"database",
	"indexing",
	"transaction",
	"acid",
	"docker",
	"kubernetes",
	"redis",
	"kafka",
	"postgres",
	"mongodb",
	"caching",
	"queue",
	"pipeline",
];

const PAIRWISE_DEEP_DIVE_VS_CLARIFICATION: readonly IntentResult["intent"][] = [
	"deep_dive",
	"clarification",
];
const PAIRWISE_EXAMPLE_REQUEST_VS_DEEP_DIVE: readonly IntentResult["intent"][] =
	["example_request", "deep_dive"];
const PAIRWISE_FOLLOW_UP_VS_SUMMARY_PROBE: readonly IntentResult["intent"][] = [
	"follow_up",
	"summary_probe",
];
const PAIRWISE_BEHAVIORAL_VS_DEEP_DIVE: readonly IntentResult["intent"][] = [
	"behavioral",
	"deep_dive",
];
const PAIRWISE_CLARIFICATION_VS_EXAMPLE: readonly IntentResult["intent"][] = [
	"clarification",
	"example_request",
];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(code: IntentProviderErrorType): boolean {
	return (
		code === "rate_limited" ||
		code === "timeout" ||
		code === "refusal" ||
		code === "model_not_ready" ||
		code === "unknown"
	);
}

export class IntentClassificationCoordinator {
	private readonly maxPrimaryRetries: number;
	private readonly baseBackoffMs: number;
	private readonly jitterMs: number;
	private readonly minimumPrimaryConfidence: number;
	private readonly contradictionDeltaConfidence: number;
	private readonly pairwiseDisambiguationMargin: number;
	private readonly delayFn: (ms: number) => Promise<void>;
	private readonly randomFn: () => number;
	private readonly dedupeTtlMs: number;
	private readonly nowFn: () => number;
	// NAT-039: in-process dedupe of in-flight + recently-resolved coordinator
	// results, keyed on `${transcriptRevision}|${normalizedQuestion}`. We
	// store the *promise* (not the resolved value) so concurrent callers
	// share a single underlying classify pipeline; subsequent callers within
	// the TTL receive the same cached promise reference.
	private readonly dedupeCache = new Map<
		string,
		{ promise: Promise<CoordinatedIntentResult>; expiresAt: number }
	>();

	constructor(
		private readonly primary: IntentInferenceProvider,
		private readonly fallback: IntentInferenceProvider,
		options: IntentClassificationCoordinatorOptions = {},
	) {
		this.maxPrimaryRetries =
			options.maxPrimaryRetries ?? DEFAULT_MAX_PRIMARY_RETRIES;
		this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
		this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
		this.minimumPrimaryConfidence =
			options.minimumPrimaryConfidence ??
			PIPELINE_INTENT_THRESHOLDS.primaryMinConfidence;
		this.contradictionDeltaConfidence =
			options.contradictionDeltaConfidence ??
			DEFAULT_CONTRADICTION_DELTA_CONFIDENCE;
		this.pairwiseDisambiguationMargin =
			options.pairwiseDisambiguationMargin ??
			DEFAULT_PAIRWISE_DISAMBIGUATION_MARGIN;
		this.delayFn = options.delayFn ?? sleep;
		this.randomFn = options.randomFn ?? Math.random;
		this.dedupeTtlMs = Math.max(
			0,
			options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
		);
		this.nowFn = options.nowFn ?? Date.now;
	}

	private normalizeText(value: string | null): string {
		return (value || "")
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private includesAnyCue(text: string, cues: readonly string[]): boolean {
		return cues.some((cue) => text.includes(cue));
	}

	private inferLikelyIntentFromQuestion(
		input: IntentClassificationInput,
	): IntentResult["intent"] | null {
		const questionText = this.normalizeText(input.lastInterviewerTurn);
		if (!questionText) {
			return null;
		}

		if (this.includesAnyCue(questionText, CODING_CUES)) {
			return "coding";
		}

		if (this.includesAnyCue(questionText, SUMMARY_PROBE_CUES)) {
			return "summary_probe";
		}

		if (this.includesAnyCue(questionText, FOLLOW_UP_CUES)) {
			return "follow_up";
		}

		if (this.includesAnyCue(questionText, CLARIFICATION_CUES)) {
			return "clarification";
		}

		const codingAndExample =
			this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES) &&
			this.includesAnyCue(questionText, CODING_CUES);
		if (codingAndExample) {
			return "coding";
		}

		if (this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES)) {
			return "example_request";
		}

		// Weighted behavioral vs deep_dive resolution:
		// If only strong behavioral cues → behavioral
		// If strong behavioral + deep_dive cues → deep_dive (technical cues are more specific)
		// If ambiguous behavioral + deep_dive cues → deep_dive
		const hasStrongBehavioral = this.includesAnyCue(
			questionText,
			BEHAVIORAL_CUES,
		);
		const hasAmbiguousBehavioral = this.includesAnyCue(
			questionText,
			BEHAVIORAL_AMBIGUOUS_CUES,
		);
		const hasDeepDive = this.includesAnyCue(questionText, DEEP_DIVE_CUES);

		if (hasStrongBehavioral && !hasDeepDive) {
			return "behavioral";
		}
		if (hasDeepDive) {
			return "deep_dive";
		}
		if (hasAmbiguousBehavioral) {
			return "behavioral";
		}

		return null;
	}

	private choosePairwiseLabel(
		first: IntentResult,
		second: IntentResult,
		pair: readonly IntentResult["intent"][],
	): IntentResult["intent"] | null {
		if (!pair.includes(first.intent) && !pair.includes(second.intent)) {
			return null;
		}

		if (pair.includes(first.intent) && !pair.includes(second.intent)) {
			return first.intent;
		}

		if (!pair.includes(first.intent) && pair.includes(second.intent)) {
			return second.intent;
		}

		const firstScore = first.confidence;
		const secondScore = second.confidence;
		if (
			Math.abs(firstScore - secondScore) <= this.pairwiseDisambiguationMargin
		) {
			return null;
		}

		return firstScore >= secondScore ? first.intent : second.intent;
	}

	private applyPairwiseDisambiguation(
		input: IntentClassificationInput,
		primary: IntentResult,
		fallback: IntentResult,
	): IntentResult | null {
		const likelyIntent = this.inferLikelyIntentFromQuestion(input);

		const clarificationVsDeepDiveCue =
			likelyIntent === "clarification" || likelyIntent === "deep_dive";
		if (clarificationVsDeepDiveCue) {
			const chosen = this.choosePairwiseLabel(
				primary,
				fallback,
				PAIRWISE_DEEP_DIVE_VS_CLARIFICATION,
			);
			if (chosen) {
				if (primary.intent === chosen) {
					return primary;
				}
				if (fallback.intent === chosen) {
					return fallback;
				}
			}
		}

		const exampleVsDeepDiveCue =
			likelyIntent === "example_request" || likelyIntent === "deep_dive";
		if (exampleVsDeepDiveCue) {
			const chosen = this.choosePairwiseLabel(
				primary,
				fallback,
				PAIRWISE_EXAMPLE_REQUEST_VS_DEEP_DIVE,
			);
			if (chosen) {
				if (primary.intent === chosen) {
					return primary;
				}
				if (fallback.intent === chosen) {
					return fallback;
				}
			}
		}

		const followUpVsSummaryProbeCue =
			likelyIntent === "follow_up" || likelyIntent === "summary_probe";
		if (followUpVsSummaryProbeCue) {
			const chosen = this.choosePairwiseLabel(
				primary,
				fallback,
				PAIRWISE_FOLLOW_UP_VS_SUMMARY_PROBE,
			);
			if (chosen) {
				if (primary.intent === chosen) {
					return primary;
				}
				if (fallback.intent === chosen) {
					return fallback;
				}
			}
		}

		const behavioralVsDeepDiveCue =
			likelyIntent === "behavioral" || likelyIntent === "deep_dive";
		if (behavioralVsDeepDiveCue) {
			const chosen = this.choosePairwiseLabel(
				primary,
				fallback,
				PAIRWISE_BEHAVIORAL_VS_DEEP_DIVE,
			);
			if (chosen) {
				if (primary.intent === chosen) {
					return primary;
				}
				if (fallback.intent === chosen) {
					return fallback;
				}
			}
		}

		const clarificationVsExampleCue =
			likelyIntent === "clarification" || likelyIntent === "example_request";
		if (clarificationVsExampleCue) {
			const chosen = this.choosePairwiseLabel(
				primary,
				fallback,
				PAIRWISE_CLARIFICATION_VS_EXAMPLE,
			);
			if (chosen) {
				if (primary.intent === chosen) {
					return primary;
				}
				if (fallback.intent === chosen) {
					return fallback;
				}
			}
		}

		return null;
	}

	private shouldPreferPrimaryOnFallbackLowConfidence(
		primary: IntentResult,
		fallback: IntentResult,
		likelyIntent: IntentResult["intent"] | null,
	): boolean {
		const fallbackLooksWeak =
			fallback.intent === "general" || fallback.confidence <= 0.58;
		if (!fallbackLooksWeak) {
			return false;
		}

		if (likelyIntent && primary.intent === likelyIntent) {
			return true;
		}

		return primary.confidence >= 0.5;
	}

	private hasStrongCueForLikelyIntent(
		input: IntentClassificationInput,
		likelyIntent: IntentResult["intent"],
	): boolean {
		const questionText = this.normalizeText(input.lastInterviewerTurn);
		if (!questionText) {
			return false;
		}

		switch (likelyIntent) {
			case "follow_up":
				return this.includesAnyCue(questionText, FOLLOW_UP_CUES);
			case "summary_probe":
				return this.includesAnyCue(questionText, SUMMARY_PROBE_CUES);
			case "clarification":
				return this.includesAnyCue(questionText, CLARIFICATION_CUES);
			case "example_request":
				return this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES);
			case "deep_dive":
				return this.includesAnyCue(questionText, DEEP_DIVE_CUES);
			case "coding":
				return this.includesAnyCue(questionText, CODING_CUES);
			case "behavioral":
				return (
					this.includesAnyCue(questionText, BEHAVIORAL_CUES) ||
					this.includesAnyCue(questionText, BEHAVIORAL_AMBIGUOUS_CUES)
				);
			default:
				return false;
		}
	}

	private isLowConfidence(result: IntentResult): boolean {
		return result.confidence < this.minimumPrimaryConfidence;
	}

	private isContradiction(
		likelyIntent: IntentResult["intent"],
		strongLikelyCue: boolean,
		primary: IntentResult,
		fallback: IntentResult,
	): boolean {
		const primaryMatchesLikely = primary.intent === likelyIntent;
		const fallbackMatchesLikely = fallback.intent === likelyIntent;
		const confidenceGap = fallback.confidence - primary.confidence;

		return (
			!primaryMatchesLikely &&
			fallbackMatchesLikely &&
			(strongLikelyCue || confidenceGap >= this.contradictionDeltaConfidence)
		);
	}

	private createFallbackResult(
		result: IntentResult,
		retryCount: number,
		reason: CoordinatedIntentResult["fallbackReason"],
	): CoordinatedIntentResult {
		return {
			...result,
			provider: this.fallback.name,
			retryCount,
			fallbackReason: reason,
		};
	}

	private resolveLowConfidenceDecision(
		input: IntentClassificationInput,
		primary: IntentResult,
		fallback: IntentResult,
		retryCount: number,
	): CoordinatedIntentResult {
		const likelyIntent = this.inferLikelyIntentFromQuestion(input);

		if (
			this.shouldPreferPrimaryOnFallbackLowConfidence(
				primary,
				fallback,
				likelyIntent,
			)
		) {
			return {
				...primary,
				provider: this.primary.name,
				retryCount,
			};
		}

		const pairwiseResult = this.applyPairwiseDisambiguation(
			input,
			primary,
			fallback,
		);
		if (pairwiseResult) {
			if (pairwiseResult === primary) {
				return {
					...primary,
					provider: this.primary.name,
					retryCount,
				};
			}
			return this.createFallbackResult(
				fallback,
				retryCount,
				"primary_contradiction",
			);
		}

		if (likelyIntent) {
			const strongLikelyCue = this.hasStrongCueForLikelyIntent(
				input,
				likelyIntent,
			);
			const primaryMatchesLikely = primary.intent === likelyIntent;
			const fallbackMatchesLikely = fallback.intent === likelyIntent;

			const primaryGeneralFallback =
				likelyIntent === "general" &&
				primary.intent !== "general" &&
				fallback.intent === "general";
			if (primaryGeneralFallback) {
				return {
					...primary,
					provider: this.primary.name,
					retryCount,
				};
			}

			if (primaryMatchesLikely && !fallbackMatchesLikely) {
				return {
					...primary,
					provider: this.primary.name,
					retryCount,
				};
			}

			if (fallbackMatchesLikely && !primaryMatchesLikely) {
				if (
					strongLikelyCue ||
					fallback.confidence - primary.confidence >=
						this.contradictionDeltaConfidence
				) {
					return this.createFallbackResult(
						fallback,
						retryCount,
						"primary_contradiction",
					);
				}
			}
		}

		return this.createFallbackResult(
			fallback,
			retryCount,
			"primary_low_confidence",
		);
	}

	private resolveFallbackOnPrimaryFailure(
		input: IntentClassificationInput,
		primaryErrorCode: IntentProviderErrorType,
		retryable: boolean,
		retryCount: number,
		fallback: IntentResult,
	): CoordinatedIntentResult {
		const likelyIntent = this.inferLikelyIntentFromQuestion(input);
		const strongLikelyCue =
			likelyIntent &&
			likelyIntent !== "general" &&
			this.hasStrongCueForLikelyIntent(input, likelyIntent);

		const canOverrideWeakGeneralFallback =
			likelyIntent &&
			strongLikelyCue &&
			fallback.intent === "general" &&
			fallback.confidence <= 0.5;
		if (canOverrideWeakGeneralFallback) {
			return {
				...fallback,
				intent: likelyIntent,
				confidence: Math.max(0.62, fallback.confidence),
				answerShape: getAnswerShapeGuidance(likelyIntent),
				provider: this.fallback.name,
				retryCount,
				fallbackReason: "primary_low_confidence",
			};
		}

		const canOverrideWeakMismatchedFallback =
			likelyIntent &&
			strongLikelyCue &&
			fallback.intent !== likelyIntent &&
			fallback.confidence <= 0.58;
		if (canOverrideWeakMismatchedFallback) {
			return {
				...fallback,
				intent: likelyIntent,
				confidence: Math.max(0.62, fallback.confidence),
				answerShape: getAnswerShapeGuidance(likelyIntent),
				provider: this.fallback.name,
				retryCount,
				fallbackReason: "primary_low_confidence",
			};
		}

		return this.createFallbackResult(
			fallback,
			retryCount,
			retryable
				? "primary_retries_exhausted"
				: primaryErrorCode === "unavailable" ||
						primaryErrorCode === "unsupported_locale"
					? "primary_unavailable"
					: "primary_failed",
		);
	}

	private async classifyWithFallback(
		input: IntentClassificationInput,
	): Promise<IntentResult> {
		return this.fallback.classify(input);
	}

	// NAT-039: build the dedupe key. Returns null when caching is disabled
	// (TTL=0) or when we lack the inputs needed to safely isolate cache
	// entries across transcript turns. The transcript revision is required:
	// without it, a cached entry from an old turn could be served to a new
	// one. The normalized question text is also required so that two
	// different questions in the same revision can never collide.
	private buildDedupeKey(input: IntentClassificationInput): string | null {
		if (this.dedupeTtlMs <= 0) {
			return null;
		}
		if (
			typeof input.transcriptRevision !== "number" ||
			!Number.isFinite(input.transcriptRevision)
		) {
			return null;
		}
		const normalizedQuestion = this.normalizeText(input.lastInterviewerTurn);
		if (!normalizedQuestion) {
			return null;
		}
		return `${input.transcriptRevision}|${normalizedQuestion}`;
	}

	// NAT-039: lazy purge of expired entries on every classify call. We
	// tolerate a small amount of dead state between calls in exchange for
	// not running a timer on a hot path; the cache is bounded by the number
	// of distinct (revision, question) pairs in any 1.5s window, which in
	// practice is a handful at most.
	private purgeExpiredDedupeEntries(now: number): void {
		for (const [key, entry] of this.dedupeCache) {
			if (entry.expiresAt <= now) {
				this.dedupeCache.delete(key);
			}
		}
	}

	async classify(
		input: IntentClassificationInput,
	): Promise<CoordinatedIntentResult> {
		const startedAt = this.nowFn();
		const now = startedAt;
		this.purgeExpiredDedupeEntries(now);

		// NAT-XXX: Start trace for intent classification
		const traceId =
			input.traceId ??
			`intent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
		const rootSpan = startSpan(traceId, "intent.classification");
		let spanId: string | undefined;

		if (rootSpan) {
			spanId = rootSpan.spanId;
			setSpanAttribute(
				traceId,
				spanId,
				"intent.question",
				input.lastInterviewerTurn?.substring(0, 200) ?? "",
			);
			setSpanAttribute(
				traceId,
				spanId,
				"intent.transcript_revision",
				input.transcriptRevision ?? -1,
			);
			setSpanAttribute(
				traceId,
				spanId,
				"intent.assistant_response_count",
				input.assistantResponseCount,
			);

			traceLogger.logIntentClassificationEvent(traceId, spanId, "started", {
				question: input.lastInterviewerTurn?.substring(0, 200) ?? "",
				transcriptRevision: input.transcriptRevision,
				assistantResponseCount: input.assistantResponseCount,
			});
		}

		const stamp = (
			result: CoordinatedIntentResult,
		): CoordinatedIntentResult => {
			const stamped = getIntentConfidenceService().attachStaleness(
				result,
				input,
				startedAt,
				this.nowFn(),
			) as CoordinatedIntentResult;

			// NAT-XXX: Log completion with result
			if (spanId) {
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.intent",
					stamped.intent,
				);
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.confidence",
					stamped.confidence,
				);
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.provider",
					stamped.provider,
				);
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.retry_count",
					stamped.retryCount,
				);
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.fallback_reason",
					stamped.fallbackReason ?? "none",
				);
				setSpanAttribute(
					traceId,
					spanId,
					"intent.result.staleness_age_ms",
					stamped.staleness?.ageMs ?? 0,
				);

				traceLogger.logIntentClassificationEvent(traceId, spanId, "completed", {
					question: input.lastInterviewerTurn?.substring(0, 200) ?? "",
					transcriptRevision: input.transcriptRevision,
					assistantResponseCount: input.assistantResponseCount,
					result: {
						intent: stamped.intent,
						confidence: stamped.confidence,
						answerShape: stamped.answerShape,
						provider: stamped.provider,
						retryCount: stamped.retryCount,
						fallbackReason: stamped.fallbackReason,
						staleness: stamped.staleness,
					},
				});

				endSpan(traceId, spanId, "ok");
			}

			return stamped;
		};

		try {
			const dedupeKey = this.buildDedupeKey(input);
			if (dedupeKey === null) {
				const raw = await this.classifyUncached(input, traceId, spanId);
				return stamp(raw);
			}

			const cached = this.dedupeCache.get(dedupeKey);
			if (cached && cached.expiresAt > now) {
				Metrics.counter("intent.duplicate_classify_count");
				if (spanId) {
					setSpanAttribute(traceId, spanId, "intent.dedupe_hit", true);
				}
				const raw = await cached.promise;
				return stamp(raw);
			}

			const uncachedPromise = this.classifyUncached(input, traceId, spanId);
			this.dedupeCache.set(dedupeKey, {
				promise: uncachedPromise,
				expiresAt: now + this.dedupeTtlMs,
			});
			uncachedPromise.catch(() => {
				const current = this.dedupeCache.get(dedupeKey);
				if (current && current.promise === uncachedPromise) {
					this.dedupeCache.delete(dedupeKey);
				}
			});
			const raw = await uncachedPromise;
			return stamp(raw);
		} catch (error) {
			// NAT-XXX: Log failure
			if (spanId) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				traceLogger.logIntentClassificationEvent(traceId, spanId, "failed", {
					question: input.lastInterviewerTurn?.substring(0, 200) ?? "",
					transcriptRevision: input.transcriptRevision,
					error: errorMsg,
				});
				endSpan(traceId, spanId, "error", errorMsg);
			}
			throw error;
		}
	}

	private async classifyUncached(
		input: IntentClassificationInput,
		traceId?: string,
		parentSpanId?: string,
	): Promise<CoordinatedIntentResult> {
		const primaryAvailable = await this.primary.isAvailable();
		if (primaryAvailable) {
			let retries = 0;
			while (true) {
				try {
					// NAT-XXX: Trace primary classification
					const span = traceId
						? startSpan(traceId, "intent.classify.primary", parentSpanId)
						: undefined;
					if (span) {
						setSpanAttribute(
							traceId!,
							span.spanId,
							"intent.primary.name",
							this.primary.name,
						);
						setSpanAttribute(
							traceId!,
							span.spanId,
							"intent.retry_count",
							retries,
						);
					}

					const result = await this.primary.classify(input);

					if (span) {
						setSpanAttribute(
							traceId!,
							span.spanId,
							"intent.result.intent",
							result.intent,
						);
						setSpanAttribute(
							traceId!,
							span.spanId,
							"intent.result.confidence",
							result.confidence,
						);
						traceLogger.logModelInvocation(traceId!, span.spanId, {
							modelName: this.primary.name,
							modelVersion: "foundation",
							latencyMs: result.latencyMs,
						});
						endSpan(traceId!, span.spanId, "ok");
					}

					if (this.isLowConfidence(result)) {
						const fallbackSpan = traceId
							? startSpan(traceId, "intent.handle_low_confidence", parentSpanId)
							: undefined;
						const fallbackResult = await this.classifyWithFallback(input);
						const decision = this.resolveLowConfidenceDecision(
							input,
							result,
							fallbackResult,
							retries,
						);
						if (fallbackSpan) {
							setSpanAttribute(
								traceId!,
								fallbackSpan.spanId,
								"intent.decision",
								decision.fallbackReason ?? "primary",
							);
							endSpan(traceId!, fallbackSpan.spanId, "ok");
						}
						return decision;
					}

					const likelyIntent = this.inferLikelyIntentFromQuestion(input);
					if (likelyIntent && result.intent !== likelyIntent) {
						const strongLikelyCue = this.hasStrongCueForLikelyIntent(
							input,
							likelyIntent,
						);
						const fallbackSpan = traceId
							? startSpan(traceId, "intent.check_contradiction", parentSpanId)
							: undefined;
						const fallbackResult = await this.classifyWithFallback(input);
						if (
							this.isContradiction(
								likelyIntent,
								strongLikelyCue,
								result,
								fallbackResult,
							)
						) {
							if (fallbackSpan) {
								setSpanAttribute(
									traceId!,
									fallbackSpan.spanId,
									"intent.contradiction",
									true,
								);
								setSpanAttribute(
									traceId!,
									fallbackSpan.spanId,
									"intent.decision",
									"fallback",
								);
								endSpan(traceId!, fallbackSpan.spanId, "ok");
							}
							return this.createFallbackResult(
								fallbackResult,
								retries,
								"primary_contradiction",
							);
						}
						if (fallbackSpan) {
							endSpan(traceId!, fallbackSpan.spanId, "ok");
						}
					}

					return {
						...result,
						provider: this.primary.name,
						retryCount: retries,
					};
				} catch (error) {
					const code = getIntentProviderErrorCode(error);
					const retryable = isRetryableError(code);
					if (!retryable || retries >= this.maxPrimaryRetries) {
						const fallbackSpan = traceId
							? startSpan(traceId, "intent.handle_error", parentSpanId)
							: undefined;
						const fallbackResult = await this.classifyWithFallback(input);
						const decision = this.resolveFallbackOnPrimaryFailure(
							input,
							code,
							retryable,
							retries,
							fallbackResult,
						);
						if (fallbackSpan) {
							setSpanAttribute(
								traceId!,
								fallbackSpan.spanId,
								"intent.fallback.reason",
								decision.fallbackReason ?? "unknown",
							);
							endSpan(traceId!, fallbackSpan.spanId, "ok");
						}
						return decision;
					}

					retries += 1;
					const base = this.baseBackoffMs * 2 ** retries;
					const jitter =
						this.jitterMs > 0 ? Math.floor(this.randomFn() * this.jitterMs) : 0;
					await this.delayFn(base + jitter);
				}
			}
		}

		const fallbackSpan = traceId
			? startSpan(traceId, "intent.classify.fallback_unavailable", parentSpanId)
			: undefined;
		const fallbackResult = await this.classifyWithFallback(input);
		if (fallbackSpan) {
			setSpanAttribute(
				traceId!,
				fallbackSpan.spanId,
				"intent.fallback.reason",
				"primary_unavailable",
			);
			endSpan(traceId!, fallbackSpan.spanId, "ok");
		}
		return this.createFallbackResult(fallbackResult, 0, "primary_unavailable");
	}
}
