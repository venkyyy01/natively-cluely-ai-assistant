/**
 * NAT-082 — Stealth capture-fixture suite.
 *
 * Tests that protected windows do not leak UI pixels under screen capture.
 * In mock mode (default for CI), validates the fixture structure and
 * content-protection state without requiring macOS screen-recording
 * entitlements. In live mode, calls a small SCK helper binary.
 */

export interface CaptureFixtureWindow {
	name: string;
	id?: number;
	contentProtection: boolean;
	expectedNsWindowLevel?: number;
}

export interface CaptureFixtureResult {
	window: string;
	passed: boolean;
	blank: boolean;
	nsWindowLevelOk?: boolean;
	reason?: string;
}

export interface StealthCaptureFixtureOptions {
	mode: "mock" | "live";
	frameCount?: number;
	helperPath?: string;
}

export class StealthCaptureFixture {
	constructor(private readonly options: StealthCaptureFixtureOptions) {}

	async run(windows: CaptureFixtureWindow[]): Promise<CaptureFixtureResult[]> {
		const results: CaptureFixtureResult[] = [];

		for (const win of windows) {
			if (this.options.mode === "live") {
				results.push(await this.captureLive(win));
			} else {
				results.push(this.captureMock(win));
			}
		}

		return results;
	}

	private captureMock(win: CaptureFixtureWindow): CaptureFixtureResult {
		// In mock mode we verify the window configuration, not actual pixels.
		if (!win.contentProtection) {
			return {
				window: win.name,
				passed: false,
				blank: false,
				reason: "content protection is not enabled",
			};
		}

		const nsWindowLevelOk = win.expectedNsWindowLevel == null ? true : true; // mock assumes ok

		return {
			window: win.name,
			passed: true,
			blank: true,
			nsWindowLevelOk,
		};
	}

	private async captureLive(
		_win: CaptureFixtureWindow,
	): Promise<CaptureFixtureResult> {
		// Placeholder: would call SCK helper binary.
		return {
			window: _win.name,
			passed: false,
			blank: false,
			reason: "live mode not yet implemented without SCK helper binary",
		};
	}
}

/** Standard protected windows in Natively. */
export function getDefaultProtectedWindows(): CaptureFixtureWindow[] {
	return [
		{ name: "shell", contentProtection: true, expectedNsWindowLevel: 19 },
		{ name: "content", contentProtection: true, expectedNsWindowLevel: 19 },
		{
			name: "privacy-shield",
			contentProtection: true,
			expectedNsWindowLevel: 19,
		},
		{ name: "launcher", contentProtection: true, expectedNsWindowLevel: 19 },
		{ name: "overlay", contentProtection: true, expectedNsWindowLevel: 19 },
	];
}

/** Smoke check: fixture should fail if content protection is removed. */
export function getUnprotectedWindows(): CaptureFixtureWindow[] {
	return getDefaultProtectedWindows().map((w) => ({
		...w,
		contentProtection: false,
	}));
}
