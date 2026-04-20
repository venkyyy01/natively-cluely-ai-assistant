import { createHash } from 'node:crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  PersistedConsciousThreadState,
  PersistedAnswerHypothesisState,
  PersistedDesignStateState,
  PersistedConsciousResponsePreferenceState,
} from '../conscious';

const SESSIONS_DIR_ENV = 'NATIVELY_SESSIONS_DIR';

export interface SessionIndexEntry {
  sessionId: string;
  meetingId: string;
  lastActiveAt: number;
  filepath: string;
}

export interface SessionIndex {
  sessions: SessionIndexEntry[];
}

export interface SessionEvent {
  eventId: string;
  type: 'transcript' | 'usage' | 'checkpoint' | 'thread-action' | 'reset';
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface PersistedSessionMemoryEntryValue {
  kind: 'transcript' | 'usage' | 'pinned-item' | 'constraint' | 'epoch-summary' | 'active-thread';
  text?: string;
  timestamp: number;
  speaker?: string;
  final?: boolean;
  confidence?: number;
  label?: string;
  usageType?: 'assist' | 'followup' | 'chat' | 'followup_questions';
  question?: string;
  answer?: string;
  items?: string[];
  normalized?: string;
  raw?: string;
  constraintType?: string;
  topic?: string;
  goal?: string;
  phase?: string;
  turnCount?: number;
}

export interface PersistedSessionMemoryEntry {
  id: string;
  sizeBytes: number;
  createdAt: number;
  value: PersistedSessionMemoryEntryValue;
}

export interface PersistedSessionMemoryState {
  hot: PersistedSessionMemoryEntry[];
  warm: PersistedSessionMemoryEntry[];
  cold: PersistedSessionMemoryEntry[];
}

export interface PersistedSession {
  version: 1;
  sessionId: string;
  meetingId: string;
  createdAt: number;
  lastActiveAt: number;
  activeThread: {
    id: string;
    topic: string;
    goal?: string;
    phase?: string;
    turnCount: number;
  } | null;
  suspendedThreads: Array<{
    id: string;
    topic: string;
    goal?: string;
    suspendedAt: number;
  }>;
  pinnedItems: Array<{
    id: string;
    text: string;
    pinnedAt: number;
    label?: string;
  }>;
  constraints: Array<{
    type: string;
    raw: string;
    normalized: string;
  }>;
  epochSummaries: string[];
  responseHashes: string[];
  consciousState?: {
    threadState?: PersistedConsciousThreadState;
    hypothesisState?: PersistedAnswerHypothesisState;
    designState?: PersistedDesignStateState;
    preferenceState?: PersistedConsciousResponsePreferenceState;
  };
  memoryState?: PersistedSessionMemoryState;
}

interface SessionPersistenceOptions {
  sessionsDirectory?: string;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0];
}

function sanitizeMeetingIdForFilename(meetingId: string): string {
  const readable = meetingId
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  const digest = createHash('sha256')
    .update(meetingId)
    .digest('hex')
    .slice(0, 12);

  return `${readable || 'meeting'}-${digest}`;
}

function buildSessionFilename(session: PersistedSession): string {
  const sanitizedId = sanitizeMeetingIdForFilename(session.meetingId);
  return `${formatDate(session.createdAt)}_meeting-${sanitizedId}.json`;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  await fs.writeFile(tmpPath, payload, 'utf-8');

  // fsync to reduce partial-write risk before rename
  const handle = await fs.open(tmpPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tmpPath, filePath);
}

export class SessionPersistence {
  private saveTimeout: NodeJS.Timeout | null = null;
  private pendingSession: PersistedSession | null = null;
  private inFlightSave: Promise<void> = Promise.resolve();
  private readonly sessionsDir: string;
  private readonly indexFile: string;

