import React from "react";
import ReactDOM from "react-dom/client";
import { type AppWindowKind, resolveWindowContext } from "./appBootstrap";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
	getOptionalElectronMethod,
	installElectronApiGuard,
} from "./lib/electronApi";
import "./index.css";

const BootstrapFailureScreen: React.FC<{ errorMessage: string }> = ({
	errorMessage: _errorMessage,
}) => <div className="h-full min-h-0 w-full bg-black" aria-hidden="true" />;

const applyWindowKindAttributes = (kind: AppWindowKind): void => {
	document.documentElement.setAttribute("data-window-kind", kind);
	document.body?.setAttribute("data-window-kind", kind);
	document.getElementById("root")?.setAttribute("data-window-kind", kind);
};

installElectronApiGuard();
applyWindowKindAttributes(resolveWindowContext(window.location.search).kind);

// Initialize Theme
const getThemeMode = getOptionalElectronMethod("getThemeMode");
const onThemeChanged = getOptionalElectronMethod("onThemeChanged");

if (getThemeMode) {
	getThemeMode().then(({ resolved }) => {
		document.documentElement.setAttribute("data-theme", resolved);
	});

	// Listen for changes
	onThemeChanged?.(({ resolved }) => {
		document.documentElement.setAttribute("data-theme", resolved);
	});
}

const logErrorToMain = getOptionalElectronMethod("logErrorToMain");

window.addEventListener("error", (event) => {
	void logErrorToMain?.({
		type: "window-error",
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		stack: event.error?.stack,
	});
});

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	void logErrorToMain?.({
		type: "unhandled-rejection",
		message: reason?.message ?? String(reason),
		stack: reason?.stack,
	});
});

const rootElement = document.getElementById("root");

if (!rootElement) {
	throw new Error("Missing #root element for renderer bootstrap");
}

const root = ReactDOM.createRoot(rootElement);

async function bootstrapRenderer(): Promise<void> {
	try {
		const { default: App } = await import("./App");

		root.render(
			<React.StrictMode>
				<ErrorBoundary context="AppBootstrap">
					<App />
				</ErrorBoundary>
			</React.StrictMode>,
		);
	} catch (error) {
		const bootstrapError =
			error instanceof Error ? error : new Error(String(error));

		void logErrorToMain?.({
			type: "renderer-bootstrap-failed",
			message: bootstrapError.message,
			stack: bootstrapError.stack,
		});

		root.render(
			<React.StrictMode>
				<BootstrapFailureScreen errorMessage={bootstrapError.message} />
			</React.StrictMode>,
		);
	}
}

void bootstrapRenderer();
