// ipcHandlers.ts

import * as path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { DatabaseManager } from "./db/DatabaseManager"; // Import Database Manager
import { createHandlerContext } from "./ipc/handlerContext";
import { registerCalendarHandlers } from "./ipc/registerCalendarHandlers";
import { registerEmailHandlers } from "./ipc/registerEmailHandlers";
import { registerGeminiStreamIpcHandlers } from "./ipc/registerGeminiStreamIpcHandlers";
import { registerIntelligenceHandlers } from "./ipc/registerIntelligenceHandlers";
import { registerLlmCredentialsIpcHandlers } from "./ipc/registerLlmCredentialsIpcHandlers";
import { registerMeetingHandlers } from "./ipc/registerMeetingHandlers";
import { registerProfileHandlers } from "./ipc/registerProfileHandlers";
import { registerProviderSttAndTestIpcHandlers } from "./ipc/registerProviderSttAndTestIpcHandlers";
import { registerRagHandlers } from "./ipc/registerRagHandlers";
import { registerSettingsHandlers } from "./ipc/registerSettingsHandlers";
import { registerWindowHandlers } from "./ipc/registerWindowHandlers";
import { ipcSchemas, parseIpcInput } from "./ipcValidation";
import type { AppState } from "./main";

export function initializeIpcHandlers(appState: AppState): void {
	const {
		safeHandle,
		safeHandleValidated,
		ok,
		fail,
		getInferenceLlmHelper,
		getSttSupervisor,
		getWindowFacade,
		getSettingsFacade,
		getAudioFacade,
		getIntelligenceManager,
		initializeInferenceLLMs,
		getScreenshotFacade,
		activeChatControllers,
		streamChatStartedAt,
	} = createHandlerContext(appState);

	safeHandleValidated(
		"renderer:log-error",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.rendererLogPayload,
					args[0],
					"renderer:log-error",
				),
			] as const,
		async (_, payload) => {
			try {
				console.error("[RendererError]", JSON.stringify(payload));
				return { success: true };
			} catch (err: any) {
				console.error("[RendererError] Failed to log payload:", err);
				return {
					success: false,
					error: err?.message || "Failed to log renderer error",
				};
			}
		},
	);

	safeHandle("license:activate", async (_event, _key: string) => {
		return { success: true };
	});
	safeHandle("license:check-premium", async () => {
		return true;
	});
	safeHandle("license:deactivate", async () => {
		return { success: true };
	});
	safeHandle("license:get-hardware-id", async () => {
		return "open-build";
	});

	registerSettingsHandlers({ appState, safeHandle, safeHandleValidated });
	registerCalendarHandlers({ appState, safeHandle, safeHandleValidated });
	registerEmailHandlers({ appState, safeHandleValidated });
	registerRagHandlers({ appState, safeHandle, safeHandleValidated });
	registerProfileHandlers({ appState, safeHandle, safeHandleValidated });
	registerIntelligenceHandlers({ appState, safeHandle, safeHandleValidated });
	registerWindowHandlers({ appState, safeHandle, safeHandleValidated });

	registerGeminiStreamIpcHandlers({
		safeHandle,
		safeHandleValidated,
		getInferenceLlmHelper,
		getIntelligenceManager,
		activeChatControllers,
		streamChatStartedAt,
		appState,
	});

	safeHandleValidated(
		"delete-screenshot",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.absoluteUserDataPath,
					args[0],
					"delete-screenshot",
				),
			] as const,
		async (_event, filePath) => {
			// Guard: only allow deletion of files within the app's own userData directory
			const userDataDir = app.getPath("userData");
			const resolved = path.resolve(filePath);
			if (!resolved.startsWith(userDataDir + path.sep)) {
				console.warn(
					"[IPC] delete-screenshot: path outside userData rejected:",
					filePath,
				);
				return { success: false, error: "Path not allowed" };
			}
			const screenshotFacade = getScreenshotFacade();
			if (screenshotFacade?.deleteScreenshot) {
				return screenshotFacade.deleteScreenshot(resolved);
			}
			return appState.deleteScreenshot(resolved);
		},
	);

	safeHandle("take-screenshot", async () => {
		try {
			const screenshotFacade = getScreenshotFacade();
			const screenshotPath = screenshotFacade?.takeScreenshot
				? await screenshotFacade.takeScreenshot()
				: await appState.takeScreenshot();
			const preview = screenshotFacade?.getImagePreview
				? await screenshotFacade.getImagePreview(screenshotPath)
				: await appState.getImagePreview(screenshotPath);
			return ok({ path: screenshotPath, preview });
		} catch (error) {
			return fail(
				"SCREENSHOT_CAPTURE_FAILED",
				error,
				"Failed to take screenshot",
			);
		}
	});

	safeHandle("take-selective-screenshot", async () => {
		try {
			const screenshotFacade = getScreenshotFacade();
			const screenshotPath = screenshotFacade?.takeSelectiveScreenshot
				? await screenshotFacade.takeSelectiveScreenshot()
				: await appState.takeSelectiveScreenshot();
			const preview = screenshotFacade?.getImagePreview
				? await screenshotFacade.getImagePreview(screenshotPath)
				: await appState.getImagePreview(screenshotPath);
			return ok({ path: screenshotPath, preview });
		} catch (error: any) {
			if (error?.message === "Selection cancelled") {
				return ok({ cancelled: true });
			}
			return fail(
				"SELECTIVE_SCREENSHOT_FAILED",
				error,
				"Failed to take selective screenshot",
			);
		}
	});

	safeHandle("get-screenshots", async () => {
		// console.log({ view: appState.getView() })
		try {
			const screenshotFacade = getScreenshotFacade();
			const view = screenshotFacade?.getView
				? screenshotFacade.getView()
				: appState.getView();
			const getPreview = screenshotFacade?.getImagePreview
				? (filePath: string) => screenshotFacade.getImagePreview?.(filePath)
				: (filePath: string) => appState.getImagePreview(filePath);
			let previews: Array<{ path: string; preview: string }> = [];
			if (view === "queue") {
				const screenshotQueue = screenshotFacade?.getScreenshotQueue
					? screenshotFacade.getScreenshotQueue()
					: appState.getScreenshotQueue();
				previews = await Promise.all(
					screenshotQueue.map(async (path) => ({
						path,
						preview: await getPreview(path),
					})),
				);
			} else {
				const extraScreenshotQueue = screenshotFacade?.getExtraScreenshotQueue
					? screenshotFacade.getExtraScreenshotQueue()
					: appState.getExtraScreenshotQueue();
				previews = await Promise.all(
					extraScreenshotQueue.map(async (path) => ({
						path,
						preview: await getPreview(path),
					})),
				);
			}
			// previews.forEach((preview: any) => console.log(preview.path))
			return ok(previews);
		} catch (error) {
			return fail(
				"SCREENSHOT_LIST_FAILED",
				error,
				"Failed to load screenshots",
			);
		}
	});

	safeHandle("reset-queues", async () => {
		try {
			const screenshotFacade = getScreenshotFacade();
			if (screenshotFacade?.clearQueues) {
				screenshotFacade.clearQueues();
			} else {
				appState.clearQueues();
			}
			// console.log("Screenshot queues have been cleared.")
			return { success: true };
		} catch (error: any) {
			// console.error("Error resetting queues:", error)
			return { success: false, error: error.message };
		}
	});

	// Donation IPC Handlers
	safeHandle("get-donation-status", async () => {
		const { DonationManager } = require("./DonationManager");
		const manager = DonationManager.getInstance();
		return {
			shouldShow: manager.shouldShowToaster(),
			hasDonated: manager.getDonationState().hasDonated,
			lifetimeShows: manager.getDonationState().lifetimeShows,
		};
	});

	safeHandle("mark-donation-toast-shown", async () => {
		const { DonationManager } = require("./DonationManager");
		DonationManager.getInstance().markAsShown();
		return { success: true };
	});

	safeHandle("set-donation-complete", async () => {
		const { DonationManager } = require("./DonationManager");
		DonationManager.getInstance().setHasDonated(true);
		return { success: true };
	});

	// Generate suggestion from transcript - Natively-style text-only reasoning
	safeHandleValidated(
		"generate-suggestion",
		(args) =>
			parseIpcInput(
				ipcSchemas.generateSuggestionArgs,
				args,
				"generate-suggestion",
			),
		async (_event, context, lastQuestion) => {
			try {
				const suggestion = await getInferenceLlmHelper().generateSuggestion(
					context,
					lastQuestion,
				);
				return ok({ suggestion });
			} catch (error: any) {
				return fail(
					"SUGGESTION_GENERATION_FAILED",
					error,
					"Failed to generate suggestion",
				);
			}
		},
	);

	safeHandle("finalize-mic-stt", async () => {
		const sttSupervisor = getSttSupervisor();
		if (sttSupervisor?.finalizeMicrophone) {
			await sttSupervisor.finalizeMicrophone();
		} else {
			appState.finalizeMicSTT();
		}
		return ok(null);
	});

	// IPC handler for analyzing image from file path
	safeHandleValidated(
		"analyze-image-file",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.absoluteUserDataPath,
					args[0],
					"analyze-image-file",
				),
			] as const,
		async (_event, filePath) => {
			// Guard: only allow reading files within the app's own userData directory
			const userDataDir = app.getPath("userData");
			const resolved = path.resolve(filePath);
			if (!resolved.startsWith(userDataDir + path.sep)) {
				console.warn(
					"[IPC] analyze-image-file: path outside userData rejected:",
					filePath,
				);
				return fail(
					"PATH_NOT_ALLOWED",
					new Error("Path not allowed"),
					"Path not allowed",
				);
			}
			try {
				const result = await getInferenceLlmHelper().analyzeImageFiles([
					resolved,
				]);
				return ok(result);
			} catch (error: any) {
				return fail(
					"IMAGE_ANALYSIS_FAILED",
					error,
					"Failed to analyze image file",
				);
			}
		},
	);

	safeHandle("quit-app", () => {
		app.quit();
		return ok(null);
	});

	safeHandleValidated(
		"delete-meeting",
		(args) =>
			[
				parseIpcInput(ipcSchemas.providerId, args[0], "delete-meeting"),
			] as const,
		async (_, id) => {
			return DatabaseManager.getInstance().deleteMeeting(id);
		},
	);

	registerLlmCredentialsIpcHandlers({
		safeHandle,
		safeHandleValidated,
		ok,
		fail,
		getInferenceLlmHelper,
		initializeInferenceLLMs,
	});

	registerProviderSttAndTestIpcHandlers({
		appState,
		safeHandle,
		safeHandleValidated,
		ok,
		fail,
		getInferenceLlmHelper,
		getSttSupervisor,
	});

	safeHandle("get-fast-response-config", () => {
		try {
			const llmHelper = getInferenceLlmHelper();
			return ok(llmHelper.getFastResponseConfig());
		} catch (error: any) {
			return fail(
				"FAST_RESPONSE_CONFIG_READ_FAILED",
				error,
				"Failed to get Fast Response config",
			);
		}
	});

	safeHandleValidated(
		"set-fast-response-config",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.fastResponseConfig,
					args[0],
					"set-fast-response-config",
				),
			] as const,
		(_, config) => {
			try {
				const { CredentialsManager } = require("./services/CredentialsManager");
				const llmHelper = getInferenceLlmHelper();
				llmHelper.setFastResponseConfig(config as any);
				CredentialsManager.getInstance().setFastResponseConfig(config as any);

				BrowserWindow.getAllWindows().forEach((win) => {
					if (!win.isDestroyed()) {
						win.webContents.send(
							"fast-response-config-changed",
							llmHelper.getFastResponseConfig(),
						);
					}
				});

				return { success: true };
			} catch (error: any) {
				return fail("IPC_ERROR", error, "Operation failed");
			}
		},
	);

	safeHandleValidated(
		"set-model",
		(args) =>
			[parseIpcInput(ipcSchemas.modelId, args[0], "set-model")] as const,
		async (_, modelId) => {
			try {
				const llmHelper = getInferenceLlmHelper();
				const { CredentialsManager } = require("./services/CredentialsManager");
				const cm = CredentialsManager.getInstance();

				// Get all providers (Curl + Custom)
				const curlProviders = cm.getCurlProviders();
				const legacyProviders = cm.getCustomProviders() || [];
				const allProviders = [...curlProviders, ...legacyProviders];

				appState
					.getIntelligenceManager()
					.cancelActiveWhatToSay?.("model_changed");
				llmHelper.setModel(modelId, allProviders);

				// Close the selector window if open
				const windowFacade = getWindowFacade();
				if (windowFacade?.hideModelSelectorWindow) {
					windowFacade.hideModelSelectorWindow();
				} else {
					appState.modelSelectorWindowHelper.hideWindow();
				}

				// Broadcast to all windows so NativelyInterface can update its selector (session-only update)
				BrowserWindow.getAllWindows().forEach((win) => {
					if (!win.isDestroyed()) {
						win.webContents.send("model-changed", modelId);
					}
				});

				return { success: true };
			} catch (error: any) {
				console.error("Error setting model:", error);
				return fail("IPC_ERROR", error, "Operation failed");
			}
		},
	);

	// Persist default model (from Settings) + update runtime + broadcast to all windows
	safeHandleValidated(
		"set-default-model",
		(args) =>
			[
				parseIpcInput(ipcSchemas.modelId, args[0], "set-default-model"),
			] as const,
		async (_, modelId) => {
			try {
				const { CredentialsManager } = require("./services/CredentialsManager");
				const cm = CredentialsManager.getInstance();
				cm.setDefaultModel(modelId);

				// Also update the runtime model
				const llmHelper = getInferenceLlmHelper();
				const curlProviders = cm.getCurlProviders();
				const legacyProviders = cm.getCustomProviders() || [];
				const allProviders = [...curlProviders, ...legacyProviders];
				appState
					.getIntelligenceManager()
					.cancelActiveWhatToSay?.("default_model_changed");
				llmHelper.setModel(modelId, allProviders);

				// Close the selector window if open
				const windowFacade = getWindowFacade();
				if (windowFacade?.hideModelSelectorWindow) {
					windowFacade.hideModelSelectorWindow();
				} else {
					appState.modelSelectorWindowHelper.hideWindow();
				}

				// Broadcast to all windows so NativelyInterface can update its selector
				BrowserWindow.getAllWindows().forEach((win) => {
					if (!win.isDestroyed()) {
						win.webContents.send("model-changed", modelId);
					}
				});

				return { success: true };
			} catch (error: any) {
				console.error("Error setting default model:", error);
				return fail("IPC_ERROR", error, "Operation failed");
			}
		},
	);

	// Read the persisted default model
	safeHandle("get-default-model", async () => {
		try {
			const { CredentialsManager } = require("./services/CredentialsManager");
			const cm = CredentialsManager.getInstance();
			return ok({ model: cm.getDefaultModel() });
		} catch (error: any) {
			console.error("Error getting default model:", error);
			return fail(
				"DEFAULT_MODEL_READ_FAILED",
				error,
				"Failed to get default model",
			);
		}
	});

	// --- Model Selector Window IPC ---

	safeHandleValidated(
		"show-model-selector",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.modelSelectorCoords,
					args[0],
					"show-model-selector",
				),
			] as const,
		(_, coords) => {
			const windowFacade = getWindowFacade();
			if (windowFacade?.showModelSelectorWindow) {
				windowFacade.showModelSelectorWindow(coords.x, coords.y);
			} else {
				appState.modelSelectorWindowHelper.showWindow(coords.x, coords.y);
			}
		},
	);

	safeHandle("hide-model-selector", () => {
		const windowFacade = getWindowFacade();
		if (windowFacade?.hideModelSelectorWindow) {
			windowFacade.hideModelSelectorWindow();
		} else {
			appState.modelSelectorWindowHelper.hideWindow();
		}
		return ok(null);
	});

	safeHandleValidated(
		"toggle-model-selector",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.modelSelectorCoords,
					args[0],
					"toggle-model-selector",
				),
			] as const,
		(_, coords) => {
			const windowFacade = getWindowFacade();
			if (windowFacade?.toggleModelSelectorWindow) {
				windowFacade.toggleModelSelectorWindow(coords.x, coords.y);
			} else {
				appState.modelSelectorWindowHelper.toggleWindow(coords.x, coords.y);
			}
		},
	);

	// Native Audio Service Handlers
	safeHandle("native-audio-status", async () => {
		try {
			const audioFacade = getAudioFacade();
			return ok(
				audioFacade?.getNativeAudioStatus
					? audioFacade.getNativeAudioStatus()
					: appState.getNativeAudioStatus(),
			);
		} catch (error) {
			return fail(
				"NATIVE_AUDIO_STATUS_FAILED",
				error,
				"Failed to get native audio status",
			);
		}
	});
	registerMeetingHandlers({ appState, safeHandle, safeHandleValidated });

	// Service Account Selection
	safeHandle("select-service-account", async () => {
		try {
			const result: any = await dialog.showOpenDialog({
				properties: ["openFile"],
				filters: [{ name: "JSON", extensions: ["json"] }],
			});

			if (result.canceled || result.filePaths.length === 0) {
				return ok({ cancelled: true });
			}

			const filePath = result.filePaths[0];

			// Update backend state immediately
			const sttSupervisor = getSttSupervisor();
			if (sttSupervisor?.updateGoogleCredentials) {
				await sttSupervisor.updateGoogleCredentials(filePath);
			} else {
				appState.updateGoogleCredentials(filePath);
			}

			// Persist the path for future sessions
			const { CredentialsManager } = require("./services/CredentialsManager");
			CredentialsManager.getInstance().setGoogleServiceAccountPath(filePath);

			return ok({ path: filePath });
		} catch (error: any) {
			console.error("Error selecting service account:", error);
			return fail(
				"SERVICE_ACCOUNT_SELECTION_FAILED",
				error,
				"Failed to select service account",
			);
		}
	});

	// ==========================================
	// Theme System Handlers
	// ==========================================

	safeHandle("theme:get-mode", () => {
		try {
			const settingsFacade = getSettingsFacade();
			const mode = settingsFacade?.getThemeMode
				? settingsFacade.getThemeMode()
				: appState.getThemeManager().getMode();
			const resolved = settingsFacade?.getResolvedTheme
				? settingsFacade.getResolvedTheme()
				: appState.getThemeManager().getResolvedTheme();
			return ok({
				mode,
				resolved,
			});
		} catch (error) {
			return fail("THEME_MODE_READ_FAILED", error, "Failed to get theme mode");
		}
	});

	safeHandleValidated(
		"theme:set-mode",
		(args) =>
			[parseIpcInput(ipcSchemas.themeMode, args[0], "theme:set-mode")] as const,
		(_, mode) => {
			const settingsFacade = getSettingsFacade();
			if (settingsFacade?.setThemeMode) {
				settingsFacade.setThemeMode(mode);
			} else {
				appState.getThemeManager().setMode(mode);
			}
			return { success: true };
		},
	);

	// ==========================================
	// Overlay Opacity (Stealth Mode)
	// ==========================================

	safeHandleValidated(
		"set-overlay-opacity",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.overlayOpacity,
					args[0],
					"set-overlay-opacity",
				),
			] as const,
		async (_, opacity) => {
			// Clamp to valid range
			const clamped = Math.min(1.0, Math.max(0.15, opacity));
			// Broadcast to all renderer windows so the overlay picks it up in real-time
			BrowserWindow.getAllWindows().forEach((win) => {
				if (!win.isDestroyed()) {
					win.webContents.send("overlay-opacity-changed", clamped);
				}
			});
			return ok({ opacity: clamped });
		},
	);
}
