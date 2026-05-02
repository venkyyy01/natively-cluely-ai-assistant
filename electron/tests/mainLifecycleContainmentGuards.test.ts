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

test("AppState prepareMeetingActivation rejects deferred startup failures instead of swallowing them", async () => {
	const restoreElectron = installElectronMock();
	const originalNodeEnv = process.env.NODE_ENV;
	const originalSetTimeout = global.setTimeout;
	process.env.NODE_ENV = "test";

	(global as typeof globalThis).setTimeout = ((
		callback: (...args: any[]) => void,
	) => {
		callback();
		return { unref() {} } as NodeJS.Timeout;
	}) as typeof setTimeout;

	try {
		const { AppState } = await import("../main");
		const prepareMeetingActivation = (
			AppState.prototype as unknown as {
				prepareMeetingActivation: (
					this: unknown,
					metadata?: unknown,
				) => Promise<void>;
			}
		).prepareMeetingActivation;

		await assert.rejects(
			() =>
				prepareMeetingActivation.call(
					{
						audioRecoveryAttempts: 0,
						audioRecoveryBackoffMs: 0,
						meetingStartMutex: Promise.resolve(),
						meetingLifecycleState: "idle",
						meetingStartSequence: 0,
						isMeetingActive: false,
						currentMeetingId: null,
						broadcast() {},
						validateMeetingAudioSetup: async () => {},
						resetAudioPipelineStats() {},
						intelligenceManager: {
							getSessionTracker: () => ({ ensureMeetingContext() {} }),
							setMeetingMetadata() {},
						},
						getWindowHelper: () => ({
							getOverlayContentWindow: () => ({ webContents: { send() {} } }),
							getLauncherWindow: () => ({ webContents: { send() {} } }),
						}),
						reconfigureAudio: async () => {
							throw new Error("audio start failed");
						},
						ragManager: null,
						stealthManager: { setMeetingActive() {} },
						setNativeAudioConnected() {},
						clearAudioPipelineHealthCheck() {},
					},
					{
						audio: { inputDeviceId: "mic", outputDeviceId: "default" },
					},
				),
			/audio start failed/,
		);
	} finally {
		restoreElectron();
		process.env.NODE_ENV = originalNodeEnv;
		(global as typeof globalThis).setTimeout = originalSetTimeout;
	}
});

test("AppState setUndetectableAsync clears the pending target state after a failed toggle attempt", async () => {
	const restoreElectron = installElectronMock();
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "test";

	try {
		const { AppState } = await import("../main");
		const setUndetectableAsync = (
			AppState.prototype as unknown as {
				setUndetectableAsync: (this: unknown, state: boolean) => Promise<void>;
			}
		).setUndetectableAsync;

		const attempts: string[] = [];
		const fakeState: {
			isUndetectable: boolean;
			pendingUndetectableState: boolean | null;
			runtimeCoordinator: {
				getSupervisor: () => {
					getState: () => string;
					start: () => Promise<void>;
					setEnabled: (state: boolean) => Promise<void>;
				};
			};
			applyUndetectableState: () => void;
		} = {
			isUndetectable: false,
			pendingUndetectableState: null,
			runtimeCoordinator: {
				getSupervisor() {
					return {
						getState() {
							return "idle";
						},
						async start() {
							attempts.push("start");
							throw new Error("stealth helper unavailable");
						},
						async setEnabled(state: boolean) {
							attempts.push(`setEnabled:${state}`);
						},
					};
				},
			},
			applyUndetectableState() {
				attempts.push("apply");
			},
		};

		await assert.rejects(
			() => setUndetectableAsync.call(fakeState, true),
			/stealth helper unavailable/,
		);
		await assert.rejects(
			() => setUndetectableAsync.call(fakeState, true),
			/stealth helper unavailable/,
		);

		assert.deepEqual(attempts, ["start", "start"]);
		assert.equal(
			(fakeState as { pendingUndetectableState: boolean | null })
				.pendingUndetectableState,
			null,
		);
	} finally {
		restoreElectron();
		process.env.NODE_ENV = originalNodeEnv;
	}
});
