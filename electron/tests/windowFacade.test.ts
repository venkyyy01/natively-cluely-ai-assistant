import assert from "node:assert/strict";
import test from "node:test";

import { WindowFacade } from "../runtime/WindowFacade";

test("WindowFacade routes content dimension updates by sender and delegates window controls", () => {
	const calls: string[] = [];
	const settingsWindow = { isDestroyed: () => false, webContents: { id: 101 } };
	const overlayWindow = { isDestroyed: () => false, webContents: { id: 202 } };
	const launcherWindow = { isDestroyed: () => false, webContents: { id: 303 } };

	const facade = new WindowFacade({
		getSettingsWindow: () => settingsWindow,
		setSettingsWindowDimensions: (
			_window: unknown,
			width: number,
			height: number,
		) => {
			calls.push(`settings:${width}x${height}`);
		},
		getOverlayWindow: () => overlayWindow,
		getLauncherContentWindow: () => launcherWindow,
		setOverlayDimensions: (width: number, height: number) => {
			calls.push(`overlay:${width}x${height}`);
		},
		setWindowMode: (mode: string) => {
			calls.push(`mode:${mode}`);
		},
		setOverlayClickthrough: (enabled: boolean) => {
			calls.push(`clickthrough:${enabled}`);
		},
		toggleMainWindow: () => {
			calls.push("toggle");
		},
		showMainWindow: () => {
			calls.push("show");
		},
		hideMainWindow: () => {
			calls.push("hide");
		},
		moveWindowLeft: () => {
			calls.push("left");
		},
		moveWindowRight: () => {
			calls.push("right");
		},
		moveWindowUp: () => {
			calls.push("up");
		},
		moveWindowDown: () => {
			calls.push("down");
		},
		centerAndShowWindow: () => {
			calls.push("center");
		},
		toggleSettingsWindow: (x?: number, y?: number) => {
			calls.push(`toggleSettings:${x ?? "none"},${y ?? "none"}`);
		},
		closeSettingsWindow: () => {
			calls.push("closeSettings");
		},
		showModelSelectorWindow: (x: number, y: number) => {
			calls.push(`showModelSelector:${x},${y}`);
		},
		hideModelSelectorWindow: () => {
			calls.push("hideModelSelector");
		},
		toggleModelSelectorWindow: (x: number, y: number) => {
			calls.push(`toggleModelSelector:${x},${y}`);
		},
	});

	facade.updateContentDimensions(101, 640, 480);
	facade.updateContentDimensions(202, 720, 360);
	facade.updateContentDimensions(303, 999, 999);
	facade.updateContentDimensions(404, 111, 222);
	facade.setWindowMode("overlay");
	facade.setOverlayClickthrough(true);
	facade.toggleMainWindow();
	facade.showMainWindow();
	facade.hideMainWindow();
	facade.moveWindowLeft();
	facade.moveWindowRight();
	facade.moveWindowUp();
	facade.moveWindowDown();
	facade.centerAndShowWindow();
	facade.toggleSettingsWindow(12, 34);
	facade.closeSettingsWindow();
	facade.showModelSelectorWindow(56, 78);
	facade.hideModelSelectorWindow();
	facade.toggleModelSelectorWindow(90, 12);

	assert.deepEqual(calls, [
		"settings:640x480",
		"overlay:720x360",
		"mode:overlay",
		"clickthrough:true",
		"toggle",
		"show",
		"hide",
		"left",
		"right",
		"up",
		"down",
		"center",
		"toggleSettings:12,34",
		"closeSettings",
		"showModelSelector:56,78",
		"hideModelSelector",
		"toggleModelSelector:90,12",
	]);
});
