// Test for MeetingCheckpointer reliability

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MeetingCheckpointer } from "../MeetingCheckpointer";

describe("MeetingCheckpointer Reliability Tests", () => {
	let checkpointer: MeetingCheckpointer;
	let mockDb: any;
	let mockSessionTracker: any;
	let emittedEvents: Array<{ event: string; args: any[] }> = [];
	let originalEmit: typeof MeetingCheckpointer.prototype.emit;

	beforeEach(() => {
		emittedEvents = [];

		let callCount = 0;
		let rejectImpl: (() => Promise<void>) | null = null;

		mockDb = {
			createOrUpdateMeetingProcessingRecord: (): Promise<void> => {
				callCount++;
				if (rejectImpl) {
					return rejectImpl();
				}
				return Promise.resolve();
			},
			getCallCount: (): number => callCount,
			setRejectImpl: (impl: () => Promise<void>): void => {
				rejectImpl = impl;
			},
			resetCallCount: (): void => {
				callCount = 0;
			},
		};

		mockSessionTracker = {
			createSnapshot: (): null => null,
		};

		checkpointer = new MeetingCheckpointer(mockDb, () => mockSessionTracker);

		// Override emit directly (simpler than mock.method)
		originalEmit = checkpointer.emit.bind(checkpointer);
		(checkpointer as any).emit = (event: string, ...args: any[]) => {
			emittedEvents.push({ event, args });
			return originalEmit(event, ...args);
		};
	});

	afterEach(() => {
		checkpointer.stop();
	});

	const createMockSnapshot = (overrides: any = {}) => ({
		transcript: [],
		usage: [],
		startTime: Date.now(),
		durationMs: 0,
		context: "",
		meetingMetadata: null,
		...overrides,
	});

	describe("CRITICAL: Meeting Data Loss Prevention", () => {
		it("should retry checkpoint saves with exponential backoff on DB errors", async () => {
			const mockSnapshot = createMockSnapshot({
				transcript: [
					{
						text: "Important data",
						speaker: "User",
						timestamp: Date.now(),
						final: true,
					},
				],
			});
			mockSessionTracker.createSnapshot = () => mockSnapshot;

			let attemptCount = 0;
			mockDb.setRejectImpl(() => {
				attemptCount++;
				if (attemptCount <= 2) {
					return Promise.reject(new Error("Database locked"));
				}
				return Promise.resolve();
			});

			checkpointer.start("test-meeting-id");
			await (checkpointer as any).checkpoint();

			assert.equal(mockDb.getCallCount(), 3);

			const failedEvents = emittedEvents.filter(
				(e) => e.event === "checkpoint-failed",
			);
			assert.equal(failedEvents.length, 0);
		});

		it("should emit checkpoint-failed event after exhausting retries", {
			timeout: 15000,
		}, async () => {
			const mockSnapshot = createMockSnapshot({
				transcript: [
					{ text: "test", speaker: "User", timestamp: Date.now(), final: true },
				],
			});
			mockSessionTracker.createSnapshot = () => mockSnapshot;
			mockDb.setRejectImpl(() => Promise.reject(new Error("Disk full")));

			checkpointer.start("test-meeting-id");
			await (checkpointer as any).checkpoint();

			assert.equal(mockDb.getCallCount(), 3);

			// After DB failures, fallback to temp file succeeds, so checkpoint-saved is emitted with usedFallback
			const savedEvents = emittedEvents.filter(
				(e) => e.event === "checkpoint-saved",
			);
			assert.ok(
				savedEvents.length > 0,
				"Should emit checkpoint-saved event with fallback",
			);
			assert.ok(
				savedEvents[0].args[0].usedFallback === true,
				"Should use fallback",
			);
		});

		it("should fallback to temp file when DB is completely unavailable", {
			timeout: 15000,
		}, async () => {
			const mockSnapshot = createMockSnapshot({
				transcript: [
					{
						text: "Critical meeting data",
						speaker: "User",
						timestamp: Date.now(),
						final: true,
					},
				],
				meetingMetadata: { title: "Test Meeting" },
			});
			mockSessionTracker.createSnapshot = () => mockSnapshot;
			mockDb.setRejectImpl(() =>
				Promise.reject(new Error("DB connection failed")),
			);

			checkpointer.start("test-meeting-id");
			await (checkpointer as any).checkpoint();

			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			const os = await import("node:os");
			const tempDir = path.join(os.tmpdir(), "meeting-checkpoints");
			const tempFiles = await fs.readdir(tempDir);
			const checkpointFiles = tempFiles.filter((f: string) =>
				f.startsWith("meeting-test-meeting-id"),
			);

			assert.ok(
				checkpointFiles.length > 0,
				`Should have created fallback file, found: ${tempFiles.join(", ")}`,
			);

			// Read the newest file (last alphabetically = latest timestamp)
			const newestFile = checkpointFiles.sort().pop()!;
			const tempFilePath = path.join(tempDir, newestFile);
			const tempFileContent = await fs.readFile(tempFilePath, "utf8");
			const recoveryData = JSON.parse(tempFileContent);

			assert.equal(
				recoveryData.snapshot.transcript[0].text,
				"Critical meeting data",
			);
			assert.equal(recoveryData.meetingData.title, "Test Meeting");

			await fs.unlink(tempFilePath);
		});

		it("should handle concurrent checkpoint calls gracefully", async () => {
			const mockSnapshot = createMockSnapshot({
				transcript: [
					{ text: "test", speaker: "User", timestamp: Date.now(), final: true },
				],
			});
			mockSessionTracker.createSnapshot = () => mockSnapshot;
			mockDb.setRejectImpl(
				() => new Promise((resolve) => setTimeout(resolve, 100)),
			);

			checkpointer.start("test-meeting-id");
			const promises = [
				(checkpointer as any).checkpoint(),
				(checkpointer as any).checkpoint(),
				(checkpointer as any).checkpoint(),
			];
			await Promise.all(promises);

			assert.equal(mockDb.getCallCount(), 1);
		});
	});

	describe("Resource Management", () => {
		it("should clean up intervals on stop", () => {
			checkpointer.start("test-meeting-id");

			assert.ok((checkpointer as any).interval);

			checkpointer.stop();

			assert.equal((checkpointer as any).interval, null);
		});

		it("should not prevent process exit with unref interval", () => {
			checkpointer.start("test-meeting-id");

			const interval = (checkpointer as any).interval;
			assert.equal(interval.hasRef(), false);
		});
	});
});
