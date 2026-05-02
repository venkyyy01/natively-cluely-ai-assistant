import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import type { AppState } from "../main";
import type { SafeHandle, SafeHandleValidated } from "./registerTypes";

type RegisterWindowHandlersDeps = {
	appState: AppState;
	safeHandle: SafeHandle;
	safeHandleValidated: SafeHandleValidated;
};

type WindowFacadeLike = {
	updateContentDimensions: (
		senderWebContentsId: number,
		width: number,
		height: number,
	) => void;
	setWindowMode: (mode: "launcher" | "overlay") => void;
	setOverlayClickthrough: (enabled: boolean) => void;
	toggleMainWindow: () => void;
	showMainWindow: () => void;
	hideMainWindow: () => void;
	moveWindowLeft: () => void;
	moveWindowRight: () => void;
	moveWindowUp: () => void;
	moveWindowDown: () => void;
	centerAndShowWindow: () => void;
};

const ok = <T>(data: T) => ({ success: true as const, data });

function getWindowFacade(appState: AppState): WindowFacadeLike | null {
	if (
		"getWindowFacade" in appState &&
		typeof appState.getWindowFacade === "function"
	) {
		return appState.getWindowFacade() as WindowFacadeLike;
	}

	return null;
}

export function registerWindowHandlers({
	appState,
	safeHandle,
	safeHandleValidated,
}: RegisterWindowHandlersDeps): void {
	safeHandleValidated(
		"update-content-dimensions",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.contentDimensions,
					args[0],
					"update-content-dimensions",
				),
			] as const,
		async (event, { width, height }) => {
			if (!width || !height) return;

			const windowFacade = getWindowFacade(appState);
			if (windowFacade) {
				windowFacade.updateContentDimensions(event.sender.id, width, height);
				return;
			}

			const senderWebContents = event.sender;
			const settingsWin = appState.settingsWindowHelper.getSettingsWindow();
			const overlayWin = appState.getWindowHelper().getOverlayWindow();
			const launcherWin = appState.getWindowHelper().getLauncherContentWindow();

			if (
				settingsWin &&
				!settingsWin.isDestroyed() &&
				settingsWin.webContents.id === senderWebContents.id
			) {
				appState.settingsWindowHelper.setWindowDimensions(
					settingsWin,
					width,
					height,
				);
			} else if (
				overlayWin &&
				!overlayWin.isDestroyed() &&
				overlayWin.webContents.id === senderWebContents.id
			) {
				appState.getWindowHelper().setOverlayDimensions(width, height);
			} else if (
				launcherWin &&
				!launcherWin.isDestroyed() &&
				launcherWin.webContents.id === senderWebContents.id
			) {
				// No-op for launcher requests; launcher content is fixed-size.
			}
		},
	);

	safeHandleValidated(
		"set-window-mode",
		(args) =>
			[
				parseIpcInput(ipcSchemas.windowMode, args[0], "set-window-mode"),
			] as const,
		async (_event, mode) => {
			const windowFacade = getWindowFacade(appState);
			if (windowFacade) {
				windowFacade.setWindowMode(mode);
			} else {
				appState.getWindowHelper().setWindowMode(mode);
			}
			return { success: true };
		},
	);

	safeHandleValidated(
		"set-overlay-clickthrough",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.booleanFlag,
					args[0],
					"set-overlay-clickthrough",
				),
			] as const,
		async (_event, enabled) => {
			const windowFacade = getWindowFacade(appState);
			if (windowFacade) {
				windowFacade.setOverlayClickthrough(enabled);
			} else {
				appState.getWindowHelper().setOverlayClickthrough(enabled);
			}
			return ok({ enabled });
		},
	);

	safeHandle("toggle-window", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.toggleMainWindow();
		} else {
			appState.toggleMainWindow();
		}
		return ok(null);
	});

	safeHandle("show-window", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.showMainWindow();
		} else {
			appState.showMainWindow();
		}
		return ok(null);
	});

	safeHandle("hide-window", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.hideMainWindow();
		} else {
			appState.hideMainWindow();
		}
		return ok(null);
	});

	safeHandle("move-window-left", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.moveWindowLeft();
		} else {
			appState.moveWindowLeft();
		}
		return ok(null);
	});

	safeHandle("move-window-right", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.moveWindowRight();
		} else {
			appState.moveWindowRight();
		}
		return ok(null);
	});

	safeHandle("move-window-up", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.moveWindowUp();
		} else {
			appState.moveWindowUp();
		}
		return ok(null);
	});

	safeHandle("move-window-down", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.moveWindowDown();
		} else {
			appState.moveWindowDown();
		}
		return ok(null);
	});

	safeHandle("center-and-show-window", async () => {
		const windowFacade = getWindowFacade(appState);
		if (windowFacade) {
			windowFacade.centerAndShowWindow();
		} else {
			appState.centerAndShowWindow();
		}
		return ok(null);
	});
}
