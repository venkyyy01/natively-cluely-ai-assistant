Object.defineProperty(exports, "__esModule", { value: true });
exports.AppState = void 0;
const electron_1 = require("electron");
if (!electron_1.app.isPackaged) {
	require("dotenv").config();
}
// Side-effect: installs process error handlers, console overrides, and file logging
require("./main/logging");
var AppState_1 = require("./main/AppState");
Object.defineProperty(exports, "AppState", {
	enumerable: true,
	get: () => AppState_1.AppState,
});
const bootstrap_1 = require("./main/bootstrap");
// Start the application
if (process.env.NODE_ENV !== "test") {
	(0, bootstrap_1.initializeApp)().catch(console.error);
}
//# sourceMappingURL=main.js.map
