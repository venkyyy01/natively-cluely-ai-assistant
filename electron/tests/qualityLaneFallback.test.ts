import assert from "node:assert/strict";
import test from "node:test";

import { QualityLane } from "../inference/QualityLane";

test("QualityLane falls back across providers without blocking refinement completion", async () => {
	const attempts: string[] = [];
	const lane = new QualityLane({
		providers: ["gemini", "claude", "openai"],
		runProvider: async (provider) => {
			attempts.push(provider);
			if (provider === "gemini") {
				throw new Error("timeout");
			}
			if (provider === "claude") {
				return null;
			}
			return "openai:refined";
		},
	});

	const result = await lane.execute({
		requestId: "req-1",
		requestClass: "quality",
		transcriptRevision: 1,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 1000,
	});

	assert.deepEqual(attempts, ["gemini", "claude", "openai"]);
	assert.equal(result.status, "completed");
	assert.equal(result.output, "openai:refined");
});
