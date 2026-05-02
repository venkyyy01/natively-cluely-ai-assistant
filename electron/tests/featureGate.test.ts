import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { isPremiumAvailable, resetFeatureGate } from "../premium/featureGate";

test("isPremiumAvailable caches successful detection", () => {
	resetFeatureGate();

	const originalRequire = Module.prototype.require;
	let calls = 0;
	Module.prototype.require = function patchedRequire(
		this: unknown,
		id: string,
	) {
		if (id.includes("premium/electron")) {
			calls += 1;
			return {};
		}
		return originalRequire.call(this, id);
	};

	try {
		assert.equal(isPremiumAvailable(), true);
		assert.equal(isPremiumAvailable(), true);
		assert.equal(calls, 2);
	} finally {
		Module.prototype.require = originalRequire;
		resetFeatureGate();
	}
});

test("isPremiumAvailable returns false when premium modules are missing", () => {
	resetFeatureGate();

	const originalRequire = Module.prototype.require;
	let logged = "";
	const originalLog = console.log;

	Module.prototype.require = function patchedRequire(
		this: unknown,
		id: string,
	) {
		if (id.includes("premium/electron")) {
			throw new Error("missing");
		}
		return originalRequire.call(this, id);
	};
	console.log = (message?: unknown) => {
		logged = String(message);
	};

	try {
		assert.equal(isPremiumAvailable(), false);
		assert.match(logged, /Premium modules not available/);
	} finally {
		Module.prototype.require = originalRequire;
		console.log = originalLog;
		resetFeatureGate();
	}
});
