import { DatabaseManager, Meeting } from "./db/DatabaseManager";
import { SessionTracker } from "./SessionTracker";
import { BrowserWindow } from "electron";

const CHECKPOINT_INTERVAL_MS = 60000; // 60 seconds

export class MeetingCheckpointer {
    private interval: NodeJS.Timeout | null = null;
    private meetingId: string | null = null;

    constructor(
        private readonly dbManager: DatabaseManager,
        private readonly sessionTracker: SessionTracker
    ) {}

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
    }

    public destroy(): void {
        this.stop();
    }

    private async checkpoint(): Promise<void> {
        if (!this.meetingId) return;

        // Get snapshot from session tracker
        const snapshot = this.sessionTracker.createSnapshot();
        if (!snapshot || snapshot.transcript.length === 0) {
            return; // Nothing to save yet
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
            // Optionally notify frontend that a checkpoint happened (if they want to show an indicator)
            const wins = BrowserWindow.getAllWindows();
            wins.forEach((w) => {
                if (!w.isDestroyed()) {
                    w.webContents.send('meeting-checkpointed', this.meetingId);
                }
            });
        } catch (e) {
            console.error('[MeetingCheckpointer] Failed to save checkpoint to database', e);
        }
    }
}
