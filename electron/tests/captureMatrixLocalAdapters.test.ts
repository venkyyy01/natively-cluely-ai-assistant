import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	type CaptureAdapterSession,
	type CaptureMatrixAdapter,
	type CaptureMatrixArtifact,
	type CaptureMatrixRow,
	CaptureMatrixSkipError,
	runCaptureMatrix,
} from "../stealth/CaptureMatrixHarness";
import {
	createDefaultMacosCgWindowRows,
	createDefaultMacosScreenCaptureKitRows,
	createDefaultMacosScreencaptureRows,
	createDefaultWindowsCaptureRows,
	detectCanaryMarkerInImage,
	MacosCgWindowEnumerationAdapter,
	MacosScreenCaptureKitAdapter,
	MacosScreencaptureAdapter,
	renderCanaryPngBuffer,
	WindowsCaptureAdapterStub,
	writeCanaryFixtureFiles,
} from "../stealth/CaptureMatrixLocalAdapters";

test("CaptureMatrixLocalAdapters detects rendered canary marker pixels", async () => {
	const positive = await renderCanaryPngBuffer(
		"NATIVELY_CAPTURE_CANARY_CONTROL",
	);
	const positiveResult = await detectCanaryMarkerInImage(positive);
	assert.equal(positiveResult.visible, true);
	assert.ok(positiveResult.primaryPixels >= positiveResult.minPixelsPerColor);
	assert.ok(positiveResult.secondaryPixels >= positiveResult.minPixelsPerColor);

	const negative = Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#000"/></svg>',
	);
	const negativeResult = await detectCanaryMarkerInImage(negative);
	assert.equal(negativeResult.visible, false);
	assert.equal(negativeResult.primaryPixels, 0);
	assert.equal(negativeResult.secondaryPixels, 0);
});

test("CaptureMatrixLocalAdapters writes canary HTML and PNG fixture files", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-canary-"),
	);
	const row = createDefaultMacosScreencaptureRows({ platform: "darwin" })[0]!;
	const fixture = await writeCanaryFixtureFiles(row, outputRoot);

	const html = await readFile(fixture.htmlPath, "utf8");
	assert.match(html, /NATIVELY_CAPTURE_CANARY_PROTECTED/);
	assert.ok((await stat(fixture.pngPath)).size > 0);
});

test("CaptureMatrixHarness persists capture artifacts and records explicit skips", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-artifact-"),
	);
	const rows = createDefaultMacosScreencaptureRows({ platform: "darwin" });

	class ArtifactAdapter implements CaptureMatrixAdapter {
		readonly name = "artifact-test";

		async prepare(_row: CaptureMatrixRow): Promise<void> {
			return;
		}

		async startCapture(row: CaptureMatrixRow): Promise<CaptureAdapterSession> {
			return { id: row.id };
		}

		async triggerVisibility(
			_row: CaptureMatrixRow,
			_session: CaptureAdapterSession,
		): Promise<void> {
			return;
		}

		async collectArtifact(
			row: CaptureMatrixRow,
			_session: CaptureAdapterSession,
		): Promise<CaptureMatrixArtifact> {
			if (row.expectedResult === "hidden") {
				throw new CaptureMatrixSkipError("permission missing");
			}
			const capturePath = path.join(outputRoot, `${row.id}.txt`);
			await writeFile(capturePath, "capture");
			return { canaryVisible: true, capturePath, log: "ok" };
		}

		async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact) {
			return {
				actualResult: artifact.canaryVisible
					? ("visible" as const)
					: ("hidden" as const),
				passed:
					row.expectedResult ===
					(artifact.canaryVisible ? "visible" : "hidden"),
			};
		}

		async cleanup(
			_row: CaptureMatrixRow,
			_session: CaptureAdapterSession,
		): Promise<void> {
			return;
		}
	}

	const result = await runCaptureMatrix({
		rows,
		adapter: new ArtifactAdapter(),
		outputRoot,
		runId: "artifact-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "skipped");
	assert.match(result.results[0]!.reason ?? "", /permission missing/);
	assert.equal(result.results[1]!.actualResult, "visible");
	assert.equal(
		await readFile(result.results[1]!.artifactPaths.capture!, "utf8"),
		"capture",
	);
	assert.match(result.results[1]!.artifactPaths.capture!, /artifact-run/);
});

