import { app } from "electron";
import {
	AI_RESPONSE_LANGUAGES,
	RECOGNITION_LANGUAGES,
} from "../config/languages";
import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import type { AppState } from "../main";
import type { SafeHandle, SafeHandleValidated } from "./registerTypes";

type RegisterSettingsHandlersDeps = {
	appState: AppState;
	safeHandle: SafeHandle;
	safeHandleValidated: SafeHandleValidated;
};

type WindowFacadeLike = {
	toggleSettingsWindow?: (x?: number, y?: number) => void;
	closeSettingsWindow?: () => void;
};

type SettingsFacadeLike = {
	setConsciousModeEnabled?: (enabled: boolean) => boolean;
	getConsciousModeEnabled?: () => boolean;
	setAccelerationModeEnabled?: (enabled: boolean) => boolean;
	getAccelerationModeEnabled?: () => boolean;
	setDeepModeEnabled?: (enabled: boolean) => boolean;
	getDeepModeEnabled?: () => boolean;
	setDisguise?: (mode: "terminal" | "settings" | "activity" | "none") => void;
	getDisguise?: () => string;
	getUndetectable?: () => boolean;
};

type RuntimeCoordinatorLike = {
	getSupervisor?: (name: string) => unknown;
};

type InferenceSupervisorLike = {
	getLLMHelper?: () => {
		setAiResponseLanguage?: (language: string) => void;
	} | null;
};

type SettingsIpcSuccess<T> = {
	success: true;
	data: T;
};

type SettingsIpcFailure = {
	success: false;
	error: {
		code: string;
		message: string;
	};
};

function settingsError(code: string, message: string): SettingsIpcFailure {
	return {
		success: false,
		error: {
			code,
			message,
		},
	};
}

function settingsSuccess<T>(data: T): SettingsIpcSuccess<T> {
	return {
		success: true,
		data,
	};
}

function getRuntimeCoordinator(
	appState: AppState,
): RuntimeCoordinatorLike | null {
	if (
		!("getCoordinator" in appState) ||
		typeof appState.getCoordinator !== "function"
	) {
		return null;
	}

	return appState.getCoordinator() as RuntimeCoordinatorLike;
}

function getWindowFacade(appState: AppState): WindowFacadeLike | null {
	if (
		"getWindowFacade" in appState &&
		typeof appState.getWindowFacade === "function"
	) {
		return appState.getWindowFacade() as WindowFacadeLike;
	}

	return null;
}

function getSettingsFacade(appState: AppState): SettingsFacadeLike | null {
	if (
		"getSettingsFacade" in appState &&
		typeof appState.getSettingsFacade === "function"
	) {
		return appState.getSettingsFacade() as SettingsFacadeLike;
	}

	return null;
}

function getInferenceLlmHelper(appState: AppState): {
	setAiResponseLanguage?: (language: string) => void;
} | null {
	const coordinator = getRuntimeCoordinator(appState);
	if (typeof coordinator?.getSupervisor === "function") {
		const supervisor = coordinator.getSupervisor(
			"inference",
		) as InferenceSupervisorLike;
		const llmHelper = supervisor?.getLLMHelper?.();
		if (llmHelper) {
			return llmHelper;
		}
	}

	return appState.processingHelper?.getLLMHelper?.() ?? null;
}

