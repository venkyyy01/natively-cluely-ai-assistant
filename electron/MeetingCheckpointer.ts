import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseManager, Meeting } from "./db/DatabaseManager";
import type { SessionTracker } from "./SessionTracker";

const CHECKPOINT_INTERVAL_MS = 60000; // 60 seconds
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

interface CheckpointResult {
	success: boolean;
	retryCount: number;
	usedFallback: boolean;
	fallbackPath?: string;
	error?: string;
}

interface CheckpointError {
	meetingId: string | null;
	error: Error;
	retryCount: number;
	usedFallback: boolean;
	fallbackPath?: string;
}

export class MeetingCheckpointer extends EventEmitter {
	private interval: NodeJS.Timeout | null = null;
	private meetingId: string | null = null;
	private lastCheckpointAt: number = 0;
	private lastTranscriptTimestamp: number = 0;
	private checkpointInProgress: boolean = false;
	private tempDir: string;

	constructor(
		private readonly dbManager: DatabaseManager,
		private readonly getSessionTracker: () => SessionTracker,
		private readonly onCheckpointWritten?: (
			checkpointId: string,
		) => void | Promise<void>,
	) {
		super();
		this.tempDir = path.join(os.tmpdir(), "meeting-checkpoints");
	}

	public start(meetingId: string): void {
		this.stop();
		this.meetingId = meetingId;

		this.interval = setInterval(async () => {
			try {
				await this.checkpoint();
			} catch (err) {
				console.error("[MeetingCheckpointer] Checkpoint failed:", err);
			}
		}, CHECKPOINT_INTERVAL_MS);
		this.interval.unref();

		console.log(`[MeetingCheckpointer] Started for meeting ${this.meetingId}`);
	}

