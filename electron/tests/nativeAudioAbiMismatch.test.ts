import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function installNativeAudioLoadMock(options: {
	appPath: string;
	packageModule?: unknown;
	appPathModule?: unknown;
}): () => void {
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
					getAppPath: () => options.appPath,
				},
			};
		}

		if (request === "natively-audio") {
			if (options.packageModule !== undefined) {
				return options.packageModule;
			}
			const error = new Error("Cannot find module 'natively-audio'");
			(error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
			throw error;
		}

		if (request === path.join(options.appPath, "native-module")) {
			if (options.appPathModule !== undefined) {
				return options.appPathModule;
			}
			throw new Error("native-module not mocked");
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

function writeAbiFile(appPath: string, abiMetadata: string): void {
	const moduleDir = path.join(appPath, "native-module");
	fs.mkdirSync(moduleDir, { recursive: true });
	fs.writeFileSync(
		path.join(moduleDir, "index.node.abi"),
		`${abiMetadata}\n`,
		"utf8",
	);
}

async function importFreshNativeModule() {
	const modulePath = require.resolve("../audio/nativeModule");
	delete require.cache[modulePath];
	return import("../audio/nativeModule");
}

test("NAT-023: native audio load reports actionable N-API mismatch error", async () => {
	const appPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "native-audio-abi-mismatch-"),
	);
	writeAbiFile(appPath, `napi>=${Number(process.versions.napi || "0") + 1}`);
	const restore = installNativeAudioLoadMock({
		appPath,
		appPathModule: { MicrophoneCapture: class {} },
	});

	try {
		const nativeModule = await importFreshNativeModule();
		const loaded = nativeModule.loadNativeAudioModule();
		assert.equal(loaded, null);

		const error = nativeModule.getNativeAudioLoadError();
		assert.ok(error);
		assert.match(error?.message, /Native audio N-API mismatch: requires N-API/);
		assert.match(error?.message, /compatible toolchain or upgrade Electron/);
	} finally {
		restore();
		fs.rmSync(appPath, { recursive: true, force: true });
	}
});

test("NAT-023: native audio load succeeds when N-API metadata matches runtime", async () => {
	const appPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "native-audio-abi-match-"),
	);
	writeAbiFile(appPath, `napi>=${process.versions.napi}`);
	const moduleExports = { MicrophoneCapture: class {} };
	const restore = installNativeAudioLoadMock({
		appPath,
		appPathModule: moduleExports,
	});

	try {
		const nativeModule = await importFreshNativeModule();
		const loaded = nativeModule.loadNativeAudioModule();
		assert.equal(loaded, moduleExports);
		assert.equal(nativeModule.getNativeAudioLoadError(), null);
	} finally {
		restore();
		fs.rmSync(appPath, { recursive: true, force: true });
	}
});

test("NAT-023: native audio load ignores stale legacy node ABI metadata for N-API modules", async () => {
	const appPath = fs.mkdtempSync(
		path.join(os.tmpdir(), "native-audio-legacy-abi-"),
	);
	writeAbiFile(appPath, String(Number(process.versions.modules) + 100));
	const moduleExports = { MicrophoneCapture: class {} };
	const restore = installNativeAudioLoadMock({
		appPath,
		appPathModule: moduleExports,
	});

	try {
		const nativeModule = await importFreshNativeModule();
		const loaded = nativeModule.loadNativeAudioModule();
		assert.equal(loaded, moduleExports);
		assert.equal(nativeModule.getNativeAudioLoadError(), null);
	} finally {
		restore();
		fs.rmSync(appPath, { recursive: true, force: true });
	}
});
