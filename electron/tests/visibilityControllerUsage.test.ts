import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

const protectedFiles = [
	"electron/WindowHelper.ts",
	"electron/SettingsWindowHelper.ts",
	"electron/ModelSelectorWindowHelper.ts",
	"electron/stealth/StealthRuntime.ts",
	"electron/stealth/StealthManager.ts",
];

const allowedDirectCallSubstrings = [
	"win?.show()",
	"win?.hide()",
	"win?.setOpacity(value)",
	"this.launcherRuntime.show()",
	"this.launcherRuntime.hide()",
	"win.hide()",
];

describe("VisibilityController usage", () => {
	it("keeps direct visibility calls constrained to wrapper fallbacks and non-BrowserWindow runtime delegates", () => {
		const violations: string[] = [];

		for (const relativeFile of protectedFiles) {
			const source = readFileSync(path.join(repoRoot, relativeFile), "utf8");
			const lines = source.split("\n");
			lines.forEach((line, index) => {
				const trimmed = line.trim();
				const hasDirectCall =
					/\.show\(|\.showInactive\(|\.hide\(|\.setOpacity\(/.test(trimmed);
				if (!hasDirectCall || trimmed.startsWith("//")) {
					return;
				}

				if (
					allowedDirectCallSubstrings.some((allowed) =>
						trimmed.includes(allowed),
					)
				) {
					return;
				}

				if (
					trimmed.includes("requestWindowShow") ||
					trimmed.includes("requestWindowHide") ||
					trimmed.includes("setWindowOpacity") ||
					trimmed.includes("visibilityController.setOpacity")
				) {
					return;
				}

				violations.push(`${relativeFile}:${index + 1}: ${trimmed}`);
			});
		}

		assert.deepEqual(violations, []);
	});
});