test("MacosScreencaptureAdapter can prove visible control from injected capture output", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-screencapture-"),
	);
	const controlRow = createDefaultMacosScreencaptureRows({
		platform: "darwin",
	})[1]!;
	const canaryPng = await renderCanaryPngBuffer(controlRow.canaryToken);
	const adapter = new MacosScreencaptureAdapter({
		platform: "darwin",
		commandPath: "/fake/screencapture",
		canaryArmed: true,
		execFile: async (_file, args) => {
			await writeFile(args[1]!, canaryPng);
			return { stdout: "", stderr: "" };
		},
	});

	const result = await runCaptureMatrix({
		rows: [controlRow],
		adapter,
		outputRoot,
		runId: "screencapture-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.passed, true);
	assert.equal(result.results[0]!.actualResult, "visible");
	assert.ok(result.results[0]!.artifactPaths.capture);
});

test("MacosScreencaptureAdapter skips when canary surface is not armed", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-screencapture-disarmed-"),
	);
	const row = createDefaultMacosScreencaptureRows({ platform: "darwin" })[0]!;
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new MacosScreencaptureAdapter({
			platform: "darwin",
			commandPath: "/fake/screencapture",
		}),
		outputRoot,
		runId: "screencapture-disarmed",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "skipped");
	assert.match(result.results[0]!.reason ?? "", /canary surface is not armed/);
	assert.match(result.results[0]!.reason ?? "", /canaryHtml=/);
});

test("MacosScreencaptureAdapter skips when platform is not darwin", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-screencapture-skip-"),
	);
	const row = createDefaultMacosScreencaptureRows({ platform: "linux" })[0]!;
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new MacosScreencaptureAdapter({ platform: "linux" }),
		outputRoot,
		runId: "screencapture-skip",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "skipped");
	assert.match(result.results[0]!.reason ?? "", /only runs on darwin/);
});

test("MacosCgWindowEnumerationAdapter detects canary in native window titles", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-cgwindow-"),
	);
	const rows = createDefaultMacosCgWindowRows({ platform: "darwin" });
	const adapter = new MacosCgWindowEnumerationAdapter({
		platform: "darwin",
		canaryArmed: true,
		nativeModule: {
			listVisibleWindows: () => [
				{
					windowNumber: 42,
					ownerName: "Natively",
					ownerPid: 123,
					windowTitle: "NATIVELY_CAPTURE_CANARY_CONTROL",
					isOnScreen: true,
					sharingState: 1,
					alpha: 1,
				},
			],
		},
	});

	const result = await runCaptureMatrix({
		rows,
		adapter,
		outputRoot,
		runId: "cgwindow-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "hidden");
	assert.equal(result.results[0]!.passed, true);
	assert.equal(result.results[1]!.actualResult, "visible");
	assert.equal(result.results[1]!.passed, true);
});

test("MacosScreenCaptureKitAdapter is explicit opt-in and otherwise skips", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-sck-"),
	);
	const row = createDefaultMacosScreenCaptureKitRows({
		platform: "darwin",
	})[0]!;
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new MacosScreenCaptureKitAdapter({
			platform: "darwin",
			enabled: false,
		}),
		outputRoot,
		runId: "sck-skip",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "skipped");
	assert.match(result.results[0]!.reason ?? "", /explicit opt-in/);
});

test("WindowsCaptureAdapterStub records explicit skip reason", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-windows-"),
	);
	const row = createDefaultWindowsCaptureRows({ platform: "win32" })[0]!;
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new WindowsCaptureAdapterStub({ platform: "win32" }),
		outputRoot,
		runId: "windows-skip",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]!.actualResult, "skipped");
	assert.match(result.results[0]!.reason ?? "", /not implemented/);
});
