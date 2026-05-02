import type { StealthWindowRole } from "./StealthManager";

export type DisplayBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};
export type DisplayInfo = { id: number; workArea: DisplayBounds };
export type DisplayEventSource = {
	on: (event: string, listener: () => void) => void;
};
export type ScreenApi = DisplayEventSource & {
	getAllDisplays: () => DisplayInfo[];
};

export interface StealthManagerDependencies {
	platform?: string;
	logger?: Pick<Console, "log" | "warn" | "error">;
	powerMonitor?: { on: (event: string, listener: () => void) => void } | null;
	screenApi?: ScreenApi | null;
	displayEvents?: DisplayEventSource | null;
	featureFlags?: import("./StealthManager").StealthFeatureFlags;
	intervalScheduler?: (
		callback: () => Promise<void> | void,
		intervalMs: number,
	) => unknown;
	clearIntervalScheduler?: (handle: unknown) => void;
	timeoutScheduler?: (callback: () => void, delayMs: number) => unknown;
	virtualDisplayCoordinator?:
		| import("./MacosVirtualDisplayClient").VirtualDisplayCoordinator
		| null;
	captureToolPatterns?: RegExp[];
	protectionStateMachine?: import("./ProtectionStateMachine").ProtectionStateMachine;
	visibilityController?: import("./VisibilityController").VisibilityController;
	nativeModule?: import("./StealthManager").NativeStealthBindings | null;
	/** Optional execFile for python fallback path (testing only). */
	execFileFn?: (
		file: string,
		args: readonly string[],
		options: { timeout?: number },
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => void;
}

export interface StealthCapableWindow {
	on?: (event: string, listener: () => void) => void;
	setContentProtection: (value: boolean) => void;
	setExcludeFromCapture?: (value: boolean) => void;
	setHiddenInMissionControl?: (value: boolean) => void;
	setExcludedFromShownWindowsMenu?: (value: boolean) => void;
	setSkipTaskbar?: (value: boolean) => void;
	setOpacity?: (value: number) => void;
	setBounds?: (bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => void;
	hide?: () => void;
	show?: () => void;
	getNativeWindowHandle?: () => Buffer;
	getMediaSourceId?: () => string;
	getBounds?: () => { x: number; y: number; width: number; height: number };
	isVisible?: () => boolean;
	isDestroyed?: () => boolean;
}

export interface ManagedWindowRecord {
	win: StealthCapableWindow;
	role: StealthWindowRole;
	hideFromSwitcher: boolean;
	allowVirtualDisplayIsolation: boolean;
	listenersAttached: boolean;
	virtualDisplayRequestId: number;
	virtualDisplayIsolationStarted: boolean;
	privateMacosStealthApplied: boolean;
}
