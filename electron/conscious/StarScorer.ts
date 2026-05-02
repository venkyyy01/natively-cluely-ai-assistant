import type { ConsciousModeStructuredResponse } from "../ConsciousMode";

export interface StarFeatures {
	actionWordCount: number;
	resultWordCount: number;
	actionToSituationRatio: number;
	actionToTaskRatio: number;
	hasImpactCue: boolean;
	hasActionVerb: boolean;
	actionDepthScore: number;
}

export interface StarScore {
	overall: number;
	features: StarFeatures;
	details: {
		actionWordCount: number;
		resultWordCount: number;
		actionToSituationRatio: number;
		actionToTaskRatio: number;
		hasImpactCue: boolean;
		hasActionVerb: boolean;
	};
}

export class StarScorer {
	private static readonly ACTION_VERBS = new Set([
		"built",
		"created",
		"developed",
		"implemented",
		"designed",
		"architected",
		"engineered",
		"deployed",
		"launched",
		"shipped",
		"delivered",
		"released",
		"migrated",
		"refactored",
		"optimized",
		"scaled",
		"improved",
		"enhanced",
		"fixed",
		"resolved",
		"debugged",
		"troubleshooted",
		"analyzed",
		"investigated",
		"led",
		"managed",
		"coordinated",
		"orchestrated",
		"spearheaded",
		"drove",
		"wrote",
		"coded",
		"programmed",
		"scripted",
		"automated",
		"integrated",
		"configured",
		"setup",
		"installed",
		"maintained",
		"monitored",
		"tested",
	]);

	private static readonly IMPACT_CUES =
		/\b(\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?|improv|reduc|increas|decreas|saved|faster|slower|stabil|unblock|delivered|shipped|adopt|retention|latency|throughput|quality|incident|customer|user|team|process|runbook|checklist|learned|next time|would do differently)\b/i;

	private static readonly FEATURE_WEIGHTS = {
		actionWordCount: 0.15,
		resultWordCount: 0.12,
		actionToSituationRatio: 0.18,
		actionToTaskRatio: 0.18,
		hasImpactCue: 0.22,
		hasActionVerb: 0.15,
	} as const;

	private static readonly THRESHOLD = 0.55;

	score(response: ConsciousModeStructuredResponse): StarScore {
		const behavioral = response.behavioralAnswer;

		if (!behavioral) {
			return {
				overall: 0,
				features: this.getEmptyFeatures(),
				details: {
					actionWordCount: 0,
					resultWordCount: 0,
					actionToSituationRatio: 0,
					actionToTaskRatio: 0,
					hasImpactCue: false,
					hasActionVerb: false,
				},
			};
		}

		const features = this.extractFeatures(response);
		const overall = this.computeOverallScore(features);

		return {
			overall,
			features,
			details: {
				actionWordCount: features.actionWordCount,
				resultWordCount: features.resultWordCount,
				actionToSituationRatio: features.actionToSituationRatio,
				actionToTaskRatio: features.actionToTaskRatio,
				hasImpactCue: features.hasImpactCue,
				hasActionVerb: features.hasActionVerb,
			},
		};
	}

	isAcceptable(score: StarScore): boolean {
		return score.overall >= StarScorer.THRESHOLD;
	}

	private extractFeatures(
		response: ConsciousModeStructuredResponse,
	): StarFeatures {
		const behavioral = response.behavioralAnswer!;

		const actionWordCount = this.wordCount(behavioral.action);
		const situationWordCount = this.wordCount(behavioral.situation);
		const taskWordCount = this.wordCount(behavioral.task);
		const resultWordCount = this.wordCount(behavioral.result);

		const actionToSituationRatio =
			situationWordCount > 0
				? actionWordCount / situationWordCount
				: actionWordCount > 0
					? 2
					: 0;

		const actionToTaskRatio =
			taskWordCount > 0
				? actionWordCount / taskWordCount
				: actionWordCount > 0
					? 2
					: 0;

		const hasImpactCue = StarScorer.IMPACT_CUES.test(behavioral.result);
		const hasActionVerb = this.hasActionVerb(behavioral.action);

		const actionDepthScore = this.computeActionDepthScore(
			actionWordCount,
			actionToSituationRatio,
			actionToTaskRatio,
			resultWordCount,
			hasImpactCue,
			hasActionVerb,
		);

		return {
			actionWordCount,
			resultWordCount,
			actionToSituationRatio,
			actionToTaskRatio,
			hasImpactCue,
			hasActionVerb,
			actionDepthScore,
		};
	}

	private computeOverallScore(features: StarFeatures): number {
		// Normalize features to 0-1 range
		const normalizedActionWordCount = Math.min(
			1,
			features.actionWordCount / 20,
		);
		const normalizedResultWordCount = Math.min(
			1,
			features.resultWordCount / 15,
		);
		const normalizedActionToSituationRatio = Math.min(
			1,
			features.actionToSituationRatio / 3,
		);
		const normalizedActionToTaskRatio = Math.min(
			1,
			features.actionToTaskRatio / 3,
		);
		const hasImpactCue = features.hasImpactCue ? 1 : 0;
		const hasActionVerb = features.hasActionVerb ? 1 : 0;

		const weightedSum =
			normalizedActionWordCount * StarScorer.FEATURE_WEIGHTS.actionWordCount +
			normalizedResultWordCount * StarScorer.FEATURE_WEIGHTS.resultWordCount +
			normalizedActionToSituationRatio *
				StarScorer.FEATURE_WEIGHTS.actionToSituationRatio +
			normalizedActionToTaskRatio *
				StarScorer.FEATURE_WEIGHTS.actionToTaskRatio +
			hasImpactCue * StarScorer.FEATURE_WEIGHTS.hasImpactCue +
			hasActionVerb * StarScorer.FEATURE_WEIGHTS.hasActionVerb;

		return Math.max(0, Math.min(1, weightedSum));
	}

	private computeActionDepthScore(
		actionWordCount: number,
		actionToSituationRatio: number,
		actionToTaskRatio: number,
		resultWordCount: number,
		hasImpactCue: boolean,
		hasActionVerb: boolean,
	): number {
		let score = 0;

		// Action word count (up to 20 words = full points)
		score += Math.min(1, actionWordCount / 20) * 0.3;

		// Action advantage over situation (ratio >= 1.5 = full points)
		score += Math.min(1, actionToSituationRatio / 1.5) * 0.2;

		// Action advantage over task (ratio >= 1.5 = full points)
		score += Math.min(1, actionToTaskRatio / 1.5) * 0.2;

		// Result word count (up to 10 words = full points)
		score += Math.min(1, resultWordCount / 10) * 0.15;

		// Impact cue
		if (hasImpactCue) score += 0.1;

		// Action verb
		if (hasActionVerb) score += 0.05;

		return Math.max(0, Math.min(1, score));
	}

	private wordCount(text: string | null | undefined): number {
		return (text || "").trim().split(/\s+/).filter(Boolean).length;
	}

	private hasActionVerb(text: string): boolean {
		const words = text.toLowerCase().split(/\s+/);
		return words.some((word) => StarScorer.ACTION_VERBS.has(word));
	}

	private getEmptyFeatures(): StarFeatures {
		return {
			actionWordCount: 0,
			resultWordCount: 0,
			actionToSituationRatio: 0,
			actionToTaskRatio: 0,
			hasImpactCue: false,
			hasActionVerb: false,
			actionDepthScore: 0,
		};
	}
}
