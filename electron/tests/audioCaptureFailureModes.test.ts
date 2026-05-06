import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

type NativeAudioModule = {
	MicrophoneCapture?: new (deviceId?: string | null) => any;
	SystemAudioCapture?: new (deviceId?: string | null) => any;
};

function installNativeAudioMocks({
	nativeModule,
	assertedModule = nativeModule,
	loadError = null,
}: {
	nativeModule: NativeAudioModule | null;
	assertedModule?: NativeAudioModule | null;
	loadError?: Error | null;
}): () => void {
	const originalLoad = (Module as any)._load;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	): unknown {
		if (request === "./nativeModule") {
			return {
				loadNativeAudioModule: (): NativeAudioModule | null => nativeModule,
				assertNativeAudioAvailable: (): NativeAudioModule | null =>
					assertedModule,
				getNativeAudioLoadError: (): Error | null => loadError,
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("MicrophoneCapture falls back to 48kHz when the native monitor does not expose a sample rate", async () => {
	class NoRateMicrophoneMonitor {
		start(): void {}
		stop(): void {}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { MicrophoneCapture: NoRateMicrophoneMonitor },
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture("");

		assert.equal(capture.getSampleRate(), 48_000);

		capture.stop();
		capture.destroy();
	} finally {
		restore();
	}
});

test("MicrophoneCapture reports a missing native constructor when the native module fails to load", async () => {
	const restore = installNativeAudioMocks({
		nativeModule: null,
		assertedModule: {},
		loadError: new Error("native module missing"),
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");

		assert.throws(
			() => new MicrophoneCapture(),
			/Rust class implementation not found/,
		);
	} finally {
		restore();
	}
});

test("MicrophoneCapture start fails fast when the module loaded without a MicrophoneCapture export", async () => {
	class AvailableOnlyViaAssertMonitor {
		start(): void {
			throw new Error("should not start");
		}
		stop(): void {}
	}

	const restore = installNativeAudioMocks({
		nativeModule: {},
		assertedModule: { MicrophoneCapture: AvailableOnlyViaAssertMonitor },
		loadError: new Error("native module missing"),
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture();

		assert.throws(() => capture.start(), /native module missing|Cannot start/);
	} finally {
		restore();
	}
});

test("MicrophoneCapture re-emits reinitialization failures when the native monitor disappears mid-session", async () => {
	class FlakyMicrophoneMonitor {
		static instances = 0;

		constructor() {
			FlakyMicrophoneMonitor.instances += 1;
			if (FlakyMicrophoneMonitor.instances === 2) {
				throw new Error("reinitialize failed");
			}
		}

		start(): void {}
		stop(): void {}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { MicrophoneCapture: FlakyMicrophoneMonitor },
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture();
		const errors: Error[] = [];

		capture.on("error", (error: Error) => {
			errors.push(error);
		});

		(capture as unknown as { monitor: unknown }).monitor = null;

		assert.throws(() => capture.start(), /reinitialize failed/);
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /reinitialize failed/);
	} finally {
		restore();
	}
});

test("MicrophoneCapture forwards speech events, takes the debug logging branch, and tolerates stop failures", async () => {
	class VerboseMicrophoneMonitor {
		start(
			callback: (first: Uint8Array | null, second?: Uint8Array) => void,
			onSpeechEnded?: () => void,
		): void {
			callback(Uint8Array.from([7, 8, 9]));
			onSpeechEnded?.();
		}

		stop(): void {
			throw new Error("stop failed");
		}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { MicrophoneCapture: VerboseMicrophoneMonitor },
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];
	const originalRandom = Math.random;
	Math.random = () => 0;

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture("mic-1");
		const received: number[][] = [];
		let speechEnded = 0;
		let started = 0;
		let stopped = 0;

		capture.on("data", (chunk: Buffer) => {
			received.push(Array.from(chunk.values()));
		});
		capture.on("speech_ended", () => {
			speechEnded += 1;
		});
		capture.on("start", () => {
			started += 1;
		});
		capture.on("stop", () => {
			stopped += 1;
		});

		capture.start();
		capture.stop();

		assert.deepEqual(received, [[7, 8, 9]]);
		assert.equal(speechEnded, 1);
		assert.equal(started, 1);
		assert.equal(stopped, 1);
	} finally {
		Math.random = originalRandom;
		restore();
	}
});

test("MicrophoneCapture emits an error when native capture fails during start", async () => {
	class StartFailingMicrophoneMonitor {
		start(): void {
			throw new Error("start failed");
		}

		stop(): void {}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { MicrophoneCapture: StartFailingMicrophoneMonitor },
	});
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture();
		const errors: Error[] = [];
		let started = 0;

		capture.on("error", (error: Error) => {
			errors.push(error);
		});
		capture.on("start", () => {
			started += 1;
		});

		capture.start();

		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /start failed/);
		assert.equal(started, 0);
	} finally {
		restore();
	}
});

