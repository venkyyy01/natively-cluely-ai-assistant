// electron/llm/IntentConfidenceService.ts — NAT-056 unified confidence + cancel surface
import type { ConversationIntent, IntentResult } from "./IntentClassifier";
import {
	INTENT_CONFIDENCE_CALIBRATION,
	INTENT_CONFIDENCE_CALIBRATION_VERSION,
	type IntentCalibrationEntry,
	PIPELINE_INTENT_THRESHOLDS,
} from "./intentConfidenceCalibration";

export type IntentStaleness = {
	transcriptRevision: number;
	ageMs: number;
};

const STRONG_CONSCIOUS_INTENTS = new Set<string>([
	"behavioral",
	"coding",
	"deep_dive",
]);

function calibrationRow(intent: ConversationIntent): IntentCalibrationEntry {
	const row =
		INTENT_CONFIDENCE_CALIBRATION[
			intent as keyof typeof INTENT_CONFIDENCE_CALIBRATION
		];
	if (row) {
		return row;
	}
	return { minReliableConfidence: 0.72, strongMinConfidence: 0.84 };
}

export class IntentConfidenceService {
	readonly calibrationVersion = INTENT_CONFIDENCE_CALIBRATION_VERSION;

	private readonly turnCancelHandlers = new Map<string, () => void>();

	getSlmMinAcceptScore(): number {
		return PIPELINE_INTENT_THRESHOLDS.slmMinAcceptScore;
	}

	getPrimaryMinConfidence(): number {
		return PIPELINE_INTENT_THRESHOLDS.primaryMinConfidence;
	}

	getCalibration(intent: ConversationIntent): IntentCalibrationEntry {
		return calibrationRow(intent);
	}

	isStrongConsciousIntent(intentResult?: IntentResult | null): boolean {
		if (!intentResult) {
			return false;
		}
		if (!STRONG_CONSCIOUS_INTENTS.has(intentResult.intent)) {
			return false;
		}
		const cal = calibrationRow(intentResult.intent);
		return intentResult.confidence >= cal.strongMinConfidence;
	}

	isUncertainConsciousIntent(intentResult?: IntentResult | null): boolean {
		if (!intentResult) {
			return true;
		}
		if (intentResult.intent === "general") {
			return true;
		}
		const cal = calibrationRow(intentResult.intent);
		return intentResult.confidence < cal.minReliableConfidence;
	}

	/**
	 * Register a cancel callback for a logical turn (e.g. speculative prefetch).
	 * Returns an unregister function.
	 */
	registerTurnCancel(turnId: string, onCancel: () => void): () => void {
		this.turnCancelHandlers.set(turnId, onCancel);
		return () => {
			this.turnCancelHandlers.delete(turnId);
		};
	}

	cancel(turnId: string): void {
		const fn = this.turnCancelHandlers.get(turnId);
		if (fn) {
			try {
				fn();
			} finally {
				this.turnCancelHandlers.delete(turnId);
			}
		}
	}

	attachStaleness(
		result: IntentResult,
		input: { transcriptRevision?: number },
		classificationStartedAt: number,
		now: number = Date.now(),
	): IntentResult {
		const revision =
			typeof input.transcriptRevision === "number" &&
			Number.isFinite(input.transcriptRevision)
				? input.transcriptRevision
				: -1;
		return {
			...result,
			staleness: {
				transcriptRevision: revision,
				ageMs: Math.max(0, now - classificationStartedAt),
			},
		};
	}
}

let singleton: IntentConfidenceService | null = null;

export function getIntentConfidenceService(): IntentConfidenceService {
	if (!singleton) {
		singleton = new IntentConfidenceService();
	}
	return singleton;
}

export function resetIntentConfidenceServiceForTesting(): void {
	singleton = null;
}
