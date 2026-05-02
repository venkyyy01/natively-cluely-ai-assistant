import type { BrowserWindow } from "electron";

/**
 * NAT-SELF-HEAL: Renderer bridge recovery helpers.
 * When the renderer bridge fails to settle (black screen), these helpers
 * force-reload the window or reveal it anyway after a safety timeout.
 */

const BRIDGE_SETTLE_TIMEOUT_MS = 5000;
const MAX_AUTO_RELOADS = 2;
const RELOAD_BACKOFF_MS = 800;

export type RevealRecoveryHandle = {
	cancel: () => void;
};

/**
 * Attach a safety net to a BrowserWindow that ensures the window is revealed
 * even if the renderer bridge monitor never fires `onSettled`.
 *
 * Returns a handle with `cancel()` — call this when the normal `onSettled`
 * path succeeds so the safety net doesn't fire.
 */
export function attachRevealSafetyNet(
	label: string,
	window: BrowserWindow,
	onForceReveal: () => void,
): RevealRecoveryHandle {
	let settled = false;
	let reloadAttempts = 0;

	const timer = setTimeout(() => {
		if (settled || window.isDestroyed()) {
			return;
		}

		console.warn(
			`[RevealSafetyNet] ${label} bridge did not settle within ${BRIDGE_SETTLE_TIMEOUT_MS}ms. Attempting recovery...`,
		);

		// First try: reload the window (can fix stale renderer state)
		if (reloadAttempts < MAX_AUTO_RELOADS && !window.isDestroyed()) {
			reloadAttempts += 1;
			console.log(
				`[RevealSafetyNet] ${label} auto-reload attempt ${reloadAttempts}/${MAX_AUTO_RELOADS}`,
			);
			try {
				window.webContents.reloadIgnoringCache();
				// Re-arm the timer for one more cycle after reload
				setTimeout(() => {
					if (!settled && !window.isDestroyed()) {
						console.warn(
							`[RevealSafetyNet] ${label} still not settled after reload. Forcing reveal.`,
						);
						onForceReveal();
					}
				}, BRIDGE_SETTLE_TIMEOUT_MS + RELOAD_BACKOFF_MS);
				return;
			} catch (reloadErr) {
				console.error(`[RevealSafetyNet] ${label} reload failed:`, reloadErr);
			}
		}

		// Final fallback: reveal anyway. The window may show unstyled content briefly,
		// but it's better than a permanent black screen.
		console.warn(`[RevealSafetyNet] ${label} forcing reveal as last resort.`);
		onForceReveal();
	}, BRIDGE_SETTLE_TIMEOUT_MS);

	return {
		cancel: () => {
			settled = true;
			clearTimeout(timer);
		},
	};
}

/**
 * Attach an auto-recreate handler for render-process-gone / crashed events.
 */
export function attachWindowCrashRecovery(
	label: string,
	window: BrowserWindow,
	onRecreate: () => void,
): () => void {
	const handleCrashed = (_event: Event, killed: boolean) => {
		console.error(
			`[WindowCrashRecovery] ${label} crashed (killed=${killed}). Recreating...`,
		);
		onRecreate();
	};

	const handleGone = (
		_event: Event,
		details: Electron.RenderProcessGoneDetails,
	) => {
		console.error(
			`[WindowCrashRecovery] ${label} render process gone: reason=${details.reason} exitCode=${details.exitCode}. Recreating...`,
		);
		onRecreate();
	};

	const crashEvents = window.webContents as unknown as {
		on(
			event: "crashed" | "render-process-gone",
			listener: (...args: any[]) => void,
		): void;
		removeListener(
			event: "crashed" | "render-process-gone",
			listener: (...args: any[]) => void,
		): void;
	};

	crashEvents.on("crashed", handleCrashed);
	crashEvents.on("render-process-gone", handleGone);

	return () => {
		if (!window.isDestroyed()) {
			crashEvents.removeListener("crashed", handleCrashed);
			crashEvents.removeListener("render-process-gone", handleGone);
		}
	};
}
