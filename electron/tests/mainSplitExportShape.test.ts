import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ELECTRON_DIR = path.join(process.cwd(), "electron");

test("NAT-066: main.ts entry point is under 400 LOC", () => {
	const mainPath = path.join(ELECTRON_DIR, "main.ts");
	const lines = fs.readFileSync(mainPath, "utf8").split("\n").length;
	assert.ok(lines < 400, `main.ts has ${lines} lines, expected < 400`);
});

test("NAT-066: main.ts re-exports AppState barrel", async () => {
	// Verify the barrel re-export exists by checking source
	const mainSource = fs.readFileSync(
		path.join(ELECTRON_DIR, "main.ts"),
		"utf8",
	);
	assert.ok(
		mainSource.includes("export { AppState } from './main/AppState'") ||
			mainSource.includes('export { AppState } from "./main/AppState"'),
		"main.ts should barrel-export AppState",
	);
});

test("NAT-066: split modules exist and are non-empty", () => {
	const modules = [
		"main/logging.ts",
		"main/sttUtils.ts",
		"main/AppState.ts",
		"main/bootstrap.ts",
	];
	for (const mod of modules) {
		const modPath = path.join(ELECTRON_DIR, mod);
		assert.ok(fs.existsSync(modPath), `${mod} should exist`);
		const stat = fs.statSync(modPath);
		assert.ok(stat.size > 0, `${mod} should be non-empty`);
	}
});

test("NAT-066: AppState class is no longer defined inline in main.ts", () => {
	const mainSource = fs.readFileSync(
		path.join(ELECTRON_DIR, "main.ts"),
		"utf8",
	);
	assert.ok(
		!mainSource.includes("export class AppState"),
		"main.ts should not define AppState inline",
	);
});
