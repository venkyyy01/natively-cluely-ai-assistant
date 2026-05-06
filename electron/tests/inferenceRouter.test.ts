import assert from "node:assert/strict";
import test from "node:test";

import { FastDraftLane } from "../inference/FastDraftLane";
import { InferenceRouter } from "../inference/InferenceRouter";
import { QualityLane } from "../inference/QualityLane";
import { VerificationLane } from "../inference/VerificationLane";

test("InferenceRouter degrades quality requests to fast draft when quality budget is unavailable", async () => {
	const router = new InferenceRouter({
		budgetScheduler: {
			hasHeadroom(lane) {
				return lane !== "local-inference";
			},
		},
		fastDraftLane: new FastDraftLane({
			runProvider: async (provider) => `${provider}:draft`,
		}),
		verificationLane: new VerificationLane(),
		qualityLane: new QualityLane({
			runProvider: async (provider) => `${provider}:quality`,
		}),
	});

	const { decision, result } = await router.run({
		requestId: "req-1",
		requestClass: "quality",
		transcriptRevision: 1,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 500,
	});

	assert.equal(decision.lane, "fast-draft");
	assert.equal(decision.degraded, true);
	assert.equal(result.status, "completed");
	assert.equal(result.output, "ollama:draft");
});

test("InferenceRouter preserves explicit verification routing", async () => {
	const router = new InferenceRouter({
		fastDraftLane: new FastDraftLane({
			runProvider: async () => "draft",
		}),
		verificationLane: new VerificationLane(),
		qualityLane: new QualityLane({
			runProvider: async () => "quality",
		}),
	});

	const decision = router.route({
		requestId: "req-2",
		requestClass: "verify",
		transcriptRevision: 2,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 100,
		draft: "This draft is long enough to verify",
	});

	assert.equal(decision.lane, "verification");
	assert.equal(decision.schedulerLane, "semantic");
});
