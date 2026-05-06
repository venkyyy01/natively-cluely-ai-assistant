import assert from "node:assert/strict";
import test from "node:test";
import { InferenceSupervisor } from "../runtime/InferenceSupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";

test("InferenceSupervisor starts, emits draft and commit events, and stops through the delegate", async () => {
	const calls: string[] = [];
	const bus = new SupervisorBus({ error() {} });
	const events: string[] = [];
	const llmHelper = { id: "helper" };

	bus.subscribeAll(async (event) => {
		events.push(event.type);
	});

	const supervisor = new InferenceSupervisor({
		bus,
		delegate: {
			async start() {
				calls.push("start");
			},
			async stop() {
				calls.push("stop");
			},
			async onDraftReady(requestId) {
				calls.push(`draft:${requestId}`);
			},
			async onAnswerCommitted(requestId) {
				calls.push(`commit:${requestId}`);
			},
			getLLMHelper() {
				return llmHelper;
			},
		},
	});

	await supervisor.start();
	await supervisor.publishDraftReady("req_1");
	await supervisor.commitAnswer("req_1");
	await supervisor.stop();

	assert.equal(supervisor.getState(), "idle");
	assert.deepEqual(calls, ["start", "draft:req_1", "commit:req_1", "stop"]);
	assert.deepEqual(events, [
		"inference:draft-ready",
		"inference:answer-committed",
	]);
	assert.equal(supervisor.getLLMHelper<typeof llmHelper>(), llmHelper);
});

test("InferenceSupervisor transitions to faulted on start failure", async () => {
	const supervisor = new InferenceSupervisor({
		delegate: {
			async start() {
				throw new Error("start failed");
			},
		},
	});

	await assert.rejects(() => supervisor.start(), /start failed/);
	assert.equal(supervisor.getState(), "faulted");
});

test("InferenceSupervisor rejects duplicate starts", async () => {
	const supervisor = new InferenceSupervisor({
		delegate: {},
	});

	await supervisor.start();
	await assert.rejects(
		() => supervisor.start(),
		/Cannot start inference supervisor while running/,
	);
});

test("InferenceSupervisor throws when the delegate does not expose an LLM helper", () => {
	const supervisor = new InferenceSupervisor({
		delegate: {},
	});

	assert.throws(
		() => supervisor.getLLMHelper(),
		/does not expose an LLM helper/,
	);
});

test("InferenceSupervisor sheds non-essential work on stealth faults while running", async () => {
	const bus = new SupervisorBus({ error() {} });
	const calls: string[] = [];

	const supervisor = new InferenceSupervisor({
		bus,
		delegate: {
			async start() {
				calls.push("start");
			},
			async onStealthFault(reason) {
				calls.push(`stealth-fault:${reason}`);
			},
		},
	});

	await supervisor.start();
	await bus.emit({ type: "stealth:fault", reason: "stealth heartbeat missed" });

	assert.deepEqual(calls, ["start", "stealth-fault:stealth heartbeat missed"]);
});

test("InferenceSupervisor ignores stealth faults while not running", async () => {
	const bus = new SupervisorBus({ error() {} });
	const calls: string[] = [];

	const supervisor = new InferenceSupervisor({
		bus,
		delegate: {
			async onStealthFault(reason) {
				calls.push(`stealth-fault:${reason}`);
			},
		},
	});

	await bus.emit({
		type: "stealth:fault",
		reason: "window_visible_to_capture",
	});
	assert.deepEqual(calls, []);

	await supervisor.start();
	await supervisor.stop();
	await bus.emit({
		type: "stealth:fault",
		reason: "window_visible_to_capture",
	});
	assert.deepEqual(calls, []);
});

test("InferenceSupervisor exposes intelligence manager access and LLM initialization through the delegate", async () => {
	const calls: string[] = [];
	const intelligenceManager = { id: "manager" };
	const supervisor = new InferenceSupervisor({
		delegate: {
			getIntelligenceManager() {
				return intelligenceManager;
			},
			async initializeLLMs() {
				calls.push("initialize");
			},
		},
	});

	assert.equal(
		supervisor.getIntelligenceManager<typeof intelligenceManager>(),
		intelligenceManager,
	);
	await supervisor.initializeLLMs();
	assert.deepEqual(calls, ["initialize"]);
});
