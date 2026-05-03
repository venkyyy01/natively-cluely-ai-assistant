import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PRELOAD_DIR = path.join(process.cwd(), "electron", "preload");

test("NAT-067: preload split modules exist", () => {
	const modules = ["types.ts", "api.ts"];
	for (const mod of modules) {
		const modPath = path.join(PRELOAD_DIR, mod);
		assert.ok(fs.existsSync(modPath), `${mod} should exist`);
		const stat = fs.statSync(modPath);
		assert.ok(stat.size > 0, `${mod} should be non-empty`);
	}
});

test("NAT-067: preload.ts is a thin barrel", () => {
	const source = fs.readFileSync(
		path.join(process.cwd(), "electron", "preload.ts"),
		"utf8",
	);
	assert.ok(source.length > 0, "preload.ts should not be empty");
	assert.ok(
		source.includes("preload/api"),
		"should import from api module",
	);
});

test("NAT-067: preload/api.ts exports ElectronAPI interface and PROCESSING_EVENTS", () => {
	const source = fs.readFileSync(path.join(PRELOAD_DIR, "api.ts"), "utf8");
	assert.ok(
		source.includes("export interface ElectronAPI"),
		"should export ElectronAPI",
	);
	assert.ok(
		source.includes("export const PROCESSING_EVENTS"),
		"should export PROCESSING_EVENTS",
	);
});

test("NAT-067: preload/types.ts exports helpers", () => {
	const source = fs.readFileSync(path.join(PRELOAD_DIR, "types.ts"), "utf8");
	assert.ok(
		source.includes("export const isIpcResult"),
		"should export isIpcResult",
	);
	assert.ok(
		source.includes("export const invokeAndUnwrap"),
		"should export invokeAndUnwrap",
	);
});
