import { app } from "electron"

if (!app.isPackaged) {
  require('dotenv').config();
}

// Side-effect: installs process error handlers, console overrides, and file logging
import './main/logging'

export { AppState } from './main/AppState'

import { initializeApp } from './main/bootstrap'

// Start the application
if (process.env.NODE_ENV !== 'test') {
  initializeApp().catch(console.error)
}
