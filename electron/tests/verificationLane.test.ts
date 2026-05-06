import assert from "node:assert/strict";
import test from "node:test";

import { VerificationLane } from "../inference/VerificationLane";

test("VerificationLane rejects weak drafts and discards stale work", async () => {
	const lane = new VerificationLane({
		getCurrentTranscriptRevision: () => 2,
	});

	const stale = await lane.execute({
		requestId: "req-1",
		requestClass: "verify",
		transcriptRevision: 1,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 50,
		draft: "This draft should be stale",
	});
	const weak = await lane.execute({
		requestId: "req-2",
		requestClass: "verify",
		transcriptRevision: 2,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 50,
		draft: "short",
	});

	assert.equal(stale.status, "discarded");
	assert.equal(weak.status, "rejected");
});

test("VerificationLane accepts strong drafts when the verifier approves them", async () => {
	const lane = new VerificationLane({
		verifyDraft: async (draft) => ({
			accepted: draft.includes("correct"),
			reason: "semantic mismatch",
		}),
	});

	const accepted = await lane.execute({
		requestId: "req-3",
		requestClass: "verify",
		transcriptRevision: 3,
		contextSnapshot: "ctx",
		budgetDeadlineMs: 50,
		draft: "This is a correct and sufficiently detailed draft",
	});

	assert.equal(accepted.status, "completed");
});
