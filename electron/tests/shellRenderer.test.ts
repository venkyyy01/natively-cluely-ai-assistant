import assert from "node:assert/strict";
import test from "node:test";

import { mountStealthShell } from "../renderer/shell";
import type { StealthFramePayload } from "../stealth/types";

class FakeCanvasContext {
	public drawCalls = 0;

	clearRect(): void {}

	drawImage(): void {
		this.drawCalls += 1;
	}
}

class FakeCanvas {
	public width = 0;
	public height = 0;
	private readonly context = new FakeCanvasContext();

	getContext(type: string): FakeCanvasContext | null {
		assert.equal(type, "2d");
		return this.context;
	}

	addEventListener(): void {}

	getBoundingClientRect(): DOMRect {
		return {
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			toJSON() {
				return {};
			},
		} as DOMRect;
	}

	getDrawCalls(): number {
		return this.context.drawCalls;
	}
}

class FakeClassList {
	private readonly values = new Set<string>();

	add(value: string): void {
		this.values.add(value);
	}

	contains(value: string): boolean {
		return this.values.has(value);
	}
}

class FakeElement {
	public readonly classList = new FakeClassList();
}

test("mountStealthShell hides loading indicator after the first frame", () => {
	const canvas = new FakeCanvas();
	const loadingIndicator = new FakeElement();
	let onFrame: ((payload: StealthFramePayload) => void) | null = null;
	let notifiedReady = false;
	let heartbeatCount = 0;
	let intervalCallback: (() => void) | null = null;

	const originalCanvas = globalThis.HTMLCanvasElement;
	const originalImage = globalThis.Image;
	const originalWindow = globalThis.window;
	const originalSetInterval = globalThis.setInterval;

	class FakeImage {
		public onload: (() => void) | null = null;

		set src(_value: string) {
			this.onload?.();
		}
	}

	Object.assign(globalThis, {
		HTMLCanvasElement: FakeCanvas,
		Image: FakeImage,
		window: { addEventListener() {} },
		setInterval(callback: () => void) {
			intervalCallback = callback;
			return { unref() {} } as unknown as ReturnType<typeof setInterval>;
		},
	});

	try {
		mountStealthShell(
			{
				onFrame(callback) {
					onFrame = callback;
					return () => {};
				},
				sendInputEvent() {},
				notifyReady() {
					notifiedReady = true;
				},
				notifyHeartbeat() {
					heartbeatCount += 1;
				},
			},
			{
				getElementById(id: string) {
					if (id === "stealth-shell-canvas") {
						return canvas as unknown as HTMLElement;
					}

					if (id === "loading-indicator") {
						return loadingIndicator as unknown as HTMLElement;
					}

					return null;
				},
			} as Document,
		);

		assert.equal(notifiedReady, true);
		assert.equal(heartbeatCount, 1);
		assert.ok(onFrame);

		intervalCallback?.();
		assert.equal(heartbeatCount, 2);

		onFrame({
			dataUrl: "data:image/png;base64,ZmFrZQ==",
			width: 120,
			height: 80,
			scaleFactor: 1,
			dirtyRects: [],
		});

		assert.equal(canvas.width, 120);
		assert.equal(canvas.height, 80);
		assert.equal(canvas.getDrawCalls(), 1);
		assert.equal(loadingIndicator.classList.contains("hidden"), true);
	} finally {
		Object.assign(globalThis, {
			HTMLCanvasElement: originalCanvas,
			Image: originalImage,
			window: originalWindow,
			setInterval: originalSetInterval,
		});
	}
});