test("SystemAudioCapture keeps its fallback sample rate when probe-time native loading is unavailable", async () => {
	class AssertOnlySystemMonitor {}

	const restore = installNativeAudioMocks({
		nativeModule: null,
		assertedModule: { SystemAudioCapture: AssertOnlySystemMonitor },
		loadError: new Error("system module missing"),
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();

		assert.equal(capture.getSampleRate(), 48_000);

		capture.stop();
		capture.destroy();
	} finally {
		restore();
	}
});

test("SystemAudioCapture reports a missing native constructor when validation cannot provide one", async () => {
	const restore = installNativeAudioMocks({
		nativeModule: {},
		assertedModule: {},
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");

		assert.throws(
			() => new SystemAudioCapture(),
			/Rust class implementation not found/,
		);
	} finally {
		restore();
	}
});

test("SystemAudioCapture start throws when the loaded module is missing the SystemAudioCapture export", async () => {
	class AvailableOnlyViaAssertSystemMonitor {}

	const restore = installNativeAudioMocks({
		nativeModule: {},
		assertedModule: { SystemAudioCapture: AvailableOnlyViaAssertSystemMonitor },
		loadError: new Error("system module missing"),
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();

		assert.throws(() => capture.start(), /system module missing|Cannot start/);
	} finally {
		restore();
	}
});

test("SystemAudioCapture emits an error and returns when lazy monitor creation fails at start time", async () => {
	class ThrowingSystemMonitor {
		constructor() {
			throw new Error("lazy init failed");
		}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { SystemAudioCapture: ThrowingSystemMonitor },
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();
		const errors: Error[] = [];
		let started = 0;

		capture.on("error", (error: Error) => {
			errors.push(error);
		});
		capture.on("start", () => {
			started += 1;
		});

		capture.start();

		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /lazy init failed/);
		assert.equal(started, 0);
	} finally {
		restore();
	}
});

test("SystemAudioCapture keeps the fallback sample rate when the native monitor has no rate method and tolerates stop failures", async () => {
	class NoRateSystemMonitor {
		start(
			callback: (first: Uint8Array | null, second?: Uint8Array) => void,
			onSpeechEnded?: () => void,
		): void {
			callback(Uint8Array.from([4, 5, 6]));
			onSpeechEnded?.();
		}

		stop(): void {
			throw new Error("stop failed");
		}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { SystemAudioCapture: NoRateSystemMonitor },
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture("speaker-1");
		const received: number[][] = [];
		let speechEnded = 0;
		let started = 0;
		let stopped = 0;

		capture.on("data", (chunk: Buffer) => {
			received.push(Array.from(chunk.values()));
		});
		capture.on("speech_ended", () => {
			speechEnded += 1;
		});
		capture.on("start", () => {
			started += 1;
		});
		capture.on("stop", () => {
			stopped += 1;
		});

		capture.start();
		assert.equal(capture.getSampleRate(), 48_000);
		capture.stop();

		assert.deepEqual(received, [[4, 5, 6]]);
		assert.equal(speechEnded, 1);
		assert.equal(started, 1);
		assert.equal(stopped, 1);
	} finally {
		restore();
	}
});

test("SystemAudioCapture emits an error when native capture start throws after monitor initialization", async () => {
	class StartFailingSystemMonitor {
		getSampleRate(): number {
			return 44_100;
		}

		start(): void {
			throw new Error("start failed");
		}

		stop(): void {}
	}

	const restore = installNativeAudioMocks({
		nativeModule: { SystemAudioCapture: StartFailingSystemMonitor },
	});
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();
		const errors: Error[] = [];
		let started = 0;

		capture.on("error", (error: Error) => {
			errors.push(error);
		});
		capture.on("start", () => {
			started += 1;
		});

		capture.start();

		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /start failed/);
		assert.equal(started, 0);
	} finally {
		restore();
	}
});
