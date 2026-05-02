import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	type PersistedSession,
	SessionPersistence,
} from "../memory/SessionPersistence";

function buildSession(meetingId: string, sessionId: string): PersistedSession {
	return {
		version: 1,
		sessionId,
		meetingId,
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
		activeThread: null,
		suspendedThreads: [],
		pinnedItems: [],
		constraints: [],
		epochSummaries: [],
		responseHashes: [],
	};
}

test("NAT-060: loadIndex recovers orphaned session files not in index", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	// Write a session file directly (simulating crash after session write but before index update)
	const session = buildSession("meeting-orphan", "session-orphan");
	const filename = "2024-01-01_meeting-orphan-abc123.json";
	writeFileSync(join(dir, filename), JSON.stringify(session));

	// Index should be empty initially
	writeFileSync(join(dir, "index.json"), JSON.stringify({ sessions: [] }));

	// load should recover the orphan
	const loaded = await persistence.load("session-orphan");
	assert.ok(loaded, "orphaned session should be recovered");
	assert.equal(loaded?.meetingId, "meeting-orphan");

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-060: findByMeeting recovers orphaned session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	const session = buildSession("meeting-orphan-2", "session-orphan-2");
	writeFileSync(join(dir, "session-orphan-2.json"), JSON.stringify(session));
	writeFileSync(join(dir, "index.json"), JSON.stringify({ sessions: [] }));

	const loaded = await persistence.findByMeeting("meeting-orphan-2");
	assert.ok(loaded, "orphaned session should be found by meetingId");
	assert.equal(loaded?.sessionId, "session-orphan-2");

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-060: indexed sessions are not duplicated during orphan scan", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	const session = buildSession("meeting-indexed", "session-indexed");
	await persistence.save(session);

	// Write same session file again (simulating no actual orphan)
	const loaded = await persistence.load("session-indexed");
	assert.ok(loaded);

	const indexContent = JSON.parse(
		require("node:fs").readFileSync(join(dir, "index.json"), "utf-8"),
	);
	const entriesForSession = indexContent.sessions.filter(
		(s: { sessionId: string }) => s.sessionId === "session-indexed",
	);
	assert.equal(
		entriesForSession.length,
		1,
		"session should appear exactly once in index",
	);

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-060: corrupt session files are skipped during orphan scan", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	writeFileSync(join(dir, "corrupt.json"), "not valid json");
	writeFileSync(join(dir, "index.json"), JSON.stringify({ sessions: [] }));

	const loaded = await persistence.loadRecent(10);
	assert.deepEqual(loaded, [], "corrupt files should be skipped");

	rmSync(dir, { recursive: true, force: true });
});

test("NAT-060: atomic write of session then index keeps consistency", async () => {
	const dir = mkdtempSync(join(tmpdir(), "natively-sessions-"));
	const persistence = new SessionPersistence({ sessionsDirectory: dir });

	const session = buildSession("meeting-consistent", "session-consistent");
	await persistence.save(session);

	// Both session and index should exist and be consistent
	const loaded = await persistence.load("session-consistent");
	assert.ok(loaded);
	assert.equal(loaded?.meetingId, "meeting-consistent");

	const recent = await persistence.loadRecent(5);
	assert.equal(recent.length, 1);
	assert.equal(recent[0].sessionId, "session-consistent");

	rmSync(dir, { recursive: true, force: true });
});