  constructor(options: SessionPersistenceOptions = {}) {
    this.sessionsDir = options.sessionsDirectory ?? process.env[SESSIONS_DIR_ENV] ?? join(homedir(), '.natively', 'sessions');
    this.indexFile = join(this.sessionsDir, 'index.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  scheduleSave(session: PersistedSession): void {
    this.pendingSession = session;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      const snapshot = this.pendingSession;
      this.saveTimeout = null;
      this.pendingSession = null;
      if (!snapshot) return;

      this.inFlightSave = this.save(snapshot).catch((error) => {
        console.warn('[SessionPersistence] Scheduled save failed:', error);
      });
    }, 2000);
  }

  async flushScheduledSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    const snapshot = this.pendingSession;
    this.pendingSession = null;

    await this.inFlightSave;

    if (!snapshot) return;
    await this.save(snapshot);
  }

  async save(session: PersistedSession): Promise<void> {
    await this.init();

    const filename = buildSessionFilename(session);
    const absoluteFilepath = join(this.sessionsDir, filename);

    await atomicWriteJson(absoluteFilepath, session);
    await this.updateIndex(session, filename);
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    const index = await this.loadIndex();
    const entry = index.sessions.find((item) => item.sessionId === sessionId);
    if (!entry) return null;

    try {
      const content = await fs.readFile(join(this.sessionsDir, entry.filepath), 'utf-8');
      return JSON.parse(content) as PersistedSession;
    } catch {
      return null;
    }
  }

  async loadRecent(limit: number = 5): Promise<PersistedSession[]> {
    const index = await this.loadIndex();
    const sorted = [...index.sessions]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, limit);

    const sessions: PersistedSession[] = [];
    for (const entry of sorted) {
      const loaded = await this.load(entry.sessionId);
      if (loaded) sessions.push(loaded);
    }

    return sessions;
  }

  async findByMeeting(meetingId: string): Promise<PersistedSession | null> {
    const index = await this.loadIndex();
    const entry = index.sessions.find((item) => item.meetingId === meetingId);
    if (!entry) return null;
    return this.load(entry.sessionId);
  }

  async cleanup(maxAgeDays: number = 30): Promise<number> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const index = await this.loadIndex();

    let deleted = 0;
    const retained: SessionIndexEntry[] = [];

    for (const entry of index.sessions) {
      if (entry.lastActiveAt >= cutoff) {
        retained.push(entry);
        continue;
      }

      try {
        await fs.unlink(join(this.sessionsDir, entry.filepath));
        deleted += 1;
      } catch {
        // ignore per-file cleanup errors
      }
    }

    await atomicWriteJson(this.indexFile, { sessions: retained });
    return deleted;
  }

  private async updateIndex(session: PersistedSession, relativeFilepath: string): Promise<void> {
    const index = await this.loadIndex();
    const entry: SessionIndexEntry = {
      sessionId: session.sessionId,
      meetingId: session.meetingId,
      lastActiveAt: session.lastActiveAt,
      filepath: relativeFilepath,
    };

    const existingIdx = index.sessions.findIndex((item) => item.sessionId === session.sessionId);
    if (existingIdx >= 0) {
      index.sessions[existingIdx] = entry;
    } else {
      index.sessions.push(entry);
    }

    await atomicWriteJson(this.indexFile, index);
  }

  private async loadIndex(): Promise<SessionIndex> {
    await this.init();
    try {
      const content = await fs.readFile(this.indexFile, 'utf-8');
      const parsed = JSON.parse(content) as SessionIndex;
      return parsed && Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  // NAT-059: event-sourced session persistence

  private buildEventLogPath(sessionId: string): string {
    const sanitized = sanitizeMeetingIdForFilename(sessionId);
    return join(this.sessionsDir, `${sanitized}.events.log`);
  }

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    await this.init();
    const logPath = this.buildEventLogPath(sessionId);
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(logPath, line, 'utf-8');
  }

  async replayEvents(sessionId: string): Promise<SessionEvent[]> {
    const logPath = this.buildEventLogPath(sessionId);
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch {
      return [];
    }
  }

  async snapshotEvents(sessionId: string, session: PersistedSession): Promise<void> {
    await this.init();
    const logPath = this.buildEventLogPath(sessionId);
    const snapshotEvent: SessionEvent = {
      eventId: `snapshot-${Date.now()}`,
      type: 'checkpoint',
      timestamp: Date.now(),
      payload: { session },
    };
    const line = JSON.stringify(snapshotEvent) + '\n';
    await fs.writeFile(logPath, line, 'utf-8');
  }

  async getEventCount(sessionId: string): Promise<number> {
    const events = await this.replayEvents(sessionId);
    return events.length;
  }

  async replayUntil(sessionId: string, eventId: string): Promise<SessionEvent[]> {
    const allEvents = await this.replayEvents(sessionId);
    const idx = allEvents.findIndex((e) => e.eventId === eventId);
    return idx >= 0 ? allEvents.slice(0, idx + 1) : allEvents;
  }
}
