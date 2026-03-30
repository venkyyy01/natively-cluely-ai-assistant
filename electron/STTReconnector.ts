export class STTReconnector {
    private maxRetries = 7; // Up to ~2 mins total wait
    private baseDelayMs = 1000;
    
    private retryCounts = new Map<string, number>();
    private timeouts = new Map<string, NodeJS.Timeout>();
    private successTimeouts = new Map<string, NodeJS.Timeout>();

    constructor(private readonly reconnectFn: (speaker: 'interviewer'|'user') => Promise<void> | void) {}

    public onError(speaker: 'interviewer'|'user'): void {
        let count = this.retryCounts.get(speaker) || 0;
        if (count >= this.maxRetries) {
            console.error(`[STTReconnector] Max retries reached for ${speaker}. Giving up.`);
            return;
        }

        const delay = this.baseDelayMs * Math.pow(2, count);
        this.retryCounts.set(speaker, count + 1);

        console.log(`[STTReconnector] Scheduling reconnect for ${speaker} in ${delay}ms... (Attempt ${count + 1}/${this.maxRetries})`);
        
        if (this.timeouts.has(speaker)) {
            clearTimeout(this.timeouts.get(speaker)!);
        }
        if (this.successTimeouts.has(speaker)) {
            clearTimeout(this.successTimeouts.get(speaker)!);
        }

        const timeout = setTimeout(async () => {
            try {
                console.log(`[STTReconnector] Attempting reconnect for ${speaker}...`);
                await this.reconnectFn(speaker);
                console.log(`[STTReconnector] Successfully reconnected ${speaker}`);
                
                // If it stays connected for 10 seconds without another error, reset the counter
                const successTimeout = setTimeout(() => {
                    console.log(`[STTReconnector] ${speaker} has been stable for 10s, resetting retry count.`);
                    this.retryCounts.set(speaker, 0);
                }, 10000);
                this.successTimeouts.set(speaker, successTimeout);

            } catch (err) {
                console.error(`[STTReconnector] Reconnect failed for ${speaker}:`, err);
                // Trigger next backoff cycle
                this.onError(speaker);
            }
        }, delay);
        
        this.timeouts.set(speaker, timeout);
    }

    public reset(speaker: 'interviewer'|'user'): void {
        this.retryCounts.set(speaker, 0);
        if (this.timeouts.has(speaker)) {
            clearTimeout(this.timeouts.get(speaker)!);
            this.timeouts.delete(speaker);
        }
        if (this.successTimeouts.has(speaker)) {
            clearTimeout(this.successTimeouts.get(speaker)!);
            this.successTimeouts.delete(speaker);
        }
    }

    public stopAll(): void {
        this.timeouts.forEach(t => clearTimeout(t));
        this.timeouts.clear();
        this.successTimeouts.forEach(t => clearTimeout(t));
        this.successTimeouts.clear();
        this.retryCounts.clear();
    }
}
