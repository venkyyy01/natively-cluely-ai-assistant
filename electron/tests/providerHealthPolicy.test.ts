import assert from "node:assert/strict";
import test from "node:test";

import { SttSupervisor } from "../runtime/SttSupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";

test("SttSupervisor exposes provider health and emits exhaustion while cooldown is active", async () => {
	const events: string[] = [];
	const bus = new SupervisorBus({ error() {} });
	const supervisor = new SttSupervisor({
		bus,
		delegates: {
			async startSpeaker() {},
			async stopSpeaker() {},
			async reconnectSpeaker() {
				throw new Error("should not reconnect during cooldown");
			},
			getProviderHealth() {
				return {
					state: "down",
					retryCount: 3,
					recentErrorCount: 3,
					cooldownRemainingMs: 25_000,
				};
			},
		},
		logger: { warn() {} },
	});

	bus.subscribe("stt:provider-exhausted", async (event) => {
		events.push(event.speaker);
	});

	const health = supervisor.getProviderHealth("interviewer");
	await supervisor.reconnectSpeaker("interviewer");

	assert.equal(health.state, "down");
	assert.equal(health.retryCount, 3);
	assert.deepEqual(events, ["interviewer"]);
});
