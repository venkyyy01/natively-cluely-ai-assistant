import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

class FakeSystemAudioMonitor {
	static instances = 0;
	static sampleRate = 44100;

	constructor(_deviceId?: string | null) {
		FakeSystemAudioMonitor.instances += 1;
	}

	getSampleRate(): number {
		return FakeSystemAudioMonitor.sampleRate;
	}

	getOutputSampleRate(): number {
		return 16000;
	}

	start(): void {}
	stop(): void {}
}

function installSystemAudioMocks(): () => void {
	const originalLoad = (Module as any)._load;
	FakeSystemAudioMonitor.instances = 0;

	(Module as any)._load = function patchedLoad(
		request: string,
		parent: unknown,
		isMain: boolean,
	): unknown {
		if (request === "./nativeModule") {
			const nativeModule = {
				SystemAudioCapture: FakeSystemAudioMonitor,
			};

			return {
				loadNativeAudioModule: (): {
					SystemAudioCapture: typeof FakeSystemAudioMonitor;
				} => nativeModule,
				assertNativeAudioAvailable: (): {
					SystemAudioCapture: typeof FakeSystemAudioMonitor;
				} => nativeModule,
				getNativeAudioLoadError: (): null => null,
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	return () => {
		(Module as any)._load = originalLoad;
	};
}

test("SystemAudioCapture probes the native sample rate before start without recreating the monitor", async () => {
	const restore = installSystemAudioMocks();
	const modulePath = require.resolve("../audio/SystemAudioCapture");
	delete require.cache[modulePath];

	try {
		const { SystemAudioCapture } = await import("../audio/SystemAudioCapture");
		const capture = new SystemAudioCapture();

		assert.equal(capture.getSampleRate(), 44100);
		assert.equal(capture.getOutputSampleRate(), 16000);
		assert.equal(FakeSystemAudioMonitor.instances, 1);

		capture.start();
		assert.equal(FakeSystemAudioMonitor.instances, 1);
	} finally {
		restore();
	}
});
