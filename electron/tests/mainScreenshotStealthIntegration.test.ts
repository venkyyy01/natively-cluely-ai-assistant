import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

function installElectronMock(): () => void {
	const originalLoad = (Module as any)._load;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	): unknown {
		if (request === "electron") {
			return {
				app: {
					isPackaged: true,
					getAppPath(): string {
						return "/tmp";
					},
					getPath(): string {
						return "/tmp";
					},
					whenReady: async (): Promise<void> => undefined,
					on() {},
					commandLine: {
						appendSwitch() {},
					},
					dock: {
						show() {},
						hide() {},
					},
					quit() {},
					exit() {},
				},
				BrowserWindow: {
					getAllWindows: (): unknown[] => [],
				},
				Tray: class {},
				Menu: {},
				nativeImage: {},
				ipcMain: {},
				shell: {},
				systemPreferences: {},
				globalShortcut: {},
				session: {},
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("takeScreenshot resumes the stealth watchdog even when capture fails", async () => {
	const restoreElectron = installElectronMock();
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "test";

	try {
		const { AppState } = await import("../main");
		const takeScreenshot = (
			AppState.prototype as unknown as {
				takeScreenshot: (this: Record<string, any>) => Promise<string>;
			}
		).takeScreenshot;

		const calls: string[] = [];
		const fakeState = Object.assign(Object.create(AppState.prototype), {
			getMainWindow: () => ({ isDestroyed: () => false }),
			stealthManager: {
				pauseWatchdog(_token: string) {
					calls.push("pause");
				},
				resumeWatchdog(_token: string) {
					calls.push("resume");
				},
			},
			windowHelper: {
				getOverlayWindow: (): null => null,
			},
			screenshotHelper: {
				async takeScreenshot() {
					throw new Error("capture failed");
				},
			},
			hideMainWindow() {},
			showMainWindow() {},
		});

		await assert.rejects(
			() => takeScreenshot.call(fakeState),
			/capture failed/,
		);
		assert.deepEqual(calls, ["pause", "resume"]);
	} finally {
		restoreElectron();
		process.env.NODE_ENV = originalNodeEnv;
	}
});

test("takeSelectiveScreenshot resumes the stealth watchdog even when selection is canceled", async () => {
	const restoreElectron = installElectronMock();
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "test";

	try {
		const { AppState } = await import("../main");
		const takeSelectiveScreenshot = (
			AppState.prototype as unknown as {
				takeSelectiveScreenshot: (this: Record<string, any>) => Promise<string>;
			}
		).takeSelectiveScreenshot;

		const calls: string[] = [];
		const fakeState = Object.assign(Object.create(AppState.prototype), {
			getMainWindow: () => ({ isDestroyed: () => false }),
			stealthManager: {
				pauseWatchdog(_token: string) {
					calls.push("pause");
				},
				resumeWatchdog(_token: string) {
					calls.push("resume");
				},
			},
			windowHelper: {
				getOverlayWindow: (): null => null,
			},
			screenshotHelper: {
				async takeSelectiveScreenshot() {
					throw new Error("Selection cancelled");
				},
			},
			hideMainWindow() {},
			showMainWindow() {},
		});

		await assert.rejects(
			() => takeSelectiveScreenshot.call(fakeState),
			/Selection cancelled/,
		);
		assert.deepEqual(calls, ["pause", "resume"]);
	} finally {
		restoreElectron();
		process.env.NODE_ENV = originalNodeEnv;
	}
});
