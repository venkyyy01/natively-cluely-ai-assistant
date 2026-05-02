// electron/tests/consciousModeTypes.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { type FallbackTier, INTERVIEW_PHASES } from "../conscious/types";

test("ConsciousModeTypes - should have all interview phases defined", () => {
	assert.ok(INTERVIEW_PHASES.includes("requirements_gathering"));
	assert.ok(INTERVIEW_PHASES.includes("high_level_design"));
	assert.ok(INTERVIEW_PHASES.includes("implementation"));
	assert.equal(INTERVIEW_PHASES.length, 9);
});

test("ConsciousModeTypes - should have correct fallback tier count", () => {
	const tiers: FallbackTier[] = [
		"full_conscious",
		"reduced_conscious",
		"normal_mode",
		"emergency_local",
	];
	assert.equal(tiers.length, 4);
});
