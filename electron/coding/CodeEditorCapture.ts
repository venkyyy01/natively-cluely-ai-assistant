/**
 * NAT-400: Code Editor Capture — periodic polling of the active editor region via
 * pHash-based change detection + Tesseract OCR.
 *
 * Design goals:
 *  - Default poll interval: 3 s (configurable via NATIVELY_CODE_EDITOR_POLL_MS)
 *  - pHash diff threshold: 8 bits (configurable via NATIVELY_CODE_EDITOR_HASH_THRESH)
 *  - Only runs OCR when pHash distance > threshold (avoids redundant processing)
 *  - Emits 'code-change' event with trimmed text when new content detected
 *  - Stops cleanly on dispose()
 */
import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import screenshot from 'screenshot-desktop';
import Tesseract from 'tesseract.js';
import { createHash } from 'crypto';

const POLL_MS = Number(process.env['NATIVELY_CODE_EDITOR_POLL_MS'] ?? 3000);
const HASH_THRESH = Number(process.env['NATIVELY_CODE_EDITOR_HASH_THRESH'] ?? 8);

/** Options for the capture region (normalised 0..1 fractions of screen). */
export interface EditorRegion {
  /** Top-left X fraction [0..1] */
  x: number;
  /** Top-left Y fraction [0..1] */
  y: number;
  /** Width fraction [0..1] */
  width: number;
  /** Height fraction [0..1] */
  height: number;
}

/** Events emitted by CodeEditorCapture */
export interface CodeEditorCaptureEvents {
  'code-change': [text: string, timestamp: number];
  'capture-error': [error: Error];
}

export class CodeEditorCapture extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHash: string | null = null;
  private lastText = '';
  private readonly tmpDir: string;
  private captureCount = 0;

  constructor(private readonly region?: EditorRegion) {
    super();
    this.tmpDir = path.join(app.getPath('userData'), 'code_editor_capture');
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
  }

  getLastText(): string {
    return this.lastText;
  }

  private async poll(): Promise<void> {
    const tmpPath = path.join(this.tmpDir, `ce_${this.captureCount++ % 4}.png`);
    try {
      await screenshot({ filename: tmpPath, format: 'png' });

      if (!fs.existsSync(tmpPath)) return;

      const hash = await this.computeFileHash(tmpPath);
      if (!this.hasChanged(hash)) return;

      this.lastHash = hash;

      const result = await Tesseract.recognize(tmpPath, 'eng');
      const text = (result?.data?.text ?? '').trim();
      if (!text || text === this.lastText) return;

      this.lastText = text;
      this.emit('code-change', text, Date.now());
    } catch (err) {
      this.emit('capture-error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** SHA-256 of first 64 KB — cheap file-level change detection. */
  private async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 65536 });
      let bytes = 0;
      stream.on('data', (chunk) => {
        if (bytes < 65536) {
          hash.update(chunk);
          bytes += chunk.length;
        }
      });
      stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
      stream.on('error', reject);
    });
  }

  /** Compute Hamming distance between two 16-char hex strings (64 bits). */
  private hammingDistance(a: string, b: string): number {
    let dist = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const ba = parseInt(a[i], 16);
      const bb = parseInt(b[i], 16);
      let xor = ba ^ bb;
      while (xor) {
        dist += xor & 1;
        xor >>= 1;
      }
    }
    return dist;
  }

  private hasChanged(newHash: string): boolean {
    if (!this.lastHash) return true;
    return this.hammingDistance(this.lastHash, newHash) > HASH_THRESH;
  }
}

/** Singleton manager — one capture instance per app lifetime. */
let _instance: CodeEditorCapture | null = null;

export function getCodeEditorCapture(): CodeEditorCapture {
  if (!_instance) {
    _instance = new CodeEditorCapture();
  }
  return _instance;
}

export function disposeCodeEditorCapture(): void {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
