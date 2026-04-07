import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const SESSIONS_DIR = join(homedir(), '.natively', 'sessions');
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');

export interface SessionIndexEntry {
  sessionId: string;
  meetingId: string;
  lastActiveAt: number;
  filepath: string;
}

export interface SessionIndex {
  sessions: SessionIndexEntry[];
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
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0];
}

function buildSessionFilename(session: PersistedSession): string {
  return `${formatDate(session.createdAt)}_meeting-${session.meetingId}.json`;
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

  async init(): Promise<void> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
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

      void this.save(snapshot).catch((error) => {
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
    if (!snapshot) return;

    await this.save(snapshot);
  }

  async save(session: PersistedSession): Promise<void> {
    await this.init();

    const filename = buildSessionFilename(session);
    const absoluteFilepath = join(SESSIONS_DIR, filename);

    await atomicWriteJson(absoluteFilepath, session);
    await this.updateIndex(session, filename);
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    const index = await this.loadIndex();
    const entry = index.sessions.find((item) => item.sessionId === sessionId);
    if (!entry) return null;

    try {
      const content = await fs.readFile(join(SESSIONS_DIR, entry.filepath), 'utf-8');
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
        await fs.unlink(join(SESSIONS_DIR, entry.filepath));
        deleted += 1;
      } catch {
        // ignore per-file cleanup errors
      }
    }

    await atomicWriteJson(INDEX_FILE, { sessions: retained });
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

    await atomicWriteJson(INDEX_FILE, index);
  }

  private async loadIndex(): Promise<SessionIndex> {
    await this.init();
    try {
      const content = await fs.readFile(INDEX_FILE, 'utf-8');
      const parsed = JSON.parse(content) as SessionIndex;
      return parsed && Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }
}