export function registerSettingsHandlers({
	appState,
	safeHandle,
	safeHandleValidated,
}: RegisterSettingsHandlersDeps): void {
	safeHandle("get-recognition-languages", async () =>
		settingsSuccess(RECOGNITION_LANGUAGES),
	);
	safeHandle("get-ai-response-languages", async () =>
		settingsSuccess(AI_RESPONSE_LANGUAGES),
	);

	safeHandleValidated(
		"set-ai-response-language",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.aiResponseLanguage,
					args[0],
					"set-ai-response-language",
				),
			] as const,
		async (_event, language) => {
			try {
				const {
					CredentialsManager,
				} = require("../services/CredentialsManager");
				CredentialsManager.getInstance().setAiResponseLanguage(language);
				getInferenceLlmHelper(appState)?.setAiResponseLanguage?.(language);
				return settingsSuccess({ language });
			} catch (error: any) {
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to update AI response language",
				);
			}
		},
	);

	safeHandle("get-stt-language", async () => {
		try {
			const { CredentialsManager } = require("../services/CredentialsManager");
			return settingsSuccess({
				language: CredentialsManager.getInstance().getSttLanguage(),
			});
		} catch (error: any) {
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read STT language",
			);
		}
	});

	safeHandle("get-ai-response-language", async () => {
		try {
			const { CredentialsManager } = require("../services/CredentialsManager");
			return settingsSuccess({
				language: CredentialsManager.getInstance().getAiResponseLanguage(),
			});
		} catch (error: any) {
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read AI response language",
			);
		}
	});

	safeHandleValidated(
		"toggle-settings-window",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.settingsWindowCoords,
					args[0] || {},
					"toggle-settings-window",
				),
			] as const,
		(_event, { x, y }) => {
			try {
				const windowFacade = getWindowFacade(appState);
				if (windowFacade?.toggleSettingsWindow) {
					windowFacade.toggleSettingsWindow(x, y);
				} else {
					appState.settingsWindowHelper.toggleWindow(x, y);
				}
				return settingsSuccess(null);
			} catch (error: any) {
				return settingsError(
					"SETTINGS_WINDOW_TOGGLE_FAILED",
					error?.message || "Unable to toggle settings window",
				);
			}
		},
	);

	safeHandle("close-settings-window", () => {
		try {
			const windowFacade = getWindowFacade(appState);
			if (windowFacade?.closeSettingsWindow) {
				windowFacade.closeSettingsWindow();
			} else {
				appState.settingsWindowHelper.closeWindow();
			}
			return settingsSuccess(null);
		} catch (error: any) {
			return settingsError(
				"SETTINGS_WINDOW_CLOSE_FAILED",
				error?.message || "Unable to close settings window",
			);
		}
	});

	safeHandleValidated(
		"set-undetectable",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "set-undetectable"),
			] as const,
		async (_event, state) => {
			try {
				if (
					"setUndetectableAsync" in appState &&
					typeof appState.setUndetectableAsync === "function"
				) {
					await appState.setUndetectableAsync(state);
				} else {
					appState.setUndetectable(state);
				}
				return settingsSuccess({ enabled: state });
			} catch (error: any) {
				console.error("Error setting undetectable state:", error);
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to update stealth mode",
				);
			}
		},
	);

	safeHandleValidated(
		"set-conscious-mode",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "set-conscious-mode"),
			] as const,
		async (_event, enabled) => {
			try {
				const settingsFacade = getSettingsFacade(appState);
				const result = settingsFacade?.setConsciousModeEnabled
					? settingsFacade.setConsciousModeEnabled(enabled)
					: appState.setConsciousModeEnabled(enabled);
				if (result === false) {
					return settingsError(
						"SETTINGS_PERSIST_FAILED",
						"Unable to persist Conscious Mode",
					);
				}

				return settingsSuccess({ enabled });
			} catch (error: any) {
				console.error("Error setting Conscious Mode state:", error);
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to persist Conscious Mode",
				);
			}
		},
	);

	safeHandle("get-conscious-mode", async () => {
		try {
			const settingsFacade = getSettingsFacade(appState);
			const enabled = settingsFacade?.getConsciousModeEnabled
				? settingsFacade.getConsciousModeEnabled()
				: appState.getConsciousModeEnabled();
			return settingsSuccess({ enabled });
		} catch (error: any) {
			console.error("Error getting Conscious Mode state:", error);
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read Conscious Mode",
			);
		}
	});

	safeHandle("get-privacy-shield-state", async () => {
		try {
			return settingsSuccess(appState.getPrivacyShieldState());
		} catch (error: any) {
			console.error("Error getting privacy shield state:", error);
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read Privacy Shield state",
			);
		}
	});

	safeHandleValidated(
		"set-acceleration-mode",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "set-acceleration-mode"),
			] as const,
		async (_event, enabled) => {
			try {
				const settingsFacade = getSettingsFacade(appState);
				const result = settingsFacade?.setAccelerationModeEnabled
					? settingsFacade.setAccelerationModeEnabled(enabled)
					: appState.setAccelerationModeEnabled(enabled);
				if (result === false) {
					return settingsError(
						"SETTINGS_PERSIST_FAILED",
						"Unable to persist Acceleration Mode",
					);
				}

				return settingsSuccess({ enabled });
			} catch (error: any) {
				console.error("Error setting Acceleration Mode state:", error);
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to persist Acceleration Mode",
				);
			}
		},
	);

	safeHandle("get-acceleration-mode", async () => {
		try {
			const settingsFacade = getSettingsFacade(appState);
			const enabled = settingsFacade?.getAccelerationModeEnabled
				? settingsFacade.getAccelerationModeEnabled()
				: appState.getAccelerationModeEnabled();
			return settingsSuccess({ enabled });
		} catch (error: any) {
			console.error("Error getting Acceleration Mode state:", error);
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read Acceleration Mode",
			);
		}
	});

	safeHandleValidated(
		"set-deep-mode",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "set-deep-mode"),
			] as const,
		async (_event, enabled) => {
			try {
				const settingsFacade = getSettingsFacade(appState);
				const result = settingsFacade?.setDeepModeEnabled
					? settingsFacade.setDeepModeEnabled(enabled)
					: appState.setDeepModeEnabled(enabled);
				if (result === false) {
					return settingsError(
						"SETTINGS_PERSIST_FAILED",
						"Unable to persist Deep Mode",
					);
				}

				return settingsSuccess({ enabled });
			} catch (error: any) {
				console.error("Error setting Deep Mode state:", error);
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to persist Deep Mode",
				);
			}
		},
	);

	safeHandle("get-deep-mode", async () => {
		try {
			const settingsFacade = getSettingsFacade(appState);
			const enabled = settingsFacade?.getDeepModeEnabled
				? settingsFacade.getDeepModeEnabled()
				: appState.getDeepModeEnabled();
			return settingsSuccess({ enabled });
		} catch (error: any) {
			console.error("Error getting Deep Mode state:", error);
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read Deep Mode",
			);
		}
	});

	safeHandleValidated(
		"set-disguise",
		(args) =>
			[
				parseIpcInput(ipcSchemas.disguiseMode, args[0], "set-disguise"),
			] as const,
		async (_event, mode) => {
			try {
				const settingsFacade = getSettingsFacade(appState);
				if (settingsFacade?.setDisguise) {
					settingsFacade.setDisguise(mode);
				} else {
					appState.setDisguise(mode);
				}
				return settingsSuccess({ mode });
			} catch (error: any) {
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to update disguise mode",
				);
			}
		},
	);

	safeHandle("get-undetectable", async () => {
		try {
			const settingsFacade = getSettingsFacade(appState);
			const enabled = settingsFacade?.getUndetectable
				? settingsFacade.getUndetectable()
				: appState.getUndetectable();
			return settingsSuccess({ enabled });
		} catch (error: any) {
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read stealth mode",
			);
		}
	});

	safeHandle("get-disguise", async () => {
		try {
			const settingsFacade = getSettingsFacade(appState);
			const mode = settingsFacade?.getDisguise
				? settingsFacade.getDisguise()
				: appState.getDisguise();
			return settingsSuccess({ mode });
		} catch (error: any) {
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read disguise mode",
			);
		}
	});

	safeHandleValidated(
		"set-open-at-login",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "set-open-at-login"),
			] as const,
		async (_event, openAtLogin) => {
			try {
				app.setLoginItemSettings({
					openAtLogin,
					openAsHidden: false,
					path: app.getPath("exe"),
				});
				return settingsSuccess({ enabled: openAtLogin });
			} catch (error: any) {
				console.error("Error setting open-at-login:", error);
				return settingsError(
					"SETTINGS_PERSIST_FAILED",
					error?.message || "Unable to update login preference",
				);
			}
		},
	);

	safeHandle("get-open-at-login", async () => {
		try {
			return settingsSuccess({
				enabled: app.getLoginItemSettings().openAtLogin,
			});
		} catch (error: any) {
			return settingsError(
				"SETTINGS_READ_FAILED",
				error?.message || "Unable to read login preference",
			);
		}
	});
}
