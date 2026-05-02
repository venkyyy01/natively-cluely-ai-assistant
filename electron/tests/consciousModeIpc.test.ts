import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type ElectronAppMock = {
	isReady: () => boolean;
	getPath: (name: string) => string;
	setLoginItemSettings: () => void;
	getLoginItemSettings: () => { openAtLogin: boolean };
};

type ConsciousModeSuccess = {
	success: true;
	data: {
		enabled: boolean;
	};
};

type ConsciousModeFailure = {
	success: false;
	error: {
		code: string;
		message: string;
	};
};

function installElectronMock(userDataPath: string): () => void {
	const originalLoad = (Module as any)._load;
	const electronApp: ElectronAppMock = {
		isReady: () => true,
		getPath: (name: string) => {
			if (name === "userData") {
				return userDataPath;
			}

			if (name === "exe") {
				return "/mock/exe";
			}

			return userDataPath;
		},
		setLoginItemSettings: () => {},
		getLoginItemSettings: () => ({ openAtLogin: false }),
	};

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return { app: electronApp };
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

async function loadSettingsModules(userDataPath: string) {
	const restoreElectron = installElectronMock(userDataPath);

	const settingsModulePath = require.resolve("../services/SettingsManager");
	const registerModulePath = require.resolve("../ipc/registerSettingsHandlers");
	delete require.cache[settingsModulePath];
	delete require.cache[registerModulePath];

	const { SettingsManager } = await import("../services/SettingsManager");
	const { registerSettingsHandlers } = await import(
		"../ipc/registerSettingsHandlers"
	);

	return {
		SettingsManager,
		registerSettingsHandlers,
		restoreElectron,
	};
}

function createHandlerRegistry() {
	const handlers = new Map<
		string,
		(event: unknown, ...args: unknown[]) => unknown
	>();

	return {
		handlers,
		safeHandle: (channel: string, listener: any) => {
			handlers.set(channel, listener);
		},
		safeHandleValidated: <T extends unknown[]>(
			channel: string,
			parser: (args: unknown[]) => T,
			listener: any,
		) => {
			handlers.set(channel, (event: unknown, ...args: unknown[]) =>
				listener(event, ...parser(args)),
			);
		},
	};
}

async function loadPreloadModule() {
	const originalLoad = (Module as any)._load;
	const listeners = new Map<string, Function[]>();
	let exposedApi: any;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return {
				contextBridge: {
					exposeInMainWorld: (_name: string, api: any) => {
						exposedApi = api;
					},
				},
				ipcRenderer: {
					invoke: async (): Promise<undefined> => undefined,
					on: (channel: string, listener: Function) => {
						listeners.set(channel, [
							...(listeners.get(channel) || []),
							listener,
						]);
					},
					removeListener: (channel: string, listener: Function) => {
						listeners.set(
							channel,
							(listeners.get(channel) || []).filter(
								(entry) => entry !== listener,
							),
						);
					},
				},
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	const preloadModulePath = require.resolve("../preload");
	const preloadApiModulePath = require.resolve("../preload/api");
	delete require.cache[preloadModulePath];
	delete require.cache[preloadApiModulePath];
	await import("../preload");

	return {
		exposedApi,
		listeners,
		restore: (): void => {
			(Module as any)._load = originalLoad;
		},
	};
}

test("Conscious Mode IPC persists backend truth and returns spec-shaped success contracts", async () => {
	const userDataPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "conscious-mode-ipc-"),
	);
	const { SettingsManager, registerSettingsHandlers, restoreElectron } =
		await loadSettingsModules(userDataPath);
	(SettingsManager as any).instance = undefined;

	const registry = createHandlerRegistry();
	const state = { consciousModeEnabled: false };
	const appState = {
		getIntelligenceManager: () => ({
			setConsciousModeEnabled: (enabled: boolean) => {
				state.consciousModeEnabled = enabled;
			},
		}),
		setConsciousModeEnabled: (enabled: boolean) => {
			state.consciousModeEnabled = enabled;
			SettingsManager.getInstance().set("consciousModeEnabled" as any, enabled);
		},
		getConsciousModeEnabled: () => state.consciousModeEnabled,
	};

	registerSettingsHandlers({ appState: appState as any, ...registry });

	const getConsciousMode = registry.handlers.get("get-conscious-mode");
	const setConsciousMode = registry.handlers.get("set-conscious-mode");

	assert.ok(getConsciousMode);
	assert.ok(setConsciousMode);
	assert.deepEqual(await getConsciousMode?.({}), {
		success: true,
		data: { enabled: false },
	} satisfies ConsciousModeSuccess);
	assert.deepEqual(await setConsciousMode?.({}, true), {
		success: true,
		data: { enabled: true },
	} satisfies ConsciousModeSuccess);
	assert.deepEqual(await getConsciousMode?.({}), {
		success: true,
		data: { enabled: true },
	} satisfies ConsciousModeSuccess);

	const settingsPath = path.join(userDataPath, "settings.json");
	const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(persisted.consciousModeEnabled, true);

	(SettingsManager as any).instance = undefined;
	assert.equal(
		SettingsManager.getInstance().get("consciousModeEnabled" as any),
		true,
	);

	restoreElectron();
});

