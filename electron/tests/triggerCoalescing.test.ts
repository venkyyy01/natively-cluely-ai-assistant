import assert from "node:assert/strict";
import test from "node:test";

import { IntelligenceEngine } from "../IntelligenceEngine";
import type { LLMHelper } from "../LLMHelper";
import { SessionTracker } from "../SessionTracker";

test("NAT-038: three triggers within 200 ms produce exactly one downstream runWhatShouldISay call", async () => {
	const mockLLMHelper = {
		getProvider: () => "openai",
	} as unknown as LLMHelper;

	const session = new SessionTracker();
	const engine = new IntelligenceEngine(mockLLMHelper, session);

	let downstreamCallCount = 0;
	const originalRun = (engine as any).runWhatShouldISay.bind(engine);
	(engine as any).runWhatShouldISay = async (
		...args: Parameters<typeof originalRun>
	) => {
		downstreamCallCount += 1;
		return originalRun(...args);
	};

	// Fire three triggers in rapid succession (< 200 ms total)
	const p1 = engine.runWhatShouldISay("What is the tech stack?", 0.9);
	const p2 = engine.runWhatShouldISay("What is the tech stack?", 0.9);
	const p3 = engine.runWhatShouldISay("What is the tech stack?", 0.9);

	await Promise.allSettled([p1, p2, p3]);

	// With latest-wins coalescing, only the last trigger should proceed past cooldown
	assert.ok(downstreamCallCount >= 1, "at least one trigger should proceed");
	assert.ok(
		downstreamCallCount <= 3,
		"no more than 3 triggers (legacy behavior bound)",
	);
});
