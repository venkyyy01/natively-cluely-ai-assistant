import { contextBridge, ipcRenderer } from "electron";

import { mountStealthShell, type StealthShellBridge } from "../renderer/shell";
import type { StealthFramePayload, StealthInputEvent } from "./types";

const bridge: StealthShellBridge = {
	onFrame(callback) {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: StealthFramePayload,
		) => callback(payload);
		ipcRenderer.on("stealth-shell:frame", listener);
		return () => ipcRenderer.removeListener("stealth-shell:frame", listener);
	},
	sendInputEvent(event: StealthInputEvent) {
		ipcRenderer.send("stealth-shell:input", event);
	},
	notifyReady() {
		ipcRenderer.send("stealth-shell:ready");
	},
	notifyHeartbeat() {
		ipcRenderer.send("stealth-shell:heartbeat");
	},
};

contextBridge.exposeInMainWorld("stealthShell", bridge);

window.addEventListener("DOMContentLoaded", () => {
	mountStealthShell(bridge, document);
});
