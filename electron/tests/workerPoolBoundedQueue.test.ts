// electron/tests/workerPoolBoundedQueue.test.ts
//
// NAT-016 / audit R-4: WorkerPool must reject overflow submissions
// synchronously with `worker_pool_queue_full` instead of buffering them
// without bound. This file pins the contract:
//
//   1. Submitting up to the cap is accepted.
//   2. Submitting past the cap rejects with the documented error string,
//      synchronously (i.e., the rejected promise is settled before any
//      microtask chained off the prior submissions resolves).
//   3. The `getQueueGauge()` surface reports current depth, cap, the
//      observed high-water mark, and the rejected count.
//
// We deliberately pause the underlying tasks with manually controlled
// promises so the queue depth is what the test inspects, not a race
// against `pump()`.

import assert from "node:assert/strict";
import test from "node:test";

import {
	WORKER_POOL_QUEUE_FULL_ERROR,
	WorkerPool,
} from "../runtime/WorkerPool";

const silentLogger = { warn() {} };

function buildPool(opts: { size: number; cap: number }) {
	return new WorkerPool({
		size: opts.size,
		maxQueueDepth: opts.cap,
		logger: silentLogger,
	});
}

test("NAT-016: WorkerPool accepts up to maxQueueDepth and rejects overflow with worker_pool_queue_full", async () => {
	const pool = buildPool({ size: 1, cap: 4 });

	// Each held task blocks on a manually-controlled deferred. The first
	// task runs immediately on the single worker; the next 4 sit in the
	// queue (depth 4 == cap). The 6th submission must be rejected.
	const releases: Array<() => void> = [];
	const settled: Array<"ok" | "fail"> = [];

	function submit() {
		return pool
			.submit(
				{ lane: "background" },
				() =>
					new Promise<void>((res) => {
						releases.push(res);
					}),
			)
			.then(
				() => settled.push("ok"),
				() => settled.push("fail"),
			);
	}

	// Active worker (1) + 4 queued = 5 submissions inside the cap.
	for (let i = 0; i < 5; i += 1) {
		submit();
	}

	await new Promise<void>((res) => setImmediate(res));
	// 1 active, 4 queued -> queueDepth must equal cap.
	assert.equal(pool.getStats().queueDepth, 4, "queue should be exactly at cap");
	assert.equal(pool.getQueueGauge().rejected, 0);

	// Overflow: this one rejects synchronously.
	let rejectedReason: unknown = null;
	await pool
		.submit({ lane: "background" }, () => Promise.resolve())
		.catch((err) => {
			rejectedReason = err;
		});

	assert.ok(rejectedReason instanceof Error, "rejection must be an Error");
	assert.equal((rejectedReason as Error).message, WORKER_POOL_QUEUE_FULL_ERROR);
	assert.equal(pool.getQueueGauge().rejected, 1);
	assert.equal(pool.getQueueGauge().highWaterMark, 4);

	// Drain: same single-worker constraint — release one at a time.
	let drained = 0;
	while (drained < 5) {
		if (releases.length === 0) {
			throw new Error("drain stalled: no released task ready");
		}
		const next = releases.shift()!;
		next();
		drained += 1;
		await new Promise<void>((res) => setImmediate(res));
	}
});

test("NAT-016: 2x burst rejects exactly the overflow half synchronously", async () => {
	const pool = buildPool({ size: 1, cap: 2 });

	const releases: Array<() => void> = [];
	const outcomes: Array<{
		idx: number;
		status: "ok" | "fail";
		reason?: string;
	}> = [];

	// 1 active + 2 queued at cap. Issue 6 total — 3 inside the cap (the
	// active one + queue-of-2), 3 must reject with worker_pool_queue_full.
	const promises: Array<Promise<unknown>> = [];
	for (let i = 0; i < 6; i += 1) {
		const idx = i;
		promises.push(
			pool
				.submit(
					{ lane: "background" },
					() =>
						new Promise<void>((res) => {
							releases.push(res);
						}),
				)
				.then(
					() => outcomes.push({ idx, status: "ok" }),
					(err) =>
						outcomes.push({
							idx,
							status: "fail",
							reason: (err as Error).message,
						}),
				),
		);
	}

	// Allow the synchronous rejections to settle.
	await new Promise<void>((res) => setImmediate(res));

	const failures = outcomes.filter((o) => o.status === "fail");
	assert.equal(
		failures.length,
		3,
		"exactly 3 of the 6 submissions must be rejected",
	);
	for (const failure of failures) {
		assert.equal(failure.reason, WORKER_POOL_QUEUE_FULL_ERROR);
	}
	assert.equal(pool.getQueueGauge().rejected, 3);

	// Drain: each task pushes its `res` onto `releases` only when it
	// actually runs, so on a single-worker pool we have to release one
	// task at a time and let the next one start before its release
	// handle exists. Loop until every accepted submission has settled.
	while (outcomes.length < 6) {
		if (releases.length === 0) {
			// shouldn't happen, but guard against an infinite loop in case the
			// pool somehow stalls — fail loudly rather than hang the test runner.
			throw new Error("drain stalled: no released task ready");
		}
		const next = releases.shift()!;
		next();
		await new Promise<void>((res) => setImmediate(res));
	}
	await Promise.allSettled(promises);
});
