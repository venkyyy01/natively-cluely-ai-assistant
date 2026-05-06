// electron/tests/threadManager.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { ThreadManager } from "../conscious/ThreadManager";

test("ThreadManager - should create a new thread", () => {
	const manager = new ThreadManager();
	const thread = manager.createThread("Design YouTube", "high_level_design");
	assert.equal(thread.topic, "Design YouTube");
	assert.equal(thread.phase, "high_level_design");
	assert.equal(thread.status, "active");
	assert.ok(Array.isArray(thread.embedding));
	assert.equal(thread.embedding?.length, 32);
});

test("ThreadManager - should suspend active thread when creating new", () => {
	const manager = new ThreadManager();
	manager.createThread("Design YouTube", "high_level_design");
	manager.createThread("Leadership story", "behavioral_story");

	const suspended = manager.getSuspendedThreads();
	assert.equal(suspended.length, 1);
	assert.equal(suspended[0].topic, "Design YouTube");
	assert.equal(suspended[0].status, "suspended");
});

test("ThreadManager - should limit suspended threads to 3", () => {
	const manager = new ThreadManager();
	manager.createThread("Thread 1", "high_level_design");
	manager.createThread("Thread 2", "deep_dive");
	manager.createThread("Thread 3", "implementation");
	manager.createThread("Thread 4", "scaling_discussion");
	manager.createThread("Thread 5", "failure_handling");

	const suspended = manager.getSuspendedThreads();
	assert.equal(suspended.length, 3);
	assert.equal(
		suspended.some((t: any) => t.topic === "Thread 1"),
		false,
	); // Oldest evicted
});

test("ThreadManager - should resume a suspended thread", () => {
	const manager = new ThreadManager();
	const original = manager.createThread("Design YouTube", "high_level_design");
	manager.createThread("Leadership story", "behavioral_story");

	const resumed = manager.resumeThread(original.id);
	assert.equal(resumed, true);
	assert.equal(manager.getActiveThread()?.topic, "Design YouTube");
	assert.equal(manager.getActiveThread()?.resumeCount, 1);
});

test("ThreadManager - should expire threads past TTL", () => {
	const manager = new ThreadManager();
	const originalNow = Date.now;
	let currentTime = Date.now();

	// Mock Date.now
	Date.now = () => currentTime;

	try {
		manager.createThread("Old thread", "high_level_design");
		manager.createThread("New thread", "behavioral_story");

		// Advance time past TTL (5 minutes)
		currentTime += 6 * 60 * 1000;

		manager.pruneExpired();
		const suspended = manager.getSuspendedThreads();
		assert.equal(suspended.length, 0);
	} finally {
		Date.now = originalNow;
	}
});

test("ThreadManager - should find matching thread by keywords", () => {
	const manager = new ThreadManager();
	manager.createThread("Design caching layer", "high_level_design");
	manager.createThread("Tell me about leadership", "behavioral_story");

	const match = manager.findMatchingThread(
		"Let's go back to the caching discussion",
	);
	assert.ok(match !== null);
	assert.ok(match?.thread.topic.includes("caching"));
});
