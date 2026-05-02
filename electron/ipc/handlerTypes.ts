export type ScreenshotFacadeLike = {
	deleteScreenshot?: (
		path: string,
	) => Promise<{ success: boolean; error?: string }>;
	takeScreenshot?: () => Promise<string>;
	takeSelectiveScreenshot?: () => Promise<string>;
	getImagePreview?: (filepath: string) => Promise<string>;
	getView?: () => "queue" | "solutions";
	getScreenshotQueue?: () => string[];
	getExtraScreenshotQueue?: () => string[];
	clearQueues?: () => void;
};

export type RuntimeCoordinatorLike = {
	getSupervisor?: (name: string) => unknown;
};

export type SttSupervisorLike = {
	reconfigureProvider?: () => Promise<void> | void;
	updateGoogleCredentials?: (keyPath: string) => Promise<void> | void;
	finalizeMicrophone?: () => Promise<void> | void;
};

export type IntelligenceManagerLike = {
	addTranscript: (
		entry: { text: string; speaker: string; timestamp: number; final: boolean },
		skipRefinementCheck?: boolean,
	) => void;
	addAssistantMessage: (message: string) => void;
	getLastAssistantMessage: () => string | null;
	getFormattedContext: (lastSeconds?: number) => string;
	logUsage: (
		type: string,
		input: string,
		output: string,
		items?: Record<string, unknown>,
	) => void;
	isConsciousModeEnabled: () => boolean;
	initializeLLMs: () => void | Promise<void>;
};

export type InferenceSupervisorLike = {
	getLLMHelper?: () => unknown;
	getIntelligenceManager?: () => unknown;
	initializeLLMs?: () => Promise<void> | void;
};

export type WindowFacadeLike = {
	showModelSelectorWindow?: (x: number, y: number) => void;
	hideModelSelectorWindow?: () => void;
	toggleModelSelectorWindow?: (x: number, y: number) => void;
};

export type SettingsFacadeLike = {
	getThemeMode?: () => string;
	getResolvedTheme?: () => string;
	setThemeMode?: (mode: string) => void;
};

export type AudioFacadeLike = {
	getNativeAudioStatus?: () => unknown;
};
