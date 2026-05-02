import assert from "node:assert/strict";
import test from "node:test";
import {
	getIntentConfidenceService,
	resetIntentConfidenceServiceForTesting,
} from "../llm/IntentConfidenceService";
import {
	INTENT_CONFIDENCE_CALIBRATION_VERSION,
	PIPELINE_INTENT_THRESHOLDS,
} from "../llm/intentConfidenceCalibration";

test("NAT-056: pipeline thresholds match former SLM and primary constants", () => {
	assert.equal(PIPELINE_INTENT_THRESHOLDS.slmMinAcceptScore, 0.55);
	assert.equal(PIPELINE_INTENT_THRESHOLDS.primaryMinConfidence, 0.82);
	const svc = getIntentConfidenceService();
	assert.equal(svc.getSlmMinAcceptScore(), 0.55);
	assert.equal(svc.getPrimaryMinConfidence(), 0.82);
});

test("NAT-056: strong vs uncertain uses calibration map", () => {
	resetIntentConfidenceServiceForTesting();
	const svc = getIntentConfidenceService();
	assert.equal(svc.calibrationVersion, INTENT_CONFIDENCE_CALIBRATION_VERSION);

	assert.equal(svc.isStrongConsciousIntent(null), false);
	assert.equal(
		svc.isStrongConsciousIntent({
			intent: "general",
			confidence: 0.99,
			answerShape: "",
		}),
		false,
	);

	assert.equal(
		svc.isStrongConsciousIntent({
			intent: "deep_dive",
			confidence: 0.83,
			answerShape: "",
		}),
		false,
	);
	assert.equal(
		svc.isStrongConsciousIntent({
			intent: "deep_dive",
			confidence: 0.85,
			answerShape: "",
		}),
		true,
	);

	assert.equal(svc.isUncertainConsciousIntent(null), true);
	assert.equal(
		svc.isUncertainConsciousIntent({
			intent: "general",
			confidence: 0.99,
			answerShape: "",
		}),
		true,
	);
	assert.equal(
		svc.isUncertainConsciousIntent({
			intent: "clarification",
			confidence: 0.71,
			answerShape: "",
		}),
		true,
	);
	assert.equal(
		svc.isUncertainConsciousIntent({
			intent: "clarification",
			confidence: 0.72,
			answerShape: "",
		}),
		false,
	);
});

test("NAT-056: cancel invokes registered handler once", () => {
	resetIntentConfidenceServiceForTesting();
	const svc = getIntentConfidenceService();
	let calls = 0;
	svc.registerTurnCancel("t1", () => {
		calls += 1;
	});
	svc.cancel("t1");
	svc.cancel("t1");
	assert.equal(calls, 1);
});
