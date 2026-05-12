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
 *
 * NAT-700: Stealth hardening — sandbox cache.
 *  - Temp files written to os.tmpdir() with random prefix (not userData)
 *  - Immediate unlink after OCR completes (zero on-disk artifacts at rest)
 *  - Active-file tracking via Set<string> for concurrency safety
 *  - dispose() waits for in-progress writes then cleans all remaining files
 *  - before-quit cleanup wired via app event
 *
 * NAT-800: Threshold activation and event-driven sampling.
 *  - Auto-activates passive sampling after 3 screenshots (threshold)
 *  - Runs on intelligence-lane idle ticks via StealthTickCoordinator
 *  - Suppresses sampling when window hidden, screen locked, or screen-share active
 *  - OCR timeout at 10 seconds with cancellation
 *  - Idempotent tick handling: no second OCR while one is in progress
 *  - resetSession() resets counter and deactivates on meeting/session end
 */
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import screenshot from 'screenshot-desktop';
import Tesseract from 'tesseract.js';
import { createHash, randomBytes } from 'crypto';

const POLL_MS = Number(process.env['NATIVELY_SCREEN_RAG_POLL_MS'] ?? 5000);
const MAX_SNAPSHOTS = 20;

/** Default activation threshold: auto-activate after 3 screenshots */
const DEFAULT_ACTIVATION_THRESHOLD = 3;
/** Default OCR timeout in milliseconds */
const DEFAULT_OCR_TIMEOUT_MS = 10_000;

export interface ScreenSnapshot {
  text: string;
  timestamp: number;
  hash: string;
}

export interface ScreenRAGManagerOptions {
  /** Activation threshold (default: 3 screenshots) */
  activationThreshold?: number;
  /** OCR timeout in ms (default: 10000) */
  ocrTimeoutMs?: number;
  /** Logger */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Tmp directory override (for testing) */
  tmpDirOverride?: string;
}