test("Conscious Mode IPC returns structured failure contracts when persistence does not complete", async () => {
	const userDataPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "conscious-mode-ipc-errors-"),
	);
	const { SettingsManager, registerSettingsHandlers, restoreElectron } =
		await loadSettingsModules(userDataPath);
	(SettingsManager as any).instance = undefined;

	const registry = createHandlerRegistry();
	const appState = {
		setConsciousModeEnabled: () => false,
		getConsciousModeEnabled: () => {
			throw new Error("read failed");
		},
	};

	registerSettingsHandlers({ appState: appState as any, ...registry });

	const getConsciousMode = registry.handlers.get("get-conscious-mode");
	const setConsciousMode = registry.handlers.get("set-conscious-mode");

	assert.deepEqual(await setConsciousMode?.({}, true), {
		success: false,
		error: {
			code: "SETTINGS_PERSIST_FAILED",
			message: "Unable to persist Conscious Mode",
		},
	} satisfies ConsciousModeFailure);
	assert.deepEqual(await getConsciousMode?.({}), {
		success: false,
		error: {
			code: "SETTINGS_READ_FAILED",
			message: "read failed",
		},
	} satisfies ConsciousModeFailure);

	restoreElectron();
});

test("Conscious Mode IPC returns structured failure contracts when backend setter throws", async () => {
	const userDataPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "conscious-mode-ipc-throws-"),
	);
	const { SettingsManager, registerSettingsHandlers, restoreElectron } =
		await loadSettingsModules(userDataPath);
	(SettingsManager as any).instance = undefined;

	const registry = createHandlerRegistry();
	const appState = {
		setConsciousModeEnabled: () => {
			throw new Error("persist failed");
		},
		getConsciousModeEnabled: () => false,
	};

	registerSettingsHandlers({ appState: appState as any, ...registry });

	const setConsciousMode = registry.handlers.get("set-conscious-mode");

	assert.deepEqual(await setConsciousMode?.({}, true), {
		success: false,
		error: {
			code: "SETTINGS_PERSIST_FAILED",
			message: "persist failed",
		},
	} satisfies ConsciousModeFailure);

	restoreElectron();
});

test("SettingsManager narrows persisted Conscious Mode and disguise settings on load", async () => {
	const userDataPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "conscious-mode-validate-"),
	);
	const settingsPath = path.join(userDataPath, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			consciousModeEnabled: "yes",
			disguiseMode: "spaceship",
			isUndetectable: true,
			enablePrivateMacosStealthApi: true,
			enableCaptureDetectionWatchdog: "sometimes",
		}),
	);

	const { SettingsManager, restoreElectron } =
		await loadSettingsModules(userDataPath);
	(SettingsManager as any).instance = undefined;

	const settings = SettingsManager.getInstance();

	assert.equal(settings.get("consciousModeEnabled"), undefined);
	assert.equal(settings.get("disguiseMode"), undefined);
	assert.equal(settings.get("isUndetectable"), true);
	assert.equal(settings.get("enablePrivateMacosStealthApi"), true);
	assert.equal(settings.get("enableCaptureDetectionWatchdog"), undefined);

	restoreElectron();
});

