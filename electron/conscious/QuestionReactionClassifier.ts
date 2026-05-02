import type {
	ConsciousModeStructuredResponse,
	ReasoningThread,
} from "../ConsciousMode";
import { isVerifierOptimizationActive } from "../config/optimizations";
import type { AnswerHypothesis } from "./AnswerHypothesisStore";
import { SetFitReactionClassifier } from "./SetFitReactionClassifier";

export type QuestionReactionKind =
	| "fresh_question"
	| "challenge"
	| "tradeoff_probe"
	| "metric_probe"
	| "example_request"
	| "clarification"
	| "repeat_request"
	| "deep_dive"
	| "topic_shift"
	| "generic_follow_up";

export interface QuestionReaction {
	kind: QuestionReactionKind;
	confidence: number;
	cues: string[];
	targetFacets: string[];
	shouldContinueThread: boolean;
}

function includesAny(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function hasGenericFollowUpCue(text: string): boolean {
	return includesAny(text, [
		/^(and|but|so)\b/i,
		/\b(this|that|it|those|these|them|there|then)\b/i,
		/\b(still|also|instead|too)\b/i,
		/\b(approach|design|system|choice|tradeoff|part|layer|path|flow)\b/i,
	]);
}

function collectTargets(
	response?: ConsciousModeStructuredResponse | null,
): string[] {
	if (!response) {
		return [];
	}

	const targets: string[] = [];
	if (response.tradeoffs.length > 0) targets.push("tradeoffs");
	if (response.implementationPlan.length > 0)
		targets.push("implementationPlan");
	if (response.edgeCases.length > 0) targets.push("edgeCases");
	if (response.scaleConsiderations.length > 0)
		targets.push("scaleConsiderations");
	if (response.pushbackResponses.length > 0) targets.push("pushbackResponses");
	if (response.codeTransition) targets.push("codeTransition");
	return targets;
}

export class QuestionReactionClassifier {
	private setFitClassifier = new SetFitReactionClassifier();

	classify(input: {
		question: string;
		activeThread: ReasoningThread | null;
		latestResponse?: ConsciousModeStructuredResponse | null;
		latestHypothesis?: AnswerHypothesis | null;
	}): QuestionReaction {
		const normalized = input.question.trim();
		const lower = normalized.toLowerCase();
		const hasThread = !!input.activeThread;
		const targetFacets = collectTargets(input.latestResponse);
		const _cues: string[] = [];

		if (!hasThread) {
			return {
				kind: "fresh_question",
				confidence: 0.45,
				cues: normalized ? ["no_active_thread"] : [],
				targetFacets,
				shouldContinueThread: false,
			};
		}

		// Fallback to regex-based classification (synchronous)
		return this.classifyWithRegex(normalized, lower, targetFacets);
	}

	async classifyAsync(input: {
		question: string;
		activeThread: ReasoningThread | null;
		latestResponse?: ConsciousModeStructuredResponse | null;
		latestHypothesis?: AnswerHypothesis | null;
	}): Promise<QuestionReaction> {
		const normalized = input.question.trim();
		const hasThread = !!input.activeThread;
		const targetFacets = collectTargets(input.latestResponse);

		if (!hasThread) {
			return {
				kind: "fresh_question",
				confidence: 0.45,
				cues: normalized ? ["no_active_thread"] : [],
				targetFacets,
				shouldContinueThread: false,
			};
		}

		// Try SetFit classification if flag is enabled
		const useSetFit = isVerifierOptimizationActive("useSetFitReactions");
		if (useSetFit) {
			try {
				const setFitResult = await this.setFitClassifier.classify(normalized);
				if (setFitResult) {
					// SetFit classification with high confidence
					return this.buildReactionFromSetFit(setFitResult, targetFacets);
				}
			} catch (error) {
				console.warn(
					"[QuestionReactionClassifier] SetFit classification failed, falling back to regex:",
					error,
				);
			}
		}

		// Fallback to regex-based classification
		const lower = normalized.toLowerCase();
		return this.classifyWithRegex(normalized, lower, targetFacets);
	}

	private buildReactionFromSetFit(
		setFitResult: { kind: QuestionReactionKind; confidence: number },
		targetFacets: string[],
	): QuestionReaction {
		const kindToShouldContinue: Record<QuestionReactionKind, boolean> = {
			fresh_question: false,
			challenge: true,
			tradeoff_probe: true,
			metric_probe: true,
			example_request: true,
			clarification: true,
			repeat_request: false,
			deep_dive: true,
			topic_shift: false,
			generic_follow_up: true,
		};

		return {
			kind: setFitResult.kind,
			confidence: setFitResult.confidence,
			cues: ["setfit_classification"],
			targetFacets,
			shouldContinueThread: kindToShouldContinue[setFitResult.kind],
		};
	}

	private classifyWithRegex(
		normalized: string,
		lower: string,
		targetFacets: string[],
	): QuestionReaction {
		const cues: string[] = [];

		if (
			includesAny(lower, [
				/(switch gears|different topic|move on to|new topic|something else|let(?:'s| us) talk about)/i,
			])
		) {
			return {
				kind: "topic_shift",
				confidence: 0.94,
				cues: ["explicit_topic_shift"],
				targetFacets,
				shouldContinueThread: false,
			};
		}

		if (includesAny(lower, [/(repeat that|say that again|can you repeat)/i])) {
			return {
				kind: "repeat_request",
				confidence: 0.96,
				cues: ["repeat_request"],
				targetFacets,
				shouldContinueThread: false,
			};
		}

		if (includesAny(lower, [/(tradeoff|pros and cons|downside|upside)/i])) {
			cues.push("tradeoff_language");
			return {
				kind: "tradeoff_probe",
				confidence: 0.91,
				cues,
				targetFacets: targetFacets.includes("tradeoffs")
					? ["tradeoffs"]
					: targetFacets,
				shouldContinueThread: true,
			};
		}

		if (
			includesAny(lower, [
				/(metric|measure|latency|throughput|success|kpi|watch first|monitor)/i,
			])
		) {
			cues.push("metric_language");
			return {
				kind: "metric_probe",
				confidence: 0.9,
				cues,
				targetFacets: targetFacets.includes("scaleConsiderations")
					? ["scaleConsiderations"]
					: targetFacets,
				shouldContinueThread: true,
			};
		}

		if (
			includesAny(lower, [
				/(for example|give me an example|example|walk me through a specific)/i,
			])
		) {
			cues.push("example_language");
			return {
				kind: "example_request",
				confidence: 0.88,
				cues,
				targetFacets,
				shouldContinueThread: true,
			};
		}

		if (
			includesAny(lower, [
				/(why|why not|why this|why that|why .* over .*|defend|justify)/i,
			])
		) {
			cues.push("challenge_language");
			return {
				kind: "challenge",
				confidence: 0.84,
				cues,
				targetFacets: targetFacets.includes("pushbackResponses")
					? ["pushbackResponses"]
					: targetFacets,
				shouldContinueThread: true,
			};
		}

		if (
			includesAny(lower, [
				/(what if|how would that change|and then|what happens|how would you handle|edge case)/i,
			])
		) {
			cues.push("deep_dive_language");
			return {
				kind: "deep_dive",
				confidence: 0.82,
				cues,
				targetFacets: targetFacets.includes("edgeCases")
					? ["edgeCases"]
					: targetFacets,
				shouldContinueThread: true,
			};
		}

		if (
			includesAny(lower, [
				/(what do you mean|clarify|can you explain|can you unpack|how so)/i,
			])
		) {
			cues.push("clarification_language");
			return {
				kind: "clarification",
				confidence: 0.8,
				cues,
				targetFacets,
				shouldContinueThread: true,
			};
		}

		const wordCount = normalized.split(/\s+/).filter(Boolean).length;
		const shouldContinueThread = wordCount >= 3 && hasGenericFollowUpCue(lower);

		return {
			kind: "generic_follow_up",
			confidence: shouldContinueThread ? 0.62 : 0.4,
			cues: shouldContinueThread ? ["active_thread_follow_up"] : [],
			targetFacets,
			shouldContinueThread,
		};
	}
}