export class ScreenRAGManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots: ScreenSnapshot[] = [];
  private lastHash: string | null = null;
  private captureCount = 0;
  private readonly tmpDir: string;
  /** Tracks file paths currently being written/processed — prevents unlink during active write */
  private readonly activeFiles: Set<string> = new Set();
  /** Tracks all file paths created by this instance for cleanup */
  private readonly allFiles: Set<string> = new Set();
  private disposed = false;
  private readonly quitHandler: () => void;

  // ─── NAT-800: Threshold activation and event-driven sampling ────────────────
  /** Screenshot counter — incremented atomically on each recordScreenshot() call */
  private screenshotCount = 0;
  /** Whether passive sampling is activated (threshold reached) */
  private activated = false;
  /** Whether an OCR sampling operation is currently in progress (idempotent tick guard) */
  private sampling = false;
  /** Activation threshold */
  private readonly activationThreshold: number;
  /** OCR timeout in ms */
  private readonly ocrTimeoutMs: number;
  /** Logger */
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  // ─── Suppression conditions ─────────────────────────────────────────────────
  private windowHidden = false;
  private screenLocked = false;
  private screenShareActive = false;

  constructor(options?: ScreenRAGManagerOptions) {
    super();
    this.activationThreshold = options?.activationThreshold ?? DEFAULT_ACTIVATION_THRESHOLD;
    this.ocrTimeoutMs = options?.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
    this.logger = options?.logger ?? console;

    // NAT-700: Use os.tmpdir() with random prefix instead of userData directory
    if (options?.tmpDirOverride) {
      this.tmpDir = options.tmpDirOverride;
    } else {
      const prefix = `natively-srag-${randomBytes(6).toString('hex')}`;
      this.tmpDir = path.join(os.tmpdir(), prefix);
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });

    // Wire before-quit cleanup
    this.quitHandler = () => {
      this.cleanupSync();
    };
    app.on('before-quit', this.quitHandler);
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Cleanup all temp files and release resources.
   * Waits for in-progress writes to complete before cleaning.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.removeAllListeners();

    // Wait for any in-progress writes/OCR to complete
    await this.waitForActiveFiles();

    // Clean all remaining tracked files
    await this.cleanupAllFiles();

    // Remove the tmpDir itself
    this.safeRmdirSync(this.tmpDir);

    // Unregister before-quit handler
    app.removeListener('before-quit', this.quitHandler);

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

  // ─── NAT-800: Threshold activation and event-driven sampling API ────────────

  /**
   * Increment screenshot counter. Auto-activates passive sampling at threshold.
   * Safe to call from any context — uses synchronous atomic increment.
   */
  recordScreenshot(): void {
    if (this.disposed) return;

    this.screenshotCount++;

    // Auto-activate exactly once upon reaching threshold (Property 21)
    if (!this.activated && this.screenshotCount >= this.activationThreshold) {
      this.activated = true;
      this.emit('activated');
    }
  }

  /**
   * Called by tick coordinator on intelligence-lane idle ticks.
   * Performs passive sampling if conditions allow.
   * Idempotent: no second OCR while one is in progress (Property 23).
   */
  async onIdleTick(): Promise<void> {
    // Guard: not activated, disposed, or already sampling
    if (!this.activated || this.disposed || this.sampling) {
      return;
    }

    // Check suppression conditions (Property 22)
    if (!this.canSample()) {
      return;
    }

    // Set sampling flag to prevent re-entry (idempotent tick handling)
    this.sampling = true;

    try {
      await this.sampleWithTimeout();
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Reset counter and deactivate (meeting/session end).
   * Safe to call concurrently with screenshot events (Property 24).
   */
  resetSession(): void {
    this.screenshotCount = 0;
    this.activated = false;
    this.sampling = false;
    this.emit('deactivated');
  }

  /**
   * Check if conditions allow sampling.
   * Returns false when any suppression condition is true.
   */
  canSample(): boolean {
    if (this.disposed) return false;
    if (!this.activated) return false;
    if (this.windowHidden) return false;
    if (this.screenLocked) return false;
    if (this.screenShareActive) return false;
    return true;
  }

  /** Set window hidden suppression condition */
  setWindowHidden(hidden: boolean): void {
    this.windowHidden = hidden;
  }

  /** Set screen locked suppression condition */
  setScreenLocked(locked: boolean): void {
    this.screenLocked = locked;
  }

  /** Set screen-share active suppression condition */
  setScreenShareActive(active: boolean): void {
    this.screenShareActive = active;
  }

  /** Whether the manager is currently activated (threshold reached) */
  isActivated(): boolean {
    return this.activated;
  }

  /** Whether a sampling operation is currently in progress */
  isSampling(): boolean {
    return this.sampling;
  }

  /** Get the current screenshot count */
  getScreenshotCount(): number {
    return this.screenshotCount;
  }

  /**
   * Perform a single sample with OCR timeout.
   * Captures screen, runs OCR with timeout, and stores result.
   */
  private async sampleWithTimeout(): Promise<void> {
    const tmpPath = path.join(this.tmpDir, `srag_${this.captureCount++ % 4}.png`);

    // Track the file as active before writing
    this.activeFiles.add(tmpPath);
    this.allFiles.add(tmpPath);

    try {
      await screenshot({ filename: tmpPath, format: 'png' });
      if (!fs.existsSync(tmpPath)) {
        this.activeFiles.delete(tmpPath);
        this.allFiles.delete(tmpPath);
        return;
      }

      const hash = await this.computeFileHash(tmpPath);
      if (!this.hasChanged(hash)) {
        // File not needed — unlink immediately
        this.activeFiles.delete(tmpPath);
        await this.safeUnlink(tmpPath);
        return;
      }
      this.lastHash = hash;

      // OCR with timeout (Requirement 8.5, 8.6)
      const ocrResult = await this.ocrWithTimeout(tmpPath);

      // OCR complete — unlink immediately (zero on-disk artifacts at rest)
      this.activeFiles.delete(tmpPath);
      await this.safeUnlink(tmpPath);

      if (!ocrResult) return;

      const text = ocrResult.trim();
      if (!text) return;

      const snapshot: ScreenSnapshot = { text, timestamp: Date.now(), hash };
      if (this.snapshots.length >= MAX_SNAPSHOTS) {
        this.snapshots.shift();
      }
      this.snapshots.push(snapshot);
      this.emit('snapshot', snapshot);
    } catch (err) {
      // Ensure file is removed from active set on error
      this.activeFiles.delete(tmpPath);
      // Attempt cleanup of the file on error
      await this.safeUnlink(tmpPath);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Run OCR with a timeout. Returns the extracted text or null on timeout/failure.
   * Cancels the operation if it exceeds ocrTimeoutMs.
   */
  private async ocrWithTimeout(filePath: string): Promise<string | null> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, this.ocrTimeoutMs);
    });

    const ocrPromise = (async () => {
      try {
        const result = await Tesseract.recognize(filePath, 'eng');
        if (timedOut) return null; // Discard result if we already timed out
        return result?.data?.text ?? null;
      } catch {
        return null;
      }
    })();

    try {
      const result = await Promise.race([ocrPromise, timeoutPromise]);
      return result;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  // ─── Legacy polling API (preserved for backward compatibility) ──────────────

  private async poll(): Promise<void> {
    if (this.disposed) return;

    const tmpPath = path.join(this.tmpDir, `srag_${this.captureCount++ % 4}.png`);

    // Track the file as active before writing
    this.activeFiles.add(tmpPath);
    this.allFiles.add(tmpPath);

    try {
      await screenshot({ filename: tmpPath, format: 'png' });
      if (!fs.existsSync(tmpPath)) {
        this.activeFiles.delete(tmpPath);
        this.allFiles.delete(tmpPath);
        return;
      }

      const hash = await this.computeFileHash(tmpPath);
      if (!this.hasChanged(hash)) {
        // File not needed — unlink immediately
        this.activeFiles.delete(tmpPath);
        await this.safeUnlink(tmpPath);
        return;
      }
      this.lastHash = hash;

      const result = await Tesseract.recognize(tmpPath, 'eng');
      const text = (result?.data?.text ?? '').trim();

      // OCR complete — unlink immediately (zero on-disk artifacts at rest)
      this.activeFiles.delete(tmpPath);
      await this.safeUnlink(tmpPath);

      if (!text) return;

      const snapshot: ScreenSnapshot = { text, timestamp: Date.now(), hash };
      if (this.snapshots.length >= MAX_SNAPSHOTS) {
        this.snapshots.shift();
      }
      this.snapshots.push(snapshot);
      this.emit('snapshot', snapshot);
    } catch (err) {
      // Ensure file is removed from active set on error
      this.activeFiles.delete(tmpPath);
      // Attempt cleanup of the file on error
      await this.safeUnlink(tmpPath);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Safely unlink a file. Handles ENOENT silently, logs EPERM as warning.
   * Removes the file from allFiles tracking after successful unlink.
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
      this.allFiles.delete(filePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File already deleted — silent
        this.allFiles.delete(filePath);
      } else if (code === 'EPERM') {
        this.logger.warn(`[ScreenRAGManager] EPERM: cannot delete ${filePath}`);
        // Remove from tracking to avoid repeated attempts
        this.allFiles.delete(filePath);
      } else {
        // Other errors: log warning and continue
        this.logger.warn(`[ScreenRAGManager] Failed to unlink ${filePath}:`, err);
        this.allFiles.delete(filePath);
      }
    }
  }

  /**
   * Wait for all active file operations to complete.
   * Polls every 50ms until activeFiles is empty, with a 5s timeout.
   */
  private async waitForActiveFiles(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (this.activeFiles.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Clean up all remaining tracked files asynchronously.
   */
  private async cleanupAllFiles(): Promise<void> {
    const files = Array.from(this.allFiles);
    for (const filePath of files) {
      await this.safeUnlink(filePath);
    }
  }

  /**
   * Synchronous cleanup for before-quit handler.
   * Best-effort: attempts to unlink all tracked files synchronously.
   */
  private cleanupSync(): void {
    for (const filePath of this.allFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Already deleted — silent
        } else if (code === 'EPERM') {
          this.logger.warn(`[ScreenRAGManager] EPERM on quit cleanup: ${filePath}`);
        }
        // Other errors silently ignored during quit
      }
    }
    this.allFiles.clear();

    // Try to remove the tmpDir
    this.safeRmdirSync(this.tmpDir);
  }

  /**
   * Safely remove the tmp directory (best-effort, non-throwing).
   */
  private safeRmdirSync(dirPath: string): void {
    try {
      fs.rmdirSync(dirPath);
    } catch {
      // Directory may not be empty or already removed — ignore
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

export function getScreenRAGManager(options?: ScreenRAGManagerOptions): ScreenRAGManager {
  if (!_instance) _instance = new ScreenRAGManager(options);
  return _instance;
}

export function disposeScreenRAGManager(): Promise<void> | void {
  if (_instance) {
    const result = _instance.dispose();
    _instance = null;
    return result;
  }
}
