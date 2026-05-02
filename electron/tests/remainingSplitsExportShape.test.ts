import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";

const STEALTH_DIR = path.join(process.cwd(), "electron", "stealth");
const SESSION_DIR = path.join(process.cwd(), "electron", "session");

test("NAT-067: StealthManager split modules exist", () => {
	const modules = ["stealthTypes.ts", "windowRecords.ts", "opacityFlicker.ts"];
	for (const mod of modules) {
		const modPath = path.join(STEALTH_DIR, mod);
		assert.ok(fs.existsSync(modPath), `${mod} should exist`);
		const stat = fs.statSync(modPath);
		assert.ok(stat.size > 0, `${mod} should be non-empty`);
	}
});

test("NAT-067: StealthManager.ts still exports StealthManager class", () => {
	const source = fs.readFileSync(
		path.join(STEALTH_DIR, "StealthManager.ts"),
		"utf8",
	);
	assert.ok(
		source.includes("export class StealthManager"),
		"should export StealthManager class",
	);
});

test("NAT-067: SessionTracker split modules exist", () => {
	const modules = [
		"sessionTypes.ts",
		"sessionContext.ts",
		"sessionPersistence.ts",
	];
	for (const mod of modules) {
		const modPath = path.join(SESSION_DIR, mod);
		assert.ok(fs.existsSync(modPath), `${mod} should exist`);
		const stat = fs.statSync(modPath);
		assert.ok(stat.size > 0, `${mod} should be non-empty`);
	}
});

test("NAT-067: SessionTracker.ts still exports SessionTracker class", () => {
	const source = fs.readFileSync(
		path.join(process.cwd(), "electron", "SessionTracker.ts"),
		"utf8",
	);
	assert.ok(
		source.includes("export class SessionTracker"),
		"should export SessionTracker class",
	);
});

test("NAT-067: SessionTracker.ts re-exports types", () => {
	const source = fs.readFileSync(
		path.join(process.cwd(), "electron", "SessionTracker.ts"),
		"utf8",
	);
	assert.ok(source.includes("export type"), "should re-export types");
});
