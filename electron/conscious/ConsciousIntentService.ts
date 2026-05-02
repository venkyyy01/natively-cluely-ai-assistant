import type { IntentResult } from "../llm/IntentClassifier";
import { getIntentConfidenceService } from "../llm/IntentConfidenceService";
import type { CoordinatedIntentResult } from "../llm/providers/IntentClassificationCoordinator";

export function isStrongConsciousIntent(
	intentResult?: IntentResult | null,
): boolean {
	return getIntentConfidenceService().isStrongConsciousIntent(intentResult);
}

export function isUncertainConsciousIntent(
	intentResult?: IntentResult | null,
): boolean {
	return getIntentConfidenceService().isUncertainConsciousIntent(intentResult);
}

export interface ResolvedIntentResult extends IntentResult {
	reason?: string;
}

export interface ConsciousIntentResolution {
	intentResult: ResolvedIntentResult;
	totalContextAssemblyMs: number;
	timedOut: boolean;
}

export class ConsciousIntentService {
	async resolve(input: {
		lastInterviewerTurn: string | null;
		preparedTranscript: string;
		assistantResponseCount: number;
		startedAt: number;
		hardBudgetMs: number;
		isLikelyGeneralIntent: boolean;
		classifyIntent: (
			lastInterviewerTurn: string | null,
			preparedTranscript: string,
			assistantResponseCount: number,
		) => Promise<IntentResult>;
		prefetchedIntent?: CoordinatedIntentResult | null;
	}): Promise<ConsciousIntentResolution> {
		if (input.prefetchedIntent) {
			// NAT-L3: Accept prefetched intent if it's non-general. Previously,
			// anything below minReliableConfidence (0.72) was discarded, forcing a
			// live re-classify that almost always times out (NAT-L1). A 0.55
			// deep_dive is far more useful than a timed-out general/0.
			if (input.prefetchedIntent.intent === "general") {
				console.log(
					`[ConsciousIntentService] intent.prefetch_discarded_general confidence=${input.prefetchedIntent.confidence?.toFixed?.(3) ?? input.prefetchedIntent.confidence}`,
				);
			} else {
				return {
					intentResult: input.prefetchedIntent,
					totalContextAssemblyMs: Date.now() - input.startedAt,
					timedOut: false,
				};
			}
		}

		let intentResult: ResolvedIntentResult = {
			intent: "general",
			confidence: 0,
			answerShape: "",
			reason: "context_assembly_timeout",
		};
		let timedOut = false;

		const contextAssemblyElapsed = Date.now() - input.startedAt;
		if (contextAssemblyElapsed < input.hardBudgetMs) {
			try {
				if (!input.isLikelyGeneralIntent) {
					intentResult = await Promise.race([
						input.classifyIntent(
							input.lastInterviewerTurn,
							input.preparedTranscript,
							input.assistantResponseCount,
						),
						new Promise<ResolvedIntentResult>((_, reject) => {
							setTimeout(
								() => reject(new Error("intent classification timeout")),
								Math.max(30, input.hardBudgetMs - contextAssemblyElapsed),
							);
						}),
					]);
				}
			} catch {
				timedOut = true;
				intentResult = {
					intent: "general",
					confidence: 0,
					answerShape: "",
					reason: "context_timeout",
				};
			}
		} else {
			timedOut = true;
		}

		return {
			intentResult,
			totalContextAssemblyMs: Date.now() - input.startedAt,
			timedOut,
		};
	}
}
