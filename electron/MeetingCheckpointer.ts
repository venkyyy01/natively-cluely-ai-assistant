import { DatabaseManager, Meeting } from "./db/DatabaseManager";
import { SessionTracker } from "./SessionTracker";
import { EventEmitter } from "events";

const CHECKPOINT_INTERVAL_MS = 60000; // 60 seconds

export class MeetingCheckpointer extends EventEmitter {
    private interval: NodeJS.Timeout | null = null;
    private meetingId: string | null = null;
    private lastCheckpointAt: number = 0;
    private lastTranscriptTimestamp: number = 0;

    constructor(
        private readonly dbManager: DatabaseManager,
        private readonly getSessionTracker: () => SessionTracker,
        private readonly onCheckpointWritten?: (checkpointId: string) => void | Promise<void>,
    ) {
        super();
    }

    public start(meetingId: string): void {
        this.stop();
        this.meetingId = meetingId;
        
        this.interval = setInterval(async () => {
            try {
                await this.checkpoint();
            } catch (err) {
                console.error('[MeetingCheckpointer] Checkpoint failed:', err);
            }
        }, CHECKPOINT_INTERVAL_MS);

        console.log(`[MeetingCheckpointer] Started for meeting ${this.meetingId}`);
    }

    public stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        
        if (this.meetingId) {
            console.log(`[MeetingCheckpointer] Stopped for meeting ${this.meetingId}`);
        }
        this.meetingId = null;
        this.lastCheckpointAt = 0;
        this.lastTranscriptTimestamp = 0;
    }

    public destroy(): void {
        this.stop();
    }

    public async checkpointNow(): Promise<void> {
        await this.checkpoint();
    }

    private async checkpoint(): Promise<void> {
        if (!this.meetingId) return;

        // Get snapshot from session tracker
        const snapshot = this.getSessionTracker().createSnapshot();
        if (!snapshot || snapshot.transcript.length === 0) {
            return; // Nothing to save yet
        }

        // NAT-061: idle detection — skip checkpoint if no new transcript since last checkpoint
        const latestTranscriptTimestamp = snapshot.transcript.length > 0
            ? Math.max(...snapshot.transcript.map(t => t.timestamp ?? 0))
            : 0;
        if (latestTranscriptTimestamp > 0) {
            this.lastTranscriptTimestamp = latestTranscriptTimestamp;
        }
        if (this.lastCheckpointAt > 0 && this.lastTranscriptTimestamp <= this.lastCheckpointAt) {
            console.log(`[MeetingCheckpointer] Idle stretch detected for ${this.meetingId}; skipping checkpoint.`);
            return;
        }

        const metadata = snapshot.meetingMetadata;

        const durationSec = Math.floor(snapshot.durationMs / 1000);
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;
        const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        
        const meetingData: Meeting = {
            id: this.meetingId,
            title: metadata?.title || "Interim Recording...",
            date: new Date(snapshot.startTime).toISOString(),
            duration: durationStr,
            summary: "Meeting in progress (checkpoint)...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            calendarEventId: metadata?.calendarEventId,
            source: metadata?.source || 'manual',
            isProcessed: false
        };

        console.log(`[MeetingCheckpointer] Writing checkpoint for meeting ${this.meetingId}...`);
        
        try {
            this.dbManager.createOrUpdateMeetingProcessingRecord(meetingData, snapshot.startTime, snapshot.durationMs);
            // NAT-061: emit event for subscribers instead of broadcasting to all windows
            this.emit('checkpoint', this.meetingId);
            this.lastCheckpointAt = Date.now();
            if (this.onCheckpointWritten) {
                await this.onCheckpointWritten(this.meetingId);
            }
        } catch (e) {
            console.error('[MeetingCheckpointer] Failed to save checkpoint to database', e);
        }
    }
}
