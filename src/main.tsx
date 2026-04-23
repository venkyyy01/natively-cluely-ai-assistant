import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { getOptionalElectronMethod, installElectronApiGuard } from "./lib/electronApi"
import "./index.css"

installElectronApiGuard()

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary context="AppBootstrap">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
