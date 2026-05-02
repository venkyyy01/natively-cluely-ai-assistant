import assert from "node:assert/strict";
import test from "node:test";
import { ConsciousAnswerPlanner } from "../conscious/ConsciousAnswerPlanner";

test("ConsciousAnswerPlanner selects tradeoff_defense for tradeoff probes", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "What are the tradeoffs?",
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.91,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
	});

	assert.equal(plan.answerShape, "tradeoff_defense");
	assert.deepEqual(plan.focalFacets, ["tradeoffs"]);
	assert.ok(
		planner.buildContextBlock(plan).includes("ANSWER_SHAPE: tradeoff_defense"),
	);
});

test("ConsciousAnswerPlanner selects metric_backed_answer for metric probes", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "What metrics would you watch?",
		reaction: {
			kind: "metric_probe",
			confidence: 0.88,
			cues: ["metric_language"],
			targetFacets: ["scaleConsiderations"],
			shouldContinueThread: true,
		},
		hypothesis: null,
	});

	assert.equal(plan.answerShape, "metric_backed_answer");
});

test("ConsciousAnswerPlanner emits code-first delivery hints for live coding questions", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "Write the debounce function in TypeScript.",
		reaction: null,
		hypothesis: null,
	});

	assert.equal(plan.questionMode, "live_coding");
	assert.equal(plan.deliveryFormat, "code_first_or_short_steps");
	assert.equal(plan.deliveryStyle, "compact_technical");
	assert.ok(plan.maxWords <= 70);
	assert.ok(plan.focalFacets.includes("codeTransition"));
	assert.match(planner.buildContextBlock(plan), /QUESTION_MODE: live_coding/);
	assert.match(
		planner.buildContextBlock(plan),
		/DELIVERY_FORMAT: code_first_or_short_steps/,
	);
});

test("ConsciousAnswerPlanner converts behavioral questions into short grounded narrative hints", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "Tell me about a time you handled disagreement on a team.",
		reaction: null,
		hypothesis: null,
	});

	assert.equal(plan.questionMode, "behavioral");
	assert.equal(plan.answerShape, "example_answer");
	assert.equal(plan.deliveryFormat, "full_star_narrative");
	assert.equal(plan.deliveryStyle, "first_person_professional");
	assert.ok(plan.maxWords <= 250);
	assert.match(
		planner.buildContextBlock(plan),
		/GROUNDING_HINT: Ground the answer in concrete past experience/,
	);
});

test("ConsciousAnswerPlanner uses strong coding intent to force live-coding mode for ambiguous prompts", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "Can you show me how you would approach this?",
		reaction: null,
		hypothesis: null,
		intentResult: {
			intent: "coding",
			confidence: 0.94,
			answerShape: "Provide a full implementation.",
		},
	});

	assert.equal(plan.questionMode, "live_coding");
	assert.equal(plan.deliveryFormat, "code_first_or_short_steps");
});

test("ConsciousAnswerPlanner uses strong deep-dive intent to force system-design mode", () => {
	const planner = new ConsciousAnswerPlanner();
	const plan = planner.plan({
		question: "What tradeoffs matter most here?",
		reaction: null,
		hypothesis: null,
		intentResult: {
			intent: "deep_dive",
			confidence: 0.91,
			answerShape: "Discuss the tradeoffs directly.",
		},
	});

	assert.equal(plan.questionMode, "system_design");
	assert.equal(plan.deliveryFormat, "architecture_then_tradeoffs");
});
