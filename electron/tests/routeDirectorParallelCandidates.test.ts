import assert from "node:assert/strict";
import test from "node:test";

import { FastDraftLane } from "../inference/FastDraftLane";
import { InferenceRouter } from "../inference/InferenceRouter";
import { QualityLane } from "../inference/QualityLane";
import { VerificationLane } from "../inference/VerificationLane";
import { RouteDirector } from "../runtime/RouteDirector";
import { compareScheduledLaneTasks } from "../runtime/RuntimeBudgetScheduler";

test("RouteDirector.runTurn returns null when transcript revision drifts", async () => {
	let revision = 1;
	const director = new RouteDirector();
	const result = await director.runTurn(
		{
			turnId: "t1",
			transcriptRevision: 1,
			deadlineMs: Date.now() + 60_000,
			abortSignal: new AbortController().signal,
			getCurrentTranscriptRevision: () => revision,
		},
		async () => {
			revision = 2;
			return "ok";
		},
	);
	assert.equal(result, null);
});

test("RouteDirector.runTurn returns value when revision stable", async () => {
	const director = new RouteDirector();
	const result = await director.runTurn(
		{
			turnId: "t2",
			transcriptRevision: 5,
			deadlineMs: Date.now() + 60_000,
			abortSignal: new AbortController().signal,
			getCurrentTranscriptRevision: () => 5,
		},
		async () => "done",
	);
	assert.equal(result, "done");
});

test("RouteDirector.raceParallelCandidates picks first valid and aborts loser within timeout", async () => {
	const director = new RouteDirector();
	const parent = new AbortController();
	let loserAborted = false;

	const { winnerId, value } = await director.raceParallelCandidates(
		[
			{
				id: "slow",
				run: async (signal) => {
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, 200);
						signal.addEventListener(
							"abort",
							() => {
								clearTimeout(t);
								loserAborted = true;
								resolve();
							},
							{ once: true },
						);
					});
					return "slow";
				},
			},
			{
				id: "fast",
				run: async (signal) => {
					assert.equal(signal.aborted, false);
					await new Promise((r) => setTimeout(r, 5));
					return "fast";
				},
			},
		],
		{
			parentSignal: parent.signal,
			cancelLoserWithinMs: 500,
			isValid: (v) => v === "fast",
		},
	);

	assert.equal(winnerId, "fast");
	assert.equal(value, "fast");
	assert.equal(loserAborted, true);
});

test("InferenceRouter parallel quality race picks fast-draft when it finishes first", async () => {
	process.env.NATIVELY_ROUTE_DIRECTOR = "1";
	try {
		const router = new InferenceRouter({
			budgetScheduler: {
				hasHeadroom() {
					return true;
				},
			},
			fastDraftLane: new FastDraftLane({
				runProvider: async () => "draft-wins",
			}),
			verificationLane: new VerificationLane(),
			qualityLane: new QualityLane({
				runProvider: async () => {
					await new Promise((r) => setTimeout(r, 80));
					return "quality-slow";
				},
			}),
		});

		const { decision, result } = await router.run({
			requestId: "req-par",
			requestClass: "quality",
			transcriptRevision: 1,
			contextSnapshot: "ctx",
			budgetDeadlineMs: Date.now() + 5000,
			parallelCandidates: true,
		});

		assert.equal(decision.lane, "fast-draft");
		assert.equal(result.output, "draft-wins");
		assert.equal(result.status, "completed");
	} finally {
		delete process.env.NATIVELY_ROUTE_DIRECTOR;
	}
});

test("compareScheduledLaneTasks orders same priority by earlier budgetDeadlineMs (EDF)", () => {
	const base = Date.now() + 10_000;
	const early = { priority: 1, order: 1, budgetDeadlineMs: base + 100 };
	const late = { priority: 1, order: 2, budgetDeadlineMs: base + 2000 };
	assert.ok(compareScheduledLaneTasks(early, late) < 0);
	assert.ok(compareScheduledLaneTasks(late, early) > 0);
});

test("compareScheduledLaneTasks prefers higher priority over earlier deadline", () => {
	const highPri = { priority: 3, order: 1, budgetDeadlineMs: 999_999 };
	const lowPriSoon = { priority: 1, order: 2, budgetDeadlineMs: 1 };
	assert.ok(compareScheduledLaneTasks(highPri, lowPriSoon) < 0);
});
