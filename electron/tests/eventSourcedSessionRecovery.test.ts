import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	type PersistedSession,
	SessionPersistence,
} from "../memory/SessionPersistence";

test("NAT-059: appendEvent writes newline-delimited JSON to events.log", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	await persistence.appendEvent("session-1", {
		eventId: "evt-1",
		type: "transcript",
		timestamp: Date.now(),
		payload: { speaker: "interviewer", text: "hello" },
	});

	const events = await persistence.replayEvents("session-1");
	assert.equal(events.length, 1);
	assert.equal(events[0].eventId, "evt-1");
	assert.equal(events[0].type, "transcript");

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: replayEvents returns multiple events in order", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	for (let i = 0; i < 3; i += 1) {
		await persistence.appendEvent("session-2", {
			eventId: `evt-${i}`,
			type: "transcript",
			timestamp: Date.now() + i,
			payload: { index: i },
		});
	}

	const events = await persistence.replayEvents("session-2");
	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((e) => e.eventId),
		["evt-0", "evt-1", "evt-2"],
	);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: snapshotEvents appends checkpoint without destroying the audit log", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	await persistence.appendEvent("session-3", {
		eventId: "evt-1",
		type: "transcript",
		timestamp: Date.now(),
		payload: { text: "first" },
	});

	const session: PersistedSession = {
		version: 1,
		sessionId: "session-3",
		meetingId: "meeting-3",
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
		activeThread: null,
		suspendedThreads: [],
		pinnedItems: [],
		constraints: [],
		epochSummaries: [],
		responseHashes: [],
	};

	await persistence.snapshotEvents("session-3", session);

	const events = await persistence.replayEvents("session-3");
	assert.equal(events.length, 2);
	assert.deepEqual(
		events.map((event) => event.type),
		["transcript", "checkpoint"],
	);
	assert.equal(
		(events[1].payload.session as PersistedSession).sessionId,
		"session-3",
	);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: replayUntil stops at specified eventId", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	for (let i = 0; i < 5; i += 1) {
		await persistence.appendEvent("session-4", {
			eventId: `evt-${i}`,
			type: "transcript",
			timestamp: Date.now() + i,
			payload: { index: i },
		});
	}

	const events = await persistence.replayUntil("session-4", "evt-2");
	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((e) => e.eventId),
		["evt-0", "evt-1", "evt-2"],
	);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: replayUntil returns all events when eventId not found", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	for (let i = 0; i < 3; i += 1) {
		await persistence.appendEvent("session-5", {
			eventId: `evt-${i}`,
			type: "transcript",
			timestamp: Date.now() + i,
			payload: { index: i },
		});
	}

	const events = await persistence.replayUntil("session-5", "nonexistent");
	assert.equal(events.length, 3);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: replayEvents returns empty array for missing session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	const events = await persistence.replayEvents("session-does-not-exist");
	assert.deepEqual(events, []);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-059: event count grows linearly with append calls", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	for (let i = 0; i < 100; i += 1) {
		await persistence.appendEvent("session-6", {
			eventId: `evt-${i}`,
			type: "transcript",
			timestamp: Date.now(),
			payload: { index: i },
		});
	}

	const count = await persistence.getEventCount("session-6");
	assert.equal(count, 100);

	rmSync(dir, { recursive: true, force: true });
});
