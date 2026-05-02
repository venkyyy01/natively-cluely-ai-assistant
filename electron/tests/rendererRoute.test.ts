import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

function installElectronMock(isPackaged: boolean): () => void {
	const originalLoad = (Module as any)._load;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	) {
		if (request === "electron") {
			return {
				app: {
					isPackaged,
					getAppPath: () =>
						"/Applications/Natively.app/Contents/Resources/app.asar",
				},
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("loadRendererRoute uses loadFile with query for packaged windows", async () => {
	const restoreElectron = installElectronMock(true);
	const rendererRoutePath = require.resolve("../rendererRoute");
	delete require.cache[rendererRoutePath];

	try {
		const { getRendererRouteUrl, loadRendererRoute } = await import(
			"../rendererRoute"
		);
		const calls: Array<{
			type: "file" | "url";
			value: string;
			options?: Record<string, unknown>;
		}> = [];

		const fakeWindow = {
			loadFile(filePath: string, options?: Record<string, unknown>) {
				calls.push({ type: "file", value: filePath, options });
				return Promise.resolve();
			},
			loadURL(url: string) {
				calls.push({ type: "url", value: url });
				return Promise.resolve();
			},
		};

		await loadRendererRoute(fakeWindow as never, "launcher");

		assert.equal(
			getRendererRouteUrl("launcher"),
			"file:///Applications/Natively.app/Contents/Resources/app.asar/dist/index.html?window=launcher",
		);
		assert.deepEqual(calls, [
			{
				type: "file",
				value:
					"/Applications/Natively.app/Contents/Resources/app.asar/dist/index.html",
				options: { query: { window: "launcher" } },
			},
		]);
	} finally {
		restoreElectron();
	}
});

test("loadRendererRoute uses dev server URLs during local development", async () => {
	const originalNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "development";
	const restoreElectron = installElectronMock(false);
	const rendererRoutePath = require.resolve("../rendererRoute");
	delete require.cache[rendererRoutePath];

	try {
		const { getRendererRouteUrl, loadRendererRoute } = await import(
			"../rendererRoute"
		);
		const calls: Array<{ type: "file" | "url"; value: string }> = [];

		const fakeWindow = {
			loadFile(filePath: string) {
				calls.push({ type: "file", value: filePath });
				return Promise.resolve();
			},
			loadURL(url: string) {
				calls.push({ type: "url", value: url });
				return Promise.resolve();
			},
		};

		await loadRendererRoute(fakeWindow as never, "overlay");

		assert.equal(
			getRendererRouteUrl("overlay"),
			"http://localhost:5180?window=overlay",
		);
		assert.deepEqual(calls, [
			{ type: "url", value: "http://localhost:5180?window=overlay" },
		]);
	} finally {
		process.env.NODE_ENV = originalNodeEnv;
		restoreElectron();
	}
});
