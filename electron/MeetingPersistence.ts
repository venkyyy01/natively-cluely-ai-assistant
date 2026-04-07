// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { MeetingMetadataSnapshot, MeetingSnapshot, SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT } from './llm';
const crypto = require('crypto');

const PLACEHOLDER_MEETING_TITLES = new Set(['', 'Processing...', 'Untitled Session']);
const DEFAULT_FINAL_MEETING_TITLE = 'Untitled Session';

export class MeetingPersistence {
  private session: SessionTracker;
  private llmHelper: LLMHelper;
  private pendingSaves: Set<Promise<void>> = new Set();

  constructor(session: SessionTracker, llmHelper: LLMHelper) {
    this.session = session;
    this.llmHelper = llmHelper;
  }

  setSession(session: SessionTracker): void {
    this.session = session;
  }

  private isMeaningfulTitle(title?: string | null): title is string {
    return typeof title === 'string' && !PLACEHOLDER_MEETING_TITLES.has(title.trim());
  }

  private toMeetingDate(startTimeMs: number, fallbackDate?: string): string {
    if (Number.isFinite(startTimeMs) && startTimeMs > 0) {
      return new Date(startTimeMs).toISOString();
    }

    if (fallbackDate) {
      const parsedFallback = new Date(fallbackDate).getTime();
      if (Number.isFinite(parsedFallback)) {
        return new Date(parsedFallback).toISOString();
      }
    }

    return new Date().toISOString();
  }

  /**
  * Wait for all pending meeting saves to complete.
  * Call this before app quit to prevent data loss.
  */
  async waitForPendingSaves(timeoutMs: number = 10000): Promise<void> {
    if (this.pendingSaves.size === 0) return;

    console.log(`[MeetingPersistence] Waiting for ${this.pendingSaves.size} pending saves...`);

    const timeout = new Promise<void>((_, reject) => 
      setTimeout(() => reject(new Error('Timeout waiting for pending saves')), timeoutMs)
    );

    try {
      await Promise.race([
        Promise.all(Array.from(this.pendingSaves)),
        timeout
      ]);
      console.log('[MeetingPersistence] All pending saves completed');
    } catch (e) {
      console.warn('[MeetingPersistence] Some saves may not have completed:', e);
    }
  }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(meetingId?: string): Promise<SessionTracker> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        if (meetingId && typeof (this.session as any).setActiveMeetingId === 'function') {
            (this.session as any).setActiveMeetingId(meetingId);
        }

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        if (typeof (this.session as any).flushPersistenceNow === 'function') {
            (this.session as any).flushPersistenceNow();
        }

        const snapshot = this.session.createSnapshot();
        const nextSession = this.session.createSuccessorSession();
        this.session = nextSession;

        if (snapshot.durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            return nextSession;
        }

    const resolvedMeetingId = meetingId ?? crypto.randomUUID();
    const savePromise = this.processAndSaveMeeting(snapshot, resolvedMeetingId);
    this.pendingSaves.add(savePromise);
    savePromise
      .catch(err => console.error('[MeetingPersistence] Background processing failed:', err))
      .finally(() => this.pendingSaves.delete(savePromise));

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(snapshot.durationMs / 60000);
        const seconds = ((snapshot.durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
        const metadata = snapshot.meetingMetadata;

        const placeholder: Meeting = {
            id: resolvedMeetingId,
            title: this.isMeaningfulTitle(metadata?.title) ? metadata.title : "Processing...",
            date: this.toMeetingDate(snapshot.startTime),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            calendarEventId: metadata?.calendarEventId,
            source: metadata?.source || 'manual',
            isProcessed: false
        };

        try {
            DatabaseManager.getInstance().createOrUpdateMeetingProcessingRecord(placeholder, snapshot.startTime, snapshot.durationMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }

        return nextSession;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(data: MeetingSnapshot, meetingId: string): Promise<void> {
        let title = DEFAULT_FINAL_MEETING_TITLE;
        let summaryData: { actionItems: string[], keyPoints: string[] } = { actionItems: [], keyPoints: [] };

        const metadata: MeetingMetadataSnapshot | null = data.meetingMetadata || null;
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (metadata) {
            if (this.isMeaningfulTitle(metadata.title)) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
        }

        try {
            // Generate Title (only if not set by calendar)
            if (!this.isMeaningfulTitle(metadata?.title)) {
                const titlePrompt = `Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, data.context.substring(0, 5000), groqTitlePrompt);
                const cleanedTitle = generatedTitle?.replace(/["*]/g, '').trim();
                if (this.isMeaningfulTitle(cleanedTitle)) {
                    title = cleanedTitle;
                }
            }

            // Generate Structured Summary
            if (data.transcript.length > 2) {
                const summaryPrompt = `You are a silent meeting summarizer. Convert this conversation into concise internal meeting notes.
    
    RULES:
    - Do NOT invent information not present in the context
    - You MAY infer implied action items or next steps if they are logical consequences of the discussion
    - Do NOT explain or define concepts mentioned
    - Do NOT use filler phrases like "The meeting covered..." or "Discussed various..."
    - Do NOT mention transcripts, AI, or summaries
    - Do NOT sound like an AI assistant
    - Sound like a senior PM's internal notes
    
    STYLE: Calm, neutral, professional, skim-friendly. Short bullets, no sub-bullets.
    
    Return ONLY valid JSON (no markdown code blocks):
    {
      "overview": "1-2 sentence description of what was discussed",
      "keyPoints": ["3-6 specific bullets - each = one concrete topic or point discussed"],
      "actionItems": ["specific next steps, assigned tasks, or implied follow-ups. If absolutely none found, return empty array"]
    }`;

                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, data.context.substring(0, 10000), groqSummaryPrompt);

                if (generatedSummary) {
                    const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();
                    try {
                        summaryData = JSON.parse(jsonStr);
                    } catch (e) { console.error("Failed to parse summary JSON", e); }
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        try {
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: this.toMeetingDate(data.startTime),
                duration: durationStr,
                summary: "See detailed summary",
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

            DatabaseManager.getInstance().finalizeMeetingProcessing(meetingData, data.startTime, data.durationMs);

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
            DatabaseManager.getInstance().markMeetingProcessingFailed(meetingId, error);
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        }
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering...`);

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[MeetingPersistence] Recovering meeting ${m.id}...`);

                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'interviewer' ? 'INTERVIEWER' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const durationMs = this.parseDurationToMs(details.duration);
                const startTime = new Date(details.date).getTime();

                const snapshot: MeetingSnapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context,
                    meetingMetadata: {
                        title: this.isMeaningfulTitle(details.title) ? details.title : undefined,
                        calendarEventId: details.calendarEventId,
                        source: details.source,
                    },
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }
    }

    private parseDurationToMs(duration: string): number {
        const parts = duration.split(':').map(part => Number.parseInt(part, 10));
        if (parts.some(part => Number.isNaN(part))) {
            return 0;
        }
        if (parts.length === 2) {
            return ((parts[0] * 60) + parts[1]) * 1000;
        }
        if (parts.length === 3) {
            return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
        }
        return 0;
    }
}
