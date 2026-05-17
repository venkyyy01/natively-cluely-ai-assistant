/**
 * NAT-056 — Single calibration source for intent confidence thresholds.
 * Version string is bumped when map values change (prompt assets / eval baselines).
 * Kept free of imports from IntentClassifier to avoid circular module loads.
 */
export const INTENT_CONFIDENCE_CALIBRATION_VERSION = 'intent_confidence_v1' as const;

/** Pipeline gates (SLM tier-2 accept, Foundation primary floor). */
export const PIPELINE_INTENT_THRESHOLDS = {
  /** Former `SLM_CONFIDENCE_THRESHOLD` — min SLM score to accept classifier label. */
  slmMinAcceptScore: 0.55,
  /** Former `DEFAULT_MINIMUM_PRIMARY_CONFIDENCE` — coordinator primary floor. */
  primaryMinConfidence: 0.82,
} as const;

/**
 * Per-intent floors for conscious-mode strong vs uncertain classification.
 * `minReliableConfidence`: below this (for non-`general`) counts as uncertain.
 * `strongMinConfidence`: for STRONG_CONSCIOUS_INTENTS, must meet this to count as strong.
 */
export type IntentCalibrationEntry = {
  minReliableConfidence: number;
  strongMinConfidence: number;
};

export const INTENT_CONFIDENCE_CALIBRATION = {
  clarification: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  follow_up: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  deep_dive: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  behavioral: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  example_request: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  summary_probe: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  coding: { minReliableConfidence: 0.72, strongMinConfidence: 0.84 },
  general: { minReliableConfidence: 1.0, strongMinConfidence: 1.0 },
} as const satisfies Record<string, IntentCalibrationEntry>;
