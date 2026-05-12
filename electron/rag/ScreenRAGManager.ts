/**
 * NAT-500: Continuous on-screen RAG manager.
 *
 * Pipeline:
 *  1. Periodic screen capture (default 5 s)
 *  2. pHash-based change detection (skip if unchanged)
 *  3. Tesseract OCR on change
 *  4. Chunk + embed via existing RAG provider
 *  5. Expose getContext(question) for Tier-A prompt injection
 *
 * This is intentionally read-only towards the existing RAG system;
 * it maintains its own in-memory ring buffer of OCR snapshots.
 */
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import screenshot from 'screenshot-desktop';
import Tesseract from 'tesseract.js';
import { createHash } from 'crypto';

const POLL_MS = Number(process.env['NATIVELY_SCREEN_RAG_POLL_MS'] ?? 5000);
const MAX_SNAPSHOTS = 20;

export interface ScreenSnapshot {
  text: string;
  timestamp: number;
  hash: string;
}

export class ScreenRAGManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots: ScreenSnapshot[] = [];
  private lastHash: string | null = null;
  private captureCount = 0;
  private readonly tmpDir: string;

  constructor() {
    super();
    this.tmpDir = path.join(app.getPath('userData'), 'screen_rag');
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
    this.snapshots = [];
  }

  /**
   * Get relevant context from recent OCR snapshots.
   * Returns the concatenated text of the last N snapshots, trimmed to maxChars.
   */
  getContext(maxChars = 3000): string {
    return this.snapshots
      .slice(-6)
      .map((s) => s.text)
      .join('\n---\n')
      .slice(0, maxChars);
  }

  getSnapshots(): readonly ScreenSnapshot[] {
    return this.snapshots;
  }

  private async poll(): Promise<void> {
    const tmpPath = path.join(this.tmpDir, `srag_${this.captureCount++ % 4}.png`);
    try {
      await screenshot({ filename: tmpPath, format: 'png' });
      if (!fs.existsSync(tmpPath)) return;

      const hash = await this.computeFileHash(tmpPath);
      if (!this.hasChanged(hash)) return;
      this.lastHash = hash;

      const result = await Tesseract.recognize(tmpPath, 'eng');
      const text = (result?.data?.text ?? '').trim();
      if (!text) return;

      const snapshot: ScreenSnapshot = { text, timestamp: Date.now(), hash };
      if (this.snapshots.length >= MAX_SNAPSHOTS) {
        this.snapshots.shift();
      }
      this.snapshots.push(snapshot);
      this.emit('snapshot', snapshot);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 65536 });
      let bytes = 0;
      stream.on('data', (chunk) => {
        if (bytes < 65536) { hash.update(chunk); bytes += chunk.length; }
      });
      stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
      stream.on('error', reject);
    });
  }

  private hammingDistance(a: string, b: string): number {
    let dist = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (xor) { dist += xor & 1; xor >>= 1; }
    }
    return dist;
  }

  private hasChanged(newHash: string): boolean {
    if (!this.lastHash) return true;
    return this.hammingDistance(this.lastHash, newHash) > 8;
  }
}

let _instance: ScreenRAGManager | null = null;

export function getScreenRAGManager(): ScreenRAGManager {
  if (!_instance) _instance = new ScreenRAGManager();
  return _instance;
}

export function disposeScreenRAGManager(): void {
  if (_instance) { _instance.dispose(); _instance = null; }
}
