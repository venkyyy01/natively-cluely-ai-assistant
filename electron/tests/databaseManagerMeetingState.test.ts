import assert from "node:assert/strict";
import test from "node:test";
import type { Meeting } from "../db/DatabaseManager";
import { DatabaseManager } from "../db/DatabaseManager";

test("DatabaseManager.getRecentMeetings uses persisted processing state for title normalization", () => {
	let capturedSql = "";

	const fakeDb = {
		prepare(sql: string) {
			capturedSql = sql;
			return {
				all(limit: number) {
					assert.equal(limit, 10);
					return [
						{
							id: "processing-meeting",
							title: "Processing...",
							created_at: "2024-01-02T03:04:05.000Z",
							duration_ms: 61_000,
							summary_json: "{}",
							calendar_event_id: null as string | null,
							source: "manual",
							is_processed: 0,
						},
						{
							id: "completed-meeting",
							title: "Processing...",
							created_at: "2024-01-03T03:04:05.000Z",
							duration_ms: 61_000,
							summary_json: "{}",
							calendar_event_id: null as string | null,
							source: "manual",
							is_processed: 1,
						},
						{
							id: "failed-meeting",
							title: "",
							created_at: "2024-01-04T03:04:05.000Z",
							duration_ms: 61_000,
							summary_json: JSON.stringify({
								legacySummary: "Meeting processing failed",
							}),
							calendar_event_id: null as string | null,
							source: "manual",
							is_processed: -1,
						},
					];
				},
			};
		},
	};

	const meetings = DatabaseManager.prototype.getRecentMeetings.call(
		{ db: fakeDb } as unknown as DatabaseManager,
		10,
	) as Meeting[];

	assert.match(capturedSql, /\bis_processed\b/);
	assert.deepEqual(
		meetings.map((meeting: Meeting) => ({
			id: meeting.id,
			title: meeting.title,
			isProcessed: meeting.isProcessed,
			processingState: meeting.processingState,
			summary: meeting.summary,
		})),
		[
			{
				id: "processing-meeting",
				title: "Processing...",
				isProcessed: false,
				processingState: "processing",
				summary: "",
			},
			{
				id: "completed-meeting",
				title: "Untitled Session",
				isProcessed: true,
				processingState: "completed",
				summary: "",
			},
			{
				id: "failed-meeting",
				title: "Untitled Session",
				isProcessed: false,
				processingState: "failed",
				summary: "Meeting processing failed",
			},
		],
	);
});

test("DatabaseManager.markMeetingProcessingFailed normalizes placeholder titles", () => {
	const updates: Array<{ title: string; summaryJson: string; id: string }> = [];

	const fakeDb = {
		prepare(sql: string) {
			if (
				sql.startsWith("SELECT title, summary_json FROM meetings WHERE id = ?")
			) {
				return {
					get(id: string) {
						assert.equal(id, "meeting-1");
						return {
							title: "Processing...",
							summary_json: JSON.stringify({
								legacySummary: "Generating summary...",
							}),
						};
					},
				};
			}

			if (
				sql.startsWith(
					"UPDATE meetings SET title = ?, is_processed = -1, summary_json = ? WHERE id = ?",
				)
			) {
				return {
					run(title: string, summaryJson: string, id: string) {
						updates.push({ title, summaryJson, id });
						return { changes: 1 };
					},
				};
			}

			throw new Error(`Unexpected SQL: ${sql}`);
		},
	};

	const updated = DatabaseManager.prototype.markMeetingProcessingFailed.call(
		{ db: fakeDb } as unknown as DatabaseManager,
		"meeting-1",
		new Error("boom"),
	);

	assert.equal(updated, true);
	assert.equal(updates[0]?.title, "Untitled Session");
	assert.equal(updates[0]?.id, "meeting-1");
	assert.deepEqual(JSON.parse(updates[0]?.summaryJson ?? "{}"), {
		legacySummary: "Meeting processing failed",
		error: "boom",
	});
});
