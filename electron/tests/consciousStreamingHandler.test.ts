import assert from "node:assert/strict";
import test from "node:test";
import { ConsciousStreamingHandler } from "../conscious/ConsciousStreamingHandler";

test("ConsciousStreamingHandler abort awaits cancellation handlers", async () => {
	const handler = new ConsciousStreamingHandler();
	const events: string[] = [];
	handler.on(async (event) => {
		if (event.type === "cancelled") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			events.push("cancelled");
		}
	});

	handler.start();
	await handler.abort();

	assert.deepEqual(events, ["cancelled"]);
	assert.equal(handler.isAborted(), true);
});
