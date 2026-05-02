import assert from "node:assert/strict";
import test from "node:test";

import { MeetingCheckpointer } from "../MeetingCheckpointer";
import type { MeetingSnapshot } from "../SessionTracker";

function makeSnapshot(
	transcript: MeetingSnapshot["transcript"],
): MeetingSnapshot {
	return {
		transcript,
		usage: [],
		startTime: Date.now() - 5_000,
		durationMs: 5_000,
		context: "",
		meetingMetadata: null,
	};
}

test("NAT-061: checkpoint emits event instead of broadcasting to all windows", async () => {
	const emitted: string[] = [];
	const checkpointer = new MeetingCheckpointer(
		{
			createOrUpdateMeetingProcessingRecord() {},
		} as never,
		() =>
			({
				createSnapshot() {
					return makeSnapshot([
						{
							speaker: "interviewer",
							text: "hello",
							timestamp: Date.now(),
							final: true,
						},
					]);
				},
			}) as never,
	);

	checkpointer.on("checkpoint", (id: string) => emitted.push(id));

	checkpointer.start("meeting-1");
	await checkpointer.checkpointNow();
	checkpointer.stop();

	assert.deepEqual(emitted, ["meeting-1"]);
});

test("NAT-061: idle stretch skips checkpoint when no new transcript since last checkpoint", async () => {
	const writes: string[] = [];
	let transcriptTimestamp = Date.now();

	const checkpointer = new MeetingCheckpointer(
		{
			createOrUpdateMeetingProcessingRecord() {
				writes.push("write");
			},
		} as never,
		() =>
			({
				createSnapshot() {
					return makeSnapshot([
						{
							speaker: "interviewer",
							text: "hello",
							timestamp: transcriptTimestamp,
							final: true,
						},
					]);
				},
			}) as never,
	);

	checkpointer.start("meeting-2");

	// First checkpoint should write
	await checkpointer.checkpointNow();
	assert.equal(writes.length, 1, "first checkpoint should write");

	// Second checkpoint with same transcript timestamp should skip (idle)
	await checkpointer.checkpointNow();
	assert.equal(
		writes.length,
		1,
		"second checkpoint should be skipped due to idle",
	);

	// Now add a newer transcript
	transcriptTimestamp = Date.now() + 1;
	await checkpointer.checkpointNow();
	assert.equal(
		writes.length,
		2,
		"checkpoint after new transcript should write again",
	);

	checkpointer.stop();
});

test("NAT-061: stop resets idle tracking state", async () => {
	const writes: string[] = [];
	const transcriptTimestamp = Date.now();

	const checkpointer = new MeetingCheckpointer(
		{
			createOrUpdateMeetingProcessingRecord() {
				writes.push("write");
			},
		} as never,
		() =>
			({
				createSnapshot() {
					return makeSnapshot([
						{
							speaker: "interviewer",
							text: "hello",
							timestamp: transcriptTimestamp,
							final: true,
						},
					]);
				},
			}) as never,
	);

	checkpointer.start("meeting-3");
	await checkpointer.checkpointNow();
	assert.equal(writes.length, 1);

	// After stop, idle state should be reset
	checkpointer.stop();
	checkpointer.start("meeting-3");
	await checkpointer.checkpointNow();
	// Since stop resets lastCheckpointAt to 0, the next checkpoint should write
	// because there's no prior checkpoint to compare against
	assert.equal(
		writes.length,
		2,
		"checkpoint after stop/start should write because idle state was reset",
	);

	checkpointer.stop();
});

test("NAT-061: multiple listeners receive checkpoint event", async () => {
	const listener1: string[] = [];
	const listener2: string[] = [];

	const checkpointer = new MeetingCheckpointer(
		{
			createOrUpdateMeetingProcessingRecord() {},
		} as never,
		() =>
			({
				createSnapshot() {
					return makeSnapshot([
						{
							speaker: "interviewer",
							text: "hello",
							timestamp: Date.now(),
							final: true,
						},
					]);
				},
			}) as never,
	);

	checkpointer.on("checkpoint", (id: string) => listener1.push(id));
	checkpointer.on("checkpoint", (id: string) => listener2.push(id));

	checkpointer.start("meeting-4");
	await checkpointer.checkpointNow();
	checkpointer.stop();

	assert.deepEqual(listener1, ["meeting-4"]);
	assert.deepEqual(listener2, ["meeting-4"]);
});

test("NAT-061: empty transcript still short-circuits before idle check", async () => {
	const writes: string[] = [];

	const checkpointer = new MeetingCheckpointer(
		{
			createOrUpdateMeetingProcessingRecord() {
				writes.push("write");
			},
		} as never,
		() =>
			({
				createSnapshot() {
					return makeSnapshot([]);
				},
			}) as never,
	);

	checkpointer.start("meeting-5");
	await checkpointer.checkpointNow();
	checkpointer.stop();

	assert.equal(
		writes.length,
		0,
		"empty transcript should not trigger any write",
	);
});
