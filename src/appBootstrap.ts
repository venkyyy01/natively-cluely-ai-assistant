export type AppWindowKind =
	| "settings"
	| "launcher"
	| "overlay"
	| "model-selector";

export type AppWindowContext = {
	kind: AppWindowKind;
	isDefaultLauncherWindow: boolean;
};

export type WindowAnalyticsPlan = {
	trackAppLifecycle: boolean;
	trackAssistantLifecycle: boolean;
};

export const resolveWindowContext = (search: string): AppWindowContext => {
	const windowParam = new URLSearchParams(search).get("window");

	if (windowParam === "settings") {
		return { kind: "settings", isDefaultLauncherWindow: false };
	}

	if (windowParam === "overlay") {
		return { kind: "overlay", isDefaultLauncherWindow: false };
	}

	if (windowParam === "model-selector") {
		return { kind: "model-selector", isDefaultLauncherWindow: false };
	}

	return {
		kind: "launcher",
		isDefaultLauncherWindow: windowParam !== "launcher",
	};
};

export const getWindowAnalyticsPlan = ({
	kind,
}: AppWindowContext): WindowAnalyticsPlan => ({
	trackAppLifecycle: kind === "launcher",
	trackAssistantLifecycle: kind === "overlay",
});

export const shouldListenForOverlayOpacity = ({ kind }: AppWindowContext) =>
	kind === "overlay";

export const getProfileToasterThresholdMs = (
	environment: "development" | "production",
) => (environment === "development" ? 10000 : 180000);

export const getCurrentEnvironment = (): "development" | "production" => {
	if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
		return "production";
	}

	return "development";
};
