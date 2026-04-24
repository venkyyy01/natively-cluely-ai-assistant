"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROCESSING_EVENTS = void 0;
// Barrel re-exports for backwards compatibility
var api_1 = require("./preload/api");
Object.defineProperty(exports, "PROCESSING_EVENTS", { enumerable: true, get: function () { return api_1.PROCESSING_EVENTS; } });
// Side-effect: exposes electronAPI in the renderer main world
require("./preload/api");
//# sourceMappingURL=preload.js.map