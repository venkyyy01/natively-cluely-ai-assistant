// electron/tests/interviewPhase.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { InterviewPhaseDetector } from "../conscious/InterviewPhase";
import { InterviewPhase } from "../conscious/types";

test("InterviewPhaseDetector - should detect requirements_gathering phase", () => {
	const detector = new InterviewPhaseDetector();
	const result = detector.detectPhase(
		"Can I assume we have unlimited storage?",
		"high_level_design",
		[],
	);
	assert.equal(result.phase, "requirements_gathering");
	assert.ok(result.confidence > 0.4);
});

test("InterviewPhaseDetector - should detect implementation phase", () => {
	const detector = new InterviewPhaseDetector();
	const result = detector.detectPhase(
		"Let me write the code for this LRU cache",
		"deep_dive",
		[],
	);
	assert.equal(result.phase, "implementation");
	assert.ok(result.confidence > 0.4);
});

test("InterviewPhaseDetector - should detect behavioral_story phase", () => {
	const detector = new InterviewPhaseDetector();
	const result = detector.detectPhase(
		"Tell me about a time you led a challenging project",
		"requirements_gathering",
		[],
	);
	assert.equal(result.phase, "behavioral_story");
	assert.ok(result.confidence > 0.4);
});

test("InterviewPhaseDetector - should maintain current phase when confidence is low", () => {
	const detector = new InterviewPhaseDetector();
	const result = detector.detectPhase("Okay, continue", "deep_dive", []);
	assert.equal(result.phase, "deep_dive");
});

test("InterviewPhaseDetector - should detect scaling_discussion from scale keywords", () => {
	const detector = new InterviewPhaseDetector();
	const result = detector.detectPhase(
		"How would this scale to a million users?",
		"high_level_design",
		[],
	);
	assert.equal(result.phase, "scaling_discussion");
});
