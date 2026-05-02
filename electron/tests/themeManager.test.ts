import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function installThemeManagerHarness(options?: {
	mode?: "system" | "light" | "dark";
}) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "theme-manager-"));
	const userDataDir = path.join(tempRoot, "user-data");
	fs.mkdirSync(userDataDir, { recursive: true });

	if (options?.mode) {
		fs.writeFileSync(
			path.join(userDataDir, "theme-config.json"),
			JSON.stringify({ mode: options.mode }),
			"utf8",
		);
	}

	const nativeTheme = {
		themeSource: "system" as "system" | "light" | "dark",
		shouldUseDarkColors: false,
		on: () => {},
	};

	const electronMock = {
		nativeTheme,
		BrowserWindow: {
			getAllWindows: (): never[] => [],
		},
		app: {
			getPath: (name: string) => (name === "userData" ? userDataDir : tempRoot),
		},
	};

	const originalLoad = (Module as any)._load;
	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return electronMock;
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return {
		nativeTheme,
		restore: () => {
			(Module as any)._load = originalLoad;
		},
	};
}

test("ThemeManager applies the dark theme source during startup when no config exists", async () => {
	const harness = installThemeManagerHarness();
	const modulePath = require.resolve("../ThemeManager");
	delete require.cache[modulePath];

	try {
		const { ThemeManager } = await import("../ThemeManager");
		(ThemeManager as any).instance = undefined;
		ThemeManager.getInstance();

		assert.equal(harness.nativeTheme.themeSource, "dark");
	} finally {
		harness.restore();
	}
});

test("ThemeManager applies the stored light theme source during startup", async () => {
	const harness = installThemeManagerHarness({ mode: "light" });
	const modulePath = require.resolve("../ThemeManager");
	delete require.cache[modulePath];

	try {
		const { ThemeManager } = await import("../ThemeManager");
		(ThemeManager as any).instance = undefined;
		ThemeManager.getInstance();

		assert.equal(harness.nativeTheme.themeSource, "light");
	} finally {
		harness.restore();
	}
});
