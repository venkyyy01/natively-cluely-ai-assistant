import { DatabaseManager } from "./db/DatabaseManager";
import { MeetingCheckpointStore } from "./MeetingCheckpointStore";
import { SessionTracker } from "./SessionTracker";
import { BrowserWindow } from "electron";

const CHECKPOINT_INTERVAL_MS = 60000; // 60 seconds

export class MeetingCheckpointer {
    private interval: NodeJS.Timeout | null = null;
    private meetingId: string | null = null;
    private checkpointInFlight: Promise<void> | null = null;

    constructor(
        private readonly dbManager: DatabaseManager,
        private readonly getSessionTracker: () => SessionTracker,
        private readonly checkpointStore: Pick<MeetingCheckpointStore, 'saveSnapshot'> = new MeetingCheckpointStore(),
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
        if (this.checkpointInFlight) return;

        // Get snapshot from session tracker
        const snapshot = this.getSessionTracker().createSnapshot();
        if (!snapshot || snapshot.transcript.length === 0) {
            return; // Nothing to save yet
        }

        console.log(`[MeetingCheckpointer] Writing checkpoint for meeting ${this.meetingId}...`);

        this.checkpointInFlight = (async () => {
            try {
                await this.checkpointStore.saveSnapshot(this.meetingId!, snapshot);
                // Optionally notify frontend that a checkpoint happened (if they want to show an indicator)
                const wins = typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : [];
                wins.forEach((w) => {
                    if (!w.isDestroyed()) {
                        w.webContents.send('meeting-checkpointed', this.meetingId);
                    }
                });
            } catch (e) {
                console.error('[MeetingCheckpointer] Failed to save checkpoint snapshot', e);
            } finally {
                this.checkpointInFlight = null;
            }
        })();

        await this.checkpointInFlight;
    }
}
