import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

// Initialize Theme
if (window.electronAPI && window.electronAPI.getThemeMode) {
  window.electronAPI.getThemeMode().then(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });

  // Listen for changes
  window.electronAPI.onThemeChanged(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
  });
}

window.addEventListener("error", (event) => {
  void window.electronAPI?.logErrorToMain?.({
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
  void window.electronAPI?.logErrorToMain?.({
    type: "unhandled-rejection",
    message: reason?.message ?? String(reason),
    stack: reason?.stack,
  })
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
