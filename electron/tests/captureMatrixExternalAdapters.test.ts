import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	BrowserGetDisplayMediaAdapter,
	createDefaultBrowserGetDisplayMediaRows,
	createDefaultMeetingAppRows,
	ManualExternalCaptureAdapter,
} from "../stealth/CaptureMatrixExternalAdapters";
import { runCaptureMatrix } from "../stealth/CaptureMatrixHarness";
import { renderCanaryPngBuffer } from "../stealth/CaptureMatrixLocalAdapters";

test("BrowserGetDisplayMediaAdapter skips unless explicitly enabled", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-browser-skip-"),
	);
	const rows = createDefaultBrowserGetDisplayMediaRows({
		platform: "darwin",
	});
	const row = rows[0];
	if (!row) throw new Error("No row created");
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new BrowserGetDisplayMediaAdapter({
			platform: "darwin",
			enabled: false,
		}),
		outputRoot,
		runId: "browser-skip",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]?.actualResult, "skipped");
	assert.match(result.results[0]?.reason ?? "", /explicit opt-in/);
	assert.equal(
		result.results[0]?.artifactMetadata?.externalCaptureMode,
		"getDisplayMedia",
	);
});

test("BrowserGetDisplayMediaAdapter analyzes injected Playwright capture artifacts", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-browser-"),
	);
	const rows = createDefaultBrowserGetDisplayMediaRows({
		platform: "darwin",
	});
	const row = rows[1];
	if (!row) throw new Error("No row created");
	const canaryPng = await renderCanaryPngBuffer(row.canaryToken);
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new BrowserGetDisplayMediaAdapter({
			platform: "darwin",
			enabled: true,
			runner: async (_row, artifactDir, testPagePath) => {
				const capturePath = path.join(artifactDir, "browser-capture.png");
				await writeFile(capturePath, canaryPng);
				return {
					capturePath,
					log: `testPage=${testPagePath}`,
					externalAppVersion: "Chromium 120",
					externalCaptureMode: "getDisplayMedia",
				};
			},
		}),
		outputRoot,
		runId: "browser-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.passed, true);
	assert.equal(result.results[0]?.actualResult, "visible");
	assert.equal(
		result.results[0]?.artifactMetadata?.externalAppVersion,
		"Chromium 120",
	);
	assert.ok(result.results[0]?.artifactPaths.capture);
});

test("ManualExternalCaptureAdapter records external app metadata when artifact is missing", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-manual-skip-"),
	);
	const rows = createDefaultMeetingAppRows({
		platform: "darwin",
		externalApps: [
			{
				name: "Zoom",
				captureTool: "zoom-screen-share",
				version: "6.0.0",
				captureMode: "screen-share",
			},
		],
	});
	const row = rows[0];
	if (!row) throw new Error("No row created");
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new ManualExternalCaptureAdapter({ platform: "darwin" }),
		outputRoot,
		runId: "manual-skip",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.results[0]?.actualResult, "skipped");
	assert.equal(result.results[0]?.artifactMetadata?.externalAppName, "Zoom");
	assert.equal(
		result.results[0]?.artifactMetadata?.externalAppVersion,
		"6.0.0",
	);
	assert.equal(
		result.results[0]?.artifactMetadata?.externalCaptureMode,
		"screen-share",
	);
});

test("ManualExternalCaptureAdapter analyzes supplied meeting app capture artifacts", async () => {
	const outputRoot = await mkdtemp(
		path.join(os.tmpdir(), "capture-matrix-manual-"),
	);
	const rows = createDefaultMeetingAppRows({
		platform: "darwin",
		externalApps: [
			{
				name: "OBS Studio",
				captureTool: "obs-display-capture",
				version: "30.2.0",
				captureMode: "display-capture",
			},
		],
	});
	const row = rows[1];
	if (!row) throw new Error("No row created");
	const canaryPng = await renderCanaryPngBuffer(row.canaryToken);
	const result = await runCaptureMatrix({
		rows: [row],
		adapter: new ManualExternalCaptureAdapter({
			platform: "darwin",
			artifactResolver: async (_row, artifactDir) => {
				const capturePath = path.join(artifactDir, "obs-capture.png");
				await writeFile(capturePath, canaryPng);
				return {
					capturePath,
					externalAppVersion: "30.2.0",
					externalCaptureMode: "display-capture",
				};
			},
		}),
		outputRoot,
		runId: "manual-run",
		generatedAt: "1970-01-01T00:00:00.000Z",
	});

	assert.equal(result.passed, true);
	assert.equal(result.results[0]?.actualResult, "visible");
	assert.equal(
		result.results[0]?.artifactMetadata?.externalAppName,
		"OBS Studio",
	);
	const capturePath = result.results[0]?.artifactPaths.capture;
	if (!capturePath) throw new Error("No capture path");
	assert.equal(
		await readFile(capturePath, "utf8").then(
			() => true,
		),
		true,
	);
});
