import React from "react"
import ReactDOM from "react-dom/client"
import { resolveWindowContext, type AppWindowKind } from "./appBootstrap"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { getOptionalElectronMethod, installElectronApiGuard } from "./lib/electronApi"
import "./index.css"

const BootstrapFailureScreen: React.FC<{ errorMessage: string }> = ({ errorMessage }) => (
  <div className="flex h-full min-h-0 w-full items-center justify-center bg-[#050505] px-6">
    <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#111111] p-6 text-left shadow-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#8A8A8A]">Startup Error</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">Renderer bootstrap failed</h1>
      <p className="mt-3 text-sm leading-6 text-[#B5B5B5]">
        The renderer loaded, but the main app bundle failed before the launcher could render.
        Restart the app. If this repeats, the startup log now captures the import failure directly.
      </p>
      <code className="mt-4 block overflow-x-auto rounded-2xl border border-[#ff3333]/20 bg-[#1A1A1A] px-4 py-3 text-xs text-[#ff7b7b]">
        {errorMessage}
      </code>
    </div>
  </div>
)

const applyWindowKindAttributes = (kind: AppWindowKind): void => {
  document.documentElement.setAttribute("data-window-kind", kind)
  document.body?.setAttribute("data-window-kind", kind)
  document.getElementById("root")?.setAttribute("data-window-kind", kind)
}

installElectronApiGuard()
applyWindowKindAttributes(resolveWindowContext(window.location.search).kind)

// Initialize Theme
const getThemeMode = getOptionalElectronMethod('getThemeMode')
const onThemeChanged = getOptionalElectronMethod('onThemeChanged')

if (getThemeMode) {
  getThemeMode().then(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  // Listen for changes
  onThemeChanged?.(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });
}

const logErrorToMain = getOptionalElectronMethod('logErrorToMain')

window.addEventListener("error", (event) => {
  void logErrorToMain?.({
    type: "window-error",
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack,
  })
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason
  void logErrorToMain?.({
    type: "unhandled-rejection",
    message: reason?.message ?? String(reason),
    stack: reason?.stack,
  })
})

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Missing #root element for renderer bootstrap")
}

const root = ReactDOM.createRoot(rootElement)

async function bootstrapRenderer(): Promise<void> {
  try {
    const { default: App } = await import("./App")

    root.render(
      <React.StrictMode>
        <ErrorBoundary context="AppBootstrap">
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    )
  } catch (error) {
    const bootstrapError = error instanceof Error ? error : new Error(String(error))

    void logErrorToMain?.({
      type: "renderer-bootstrap-failed",
      message: bootstrapError.message,
      stack: bootstrapError.stack,
    })

    root.render(
      <React.StrictMode>
        <BootstrapFailureScreen errorMessage={bootstrapError.message} />
      </React.StrictMode>
    )
  }
}

void bootstrapRenderer()
