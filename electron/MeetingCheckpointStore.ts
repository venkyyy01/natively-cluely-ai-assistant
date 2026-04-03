import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { MeetingSnapshot } from './SessionTracker';

interface PersistedMeetingCheckpoint {
  meetingId: string;
  snapshot: MeetingSnapshot;
  updatedAt: string;
}

function resolveCheckpointDirectory(): string {
  try {
    const { app } = require('electron') as { app?: { getPath?: (name: string) => string } };
    const userDataPath = app?.getPath?.('userData');
    if (userDataPath) {
      return path.join(userDataPath, 'meeting-checkpoints');
    }
  } catch {
    // Tests and non-Electron callers fall back to tmpdir.
  }

  return path.join(os.tmpdir(), 'natively-meeting-checkpoints');
}

export class MeetingCheckpointStore {
  private readonly baseDir: string;

  constructor(baseDir: string = resolveCheckpointDirectory()) {
    this.baseDir = baseDir;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private filePath(meetingId: string): string {
    return path.join(this.baseDir, `${meetingId}.json`);
  }

  public async saveSnapshot(meetingId: string, snapshot: MeetingSnapshot): Promise<void> {
    await this.ensureDir();

    const filePath = this.filePath(meetingId);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    const payload: PersistedMeetingCheckpoint = {
      meetingId,
      snapshot,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  public async loadSnapshot(meetingId: string): Promise<MeetingSnapshot | null> {
    try {
      const raw = await fs.readFile(this.filePath(meetingId), 'utf8');
      const parsed = JSON.parse(raw) as PersistedMeetingCheckpoint;
      return parsed.snapshot ?? null;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  public async listMeetingIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.replace(/\.json$/, ''));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  public async removeSnapshot(meetingId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(meetingId));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