test("Conscious Mode session state survives resets so backend truth does not drift", async () => {
	const { SessionTracker } = await import("../SessionTracker");
	const session = new SessionTracker();

	session.setConsciousModeEnabled(true);
	session.reset();

	assert.equal(session.isConsciousModeEnabled(), true);
});

test("Preload exposes Conscious Mode change subscription on the backend sync channel", async () => {
	const { exposedApi, listeners, restore } = await loadPreloadModule();
	const seen: boolean[] = [];

	assert.equal(typeof exposedApi.onConsciousModeChanged, "function");

	const unsubscribe = exposedApi.onConsciousModeChanged((enabled: boolean) => {
		seen.push(enabled);
	});

	const registered = listeners.get("conscious-mode-changed") || [];
	assert.equal(registered.length, 1);

	registered[0]({}, true);
	assert.deepEqual(seen, [true]);

	unsubscribe();
	assert.deepEqual(listeners.get("conscious-mode-changed") || [], []);

	restore();
});

test("Preload exposes closeSettingsWindow to match the typed renderer contract", async () => {
	const { exposedApi, restore } = await loadPreloadModule();

	assert.equal(typeof exposedApi.closeSettingsWindow, "function");

	restore();
});

test("Preload forwards intelligence cooldown and suggested answer events with metadata", async () => {
	const { exposedApi, listeners, restore } = await loadPreloadModule();
	const cooldownSeen: Array<{
		suppressedMs: number;
		question?: string;
		reason?: string;
	}> = [];
	const suggestedSeen: Array<{
		answer: string;
		question: string;
		confidence: number;
		metadata?: {
			route: string;
			schemaVersion: string;
			fallbackOccurred: boolean;
			contextSelectionHash?: string;
		};
	}> = [];

	assert.equal(typeof exposedApi.onIntelligenceCooldown, "function");
	assert.equal(typeof exposedApi.onIntelligenceSuggestedAnswer, "function");

	const unsubscribeCooldown = exposedApi.onIntelligenceCooldown(
		(data: { suppressedMs: number; question?: string; reason?: string }) => {
			cooldownSeen.push(data);
		},
	);
	const unsubscribeSuggested = exposedApi.onIntelligenceSuggestedAnswer(
		(data: {
			answer: string;
			question: string;
			confidence: number;
			metadata?: {
				route: string;
				schemaVersion: string;
				fallbackOccurred: boolean;
				contextSelectionHash?: string;
			};
		}) => {
			suggestedSeen.push(data);
		},
	);

	const cooldownListeners = listeners.get("intelligence-cooldown") || [];
	const suggestedListeners =
		listeners.get("intelligence-suggested-answer") || [];

	assert.equal(cooldownListeners.length, 1);
	assert.equal(suggestedListeners.length, 1);

	cooldownListeners[0](
		{},
		{
			suppressedMs: 1200,
			question: "Follow-up?",
			reason: "duplicate_question_debounce",
		},
	);
	suggestedListeners[0](
		{},
		{
			answer: "Lead with impact and metrics.",
			question: "How should I answer this?",
			confidence: 0.94,
			metadata: {
				route: "fast_standard_answer",
				schemaVersion: "standard_answer_v1",
				fallbackOccurred: false,
				contextSelectionHash: "ctx-hash",
			},
		},
	);

	assert.deepEqual(cooldownSeen, [
		{
			suppressedMs: 1200,
			question: "Follow-up?",
			reason: "duplicate_question_debounce",
		},
	]);
	assert.deepEqual(suggestedSeen, [
		{
			answer: "Lead with impact and metrics.",
			question: "How should I answer this?",
			confidence: 0.94,
			metadata: {
				route: "fast_standard_answer",
				schemaVersion: "standard_answer_v1",
				fallbackOccurred: false,
				contextSelectionHash: "ctx-hash",
			},
		},
	]);

	unsubscribeCooldown();
	unsubscribeSuggested();

	assert.deepEqual(listeners.get("intelligence-cooldown") || [], []);
	assert.deepEqual(listeners.get("intelligence-suggested-answer") || [], []);

	restore();
});
