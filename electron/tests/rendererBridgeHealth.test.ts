import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	attachRendererBridgeMonitor,
	type RendererBridgeSettledResult,
} from "../runtime/rendererBridgeHealth";

class FakeWebContents extends EventEmitter {
	public reloads = 0;
	public executeJavaScript?: () => Promise<unknown>;

	reloadIgnoringCache(): void {
		this.reloads += 1;
	}
}

class FakeWindow {
	public webContents = new FakeWebContents();
	public destroyed = false;

	isDestroyed(): boolean {
		return this.destroyed;
	}
}

function attachProbe(
	win: FakeWindow,
	settled: RendererBridgeSettledResult[],
): void {
	attachRendererBridgeMonitor("test", win as never, {
		expectedPreloadPath: "/tmp/preload.js",
		url: "http://localhost:5180",
		maxReloadAttempts: 1,
		logger: { log() {}, warn() {}, error() {} },
		onSettled: (result) => {
			settled.push(result);
		},
	});
}

test("RendererBridgeHealth reports ready only after a positive bridge probe", async () => {
	const win = new FakeWindow();
	const settled: RendererBridgeSettledResult[] = [];
	win.webContents.executeJavaScript = async () => true;
	attachProbe(win, settled);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(settled, ["ready"]);
	assert.equal(win.webContents.reloads, 0);
});

test("RendererBridgeHealth reports destroyed windows as non-ready", async () => {
	const win = new FakeWindow();
	const settled: RendererBridgeSettledResult[] = [];
	win.destroyed = true;
	win.webContents.executeJavaScript = async () => true;
	attachProbe(win, settled);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(settled, ["destroyed"]);
});

test("RendererBridgeHealth reports missing probe API as unprobeable", async () => {
	const win = new FakeWindow();
	const settled: RendererBridgeSettledResult[] = [];
	attachProbe(win, settled);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(settled, ["unprobeable"]);
	assert.equal(win.webContents.reloads, 0);
});

test("RendererBridgeHealth reloads once before reporting failed bridge probe", async () => {
	const win = new FakeWindow();
	const settled: RendererBridgeSettledResult[] = [];
	win.webContents.executeJavaScript = async () => false;
	attachProbe(win, settled);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(settled, []);
	assert.equal(win.webContents.reloads, 1);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(settled, ["failed"]);
});

test("RendererBridgeHealth reports failed when bridge probe throws and reload is unavailable", async () => {
	const win = new FakeWindow();
	const settled: RendererBridgeSettledResult[] = [];
	win.webContents.executeJavaScript = async () => {
		throw new Error("probe failed");
	};
	win.webContents.reloadIgnoringCache = undefined as never;
	attachProbe(win, settled);

	win.webContents.emit("did-finish-load");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(settled, ["failed"]);
});