	public stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		if (this.meetingId) {
			console.log(
				`[MeetingCheckpointer] Stopped for meeting ${this.meetingId}`,
			);
		}
		this.meetingId = null;
		this.lastCheckpointAt = 0;
		this.lastTranscriptTimestamp = 0;
	}

	public destroy(): void {
		this.stop();
		this.removeAllListeners();
	}

	private async ensureTempDir(): Promise<void> {
		try {
			await fs.mkdir(this.tempDir, { recursive: true });
		} catch (error) {
			console.error(
				"[MeetingCheckpointer] Failed to create temp directory:",
				error,
			);
		}
	}

	public async checkpointNow(): Promise<void> {
		await this.checkpoint();
	}

	private async checkpoint(): Promise<void> {
		if (!this.meetingId) return;
		if (this.checkpointInProgress) return; // Serialize concurrent calls
		this.checkpointInProgress = true;

		try {
			// Get snapshot from session tracker
			const snapshot = this.getSessionTracker().createSnapshot();
			if (!snapshot || snapshot.transcript.length === 0) {
				return; // Nothing to save yet
			}

			// NAT-061: idle detection — skip checkpoint if no new transcript since last checkpoint
			const latestTranscriptTimestamp =
				snapshot.transcript.length > 0
					? Math.max(...snapshot.transcript.map((t) => t.timestamp ?? 0))
					: 0;
			if (latestTranscriptTimestamp > 0) {
				this.lastTranscriptTimestamp = latestTranscriptTimestamp;
			}
			if (
				this.lastCheckpointAt > 0 &&
				this.lastTranscriptTimestamp <= this.lastCheckpointAt
			) {
				console.log(
					`[MeetingCheckpointer] Idle stretch detected for ${this.meetingId}; skipping checkpoint.`,
				);
				return;
			}

			const result = await this.saveCheckpointWithRetry(snapshot);

			// Emit events based on result
			if (result.success) {
				this.emit("checkpoint", this.meetingId);
				this.emit("checkpoint-saved", {
					meetingId: this.meetingId,
					usedFallback: result.usedFallback,
					fallbackPath: result.fallbackPath,
				});

				// Notify frontend
				await this.notifyFrontend("meeting-checkpointed", this.meetingId);
			} else {
				this.emit("checkpoint-failed", {
					meetingId: this.meetingId,
					error: new Error(result.error || "Unknown error"),
					retryCount: result.retryCount,
					usedFallback: result.usedFallback,
					fallbackPath: result.fallbackPath,
				} as CheckpointError);
			}
		} finally {
			this.checkpointInProgress = false;
		}
	}

	private async saveCheckpointWithRetry(
		snapshot: any,
	): Promise<CheckpointResult> {
		const meetingData: Meeting = this.createMeetingData(snapshot);

		// Try database save with retries
		for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
			try {
				await this.dbManager.createOrUpdateMeetingProcessingRecord(
					meetingData,
					snapshot.startTime,
					snapshot.durationMs,
				);

				return {
					success: true,
					retryCount: attempt - 1,
					usedFallback: false,
				};
			} catch (error) {
				console.error(
					`[MeetingCheckpointer] Database save attempt ${attempt} failed:`,
					error,
				);

				if (attempt < MAX_RETRY_ATTEMPTS) {
					await this.delay(RETRY_DELAY_MS * attempt); // Exponential backoff
				}
			}
		}

		// All retries exhausted — save to fallback file
		await this.ensureTempDir();
		try {
			const fallbackPath = await this.saveFallbackFile(meetingData, snapshot);
			return {
				success: true,
				retryCount: MAX_RETRY_ATTEMPTS,
				usedFallback: true,
				fallbackPath,
				error: "All database retries failed",
			};
		} catch (fallbackError) {
			return {
				success: false,
				retryCount: MAX_RETRY_ATTEMPTS,
				usedFallback: false,
				error: `Fallback save also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
			};
		}
	}

	private createMeetingData(snapshot: any): Meeting {
		const metadata = snapshot.meetingMetadata;
		const durationSec = Math.floor(snapshot.durationMs / 1000);
		const mins = Math.floor(durationSec / 60);
		const secs = durationSec % 60;
		const durationStr = `${mins}:${secs.toString().padStart(2, "0")}`;

		if (!this.meetingId) {
			throw new Error("Meeting ID is required");
		}

		return {
			id: this.meetingId,
			title: metadata?.title || "Interim Recording...",
			date: new Date(snapshot.startTime).toISOString(),
			duration: durationStr,
			summary: "Meeting in progress (checkpoint)...",
			detailedSummary: { actionItems: [], keyPoints: [] },
			transcript: snapshot.transcript,
			usage: snapshot.usage,
			calendarEventId: metadata?.calendarEventId,
			source: metadata?.source || "manual",
			isProcessed: false,
		};
	}

	private async saveFallbackFile(
		meetingData: Meeting,
		snapshot: any,
	): Promise<string> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const fileName = `meeting-${this.meetingId}-${timestamp}.json`;
		const filePath = path.join(this.tempDir, fileName);

		const fallbackData = {
			meetingData,
			snapshot,
			timestamp: Date.now(),
			version: "1.0",
		};

		await fs.writeFile(
			filePath,
			JSON.stringify(fallbackData, null, 2),
			"utf-8",
		);
		console.log(
			`[MeetingCheckpointer] Saved fallback checkpoint to: ${filePath}`,
		);

		return filePath;
	}

	private async notifyFrontend(event: string, data: any): Promise<void> {
		this.emit(event, data);
		this.lastCheckpointAt = Date.now();
		if (this.onCheckpointWritten) {
			if (!this.meetingId) {
				throw new Error("Meeting ID is required for checkpoint callback");
			}
			await this.onCheckpointWritten(this.meetingId);
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// Public method to recover from fallback files
	public async recoverFromFallback(): Promise<string[]> {
		const recoveredFiles: string[] = [];

		try {
			const files = await fs.readdir(this.tempDir);
			const checkpointFiles = files.filter(
				(f: string) => f.startsWith("meeting-") && f.endsWith(".json"),
			);

			for (const file of checkpointFiles) {
				try {
					const filePath = path.join(this.tempDir, file);
					const content = await fs.readFile(filePath, "utf-8");
					const fallbackData = JSON.parse(content);

					// Try to save to database
					await this.dbManager.createOrUpdateMeetingProcessingRecord(
						fallbackData.meetingData,
						fallbackData.snapshot.startTime,
						fallbackData.snapshot.durationMs,
					);

					// Delete successful recovery file
					await fs.unlink(filePath);
					recoveredFiles.push(file);

					console.log(`[MeetingCheckpointer] Recovered fallback file: ${file}`);
				} catch (error) {
					console.error(
						`[MeetingCheckpointer] Failed to recover ${file}:`,
						error,
					);
				}
			}
		} catch (error) {
			console.error(
				"[MeetingCheckpointer] Failed to read fallback directory:",
				error,
			);
		}

		return recoveredFiles;
	}
}
