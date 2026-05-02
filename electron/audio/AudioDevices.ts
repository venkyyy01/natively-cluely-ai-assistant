import { getNativeAudioLoadError, loadNativeAudioModule } from "./nativeModule";

const NativeModule = loadNativeAudioModule();

if (!NativeModule) {
	console.error(
		"[AudioDevices] Failed to load native module:",
		getNativeAudioLoadError(),
	);
}

const { getInputDevices, getOutputDevices } = NativeModule || {};

export interface AudioDevice {
	id: string;
	name: string;
}

export const AudioDevices = {
	getInputDevices(): AudioDevice[] {
		if (!getInputDevices) {
			console.warn("[AudioDevices] Native functionality not available");
			return [];
		}
		try {
			return getInputDevices();
		} catch (e) {
			console.error("[AudioDevices] Failed to get input devices:", e);
			return [];
		}
	},

	getOutputDevices(): AudioDevice[] {
		if (!getOutputDevices) {
			console.warn("[AudioDevices] Native functionality not available");
			return [];
		}
		try {
			return getOutputDevices();
		} catch (e) {
			console.error("[AudioDevices] Failed to get output devices:", e);
			return [];
		}
	}
};
