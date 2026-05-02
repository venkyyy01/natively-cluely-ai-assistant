import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createDefaultMockCaptureMatrixRows,
	MockCaptureAdapter,
	runCaptureMatrix,
	validateCaptureMatrixRow,
} from "../stealth/CaptureMatrixHarness";

test("CaptureMatrixHarness validates required row schema fields", () => {
	const row = createDefaultMockCaptureMatrixRows({
		platform: "darwin",
		osVersion: "15.4",
		appVersion: "2.0.9",
	})[0]!;

	assert.deepEqual(validateCaptureMatrixRow(row), []);
	assert.deepEqual(
		validateCaptureMatrixRow({ ...row, id: "../bad", monitors: 0 }),
		[
			"id must be non-empty and filesystem-safe",
			"monitors must be a positive integer",
		],
	);
});

test("CaptureMatrixHarness mock adapter produces deterministic pass artifacts", async () => {
	const outputRoot = await mkdtemp(path.join(os.tmpdir(), "capture-matrix-"));
	const rows = createDefaultMockCaptureMatrixRows({
		platform: "darwin",
		osVersion: "15.4",
		appVersion: "2.0.9",
		strict: true,
	});

	const result = await runCaptureMatrix({
		rows,
		adapter: new MockCaptureAdapter(),
		outputRoot,
		runId: "mock-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.passed, true);
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0]!.actualResult, "hidden");
	assert.equal(result.results[1]!.actualResult, "visible");

	const summary = JSON.parse(
		await readFile(path.join(outputRoot, "mock-run", "summary.json"), "utf8"),
	);
	assert.equal(summary.runId, "mock-run");
	assert.equal(summary.generatedAt, "1970-01-01T00:00:00.000Z");

	const metadata = JSON.parse(
		await readFile(result.results[0]!.artifactPaths.metadata, "utf8"),
	);
	assert.equal(metadata.row.canaryToken, "NATIVELY_CAPTURE_CANARY_PROTECTED");
	assert.equal(metadata.passed, true);
});

test("CaptureMatrixHarness mock adapter fails when expected hidden canary is visible", async () => {
	const outputRoot = await mkdtemp(path.join(os.tmpdir(), "capture-matrix-"));
	const rows = createDefaultMockCaptureMatrixRows();

	const result = await runCaptureMatrix({
		rows: [rows[0]!],
		adapter: new MockCaptureAdapter({ "mock-protected-screen-share": true }),
		outputRoot,
		runId: "mock-fail",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.passed, false);
	assert.equal(result.results[0]!.actualResult, "visible");
	assert.match(result.results[0]!.reason ?? "", /expected hidden/);
});
