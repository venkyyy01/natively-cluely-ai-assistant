import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

// NAT-017 — verifies the JS-side panic recovery path. The Rust DSP thread now
// runs under `catch_unwind` and, on panic, dispatches a `(Error, undefined)`
// payload through a `CalleeHandled` ThreadsafeFunction. The JS wrappers must
// translate that into an `'error'` event tagged with `code: 'AUDIO_THREAD_PANIC'`
// so the existing audio-recovery loop in `main.ts` can re-run the pipeline.

type AudioCallback = (
	first: Uint8Array | Error | null,
	second?: Uint8Array,
) => void;

class PanickingSystemAudioMonitor {
	static lastInstance: PanickingSystemAudioMonitor | null = null;
	static panicMessage = "simulated audio dsp panic";

	private callback: AudioCallback | null = null;

	constructor() {
		PanickingSystemAudioMonitor.lastInstance = this;
	}

	getSampleRate(): number {
		return 48_000;
	}

	start(callback: AudioCallback): void {
		this.callback = callback;
		setImmediate(() => {
			const err = new Error(
				`audio_thread_panic: ${PanickingSystemAudioMonitor.panicMessage}`,
			);
			this.callback?.(err, undefined);
		});
	}

	stop(): void {}
}

class PanickingMicrophoneMonitor {
	static lastInstance: PanickingMicrophoneMonitor | null = null;
	static panicMessage = "simulated mic dsp panic";

	private callback: AudioCallback | null = null;

	constructor() {
		PanickingMicrophoneMonitor.lastInstance = this;
	}

	getSampleRate(): number {
		return 48_000;
	}

	start(callback: AudioCallback): void {
		this.callback = callback;
		setImmediate(() => {
			const err = new Error(
				`audio_thread_panic: ${PanickingMicrophoneMonitor.panicMessage}`,
			);
			this.callback?.(err, undefined);
		});
	}

	stop(): void {}
}

function installPanickingNativeMocks(): () => void {
	const originalLoad = (Module as any)._load;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	): unknown {
		if (request === "./nativeModule") {
			const nativeModule = {
				SystemAudioCapture: PanickingSystemAudioMonitor,
				MicrophoneCapture: PanickingMicrophoneMonitor,
			};
			return {
				loadNativeAudioModule: (): typeof nativeModule => nativeModule,
				assertNativeAudioAvailable: (): typeof nativeModule => nativeModule,
				getNativeAudioLoadError: (): null => null,
			};
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

function nextTickPromise(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("SystemAudioCapture surfaces a Rust DSP panic as an AUDIO_THREAD_PANIC error event", async () => {
	const restore = installPanickingNativeMocks();
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];
	PanickingSystemAudioMonitor.panicMessage = "speaker stream poisoned";

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();

		let receivedData = 0;
		const errors: Error[] = [];

		capture.on("data", () => {
			receivedData += 1;
		});
		capture.on("error", (err: Error) => {
			errors.push(err);
		});

		capture.start();
		await nextTickPromise();

		assert.equal(receivedData, 0, "no data should be emitted on a panic");
		assert.equal(errors.length, 1, "a panic must surface exactly once");
		const err = errors[0];
		assert.match(
			err.message,
			/audio_thread_panic/,
			"error message should include audio_thread_panic prefix",
		);
		assert.match(
			err.message,
			/speaker stream poisoned/,
			"error message should preserve native panic text",
		);
		assert.equal((err as Error & { code?: string }).code, "AUDIO_THREAD_PANIC");
	} finally {
		restore();
	}
});

test("MicrophoneCapture surfaces a Rust DSP panic as an AUDIO_THREAD_PANIC error event", async () => {
	const restore = installPanickingNativeMocks();
	const modulePath = require.resolve("../audio/MicrophoneCapture");
	delete require.cache[modulePath];
	PanickingMicrophoneMonitor.panicMessage = "mic ringbuf overrun";

	try {
		const { MicrophoneCapture } = await import("../audio/MicrophoneCapture");
		const capture = new MicrophoneCapture();

		let receivedData = 0;
		const errors: Error[] = [];

		capture.on("data", () => {
			receivedData += 1;
		});
		capture.on("error", (err: Error) => {
			errors.push(err);
		});

		capture.start();
		await nextTickPromise();

		assert.equal(receivedData, 0, "no data should be emitted on a panic");
		assert.equal(errors.length, 1, "a panic must surface exactly once");
		const err = errors[0];
		assert.match(
			err.message,
			/audio_thread_panic/,
			"error message should include audio_thread_panic prefix",
		);
		assert.match(
			err.message,
			/mic ringbuf overrun/,
			"error message should preserve native panic text",
		);
		assert.equal((err as Error & { code?: string }).code, "AUDIO_THREAD_PANIC");
	} finally {
		restore();
	}
});

test("Panic Error never reaches the data-event handler as a chunk", async () => {
	const restore = installPanickingNativeMocks();
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();

		capture.on("data", (chunk: Buffer) => {
			assert.ok(
				Buffer.isBuffer(chunk),
				"data handler must only see Buffer chunks",
			);
		});
		capture.on("error", () => {});

		capture.start();
		await nextTickPromise();
	} finally {
		restore();
	}
});
