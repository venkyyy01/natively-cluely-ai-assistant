import { app } from "electron"
import path from "path"
import fsPromises from "fs/promises"
import { exitAfterCriticalFailure } from '../processFailure'
import { redactStealthSubstrings } from '../stealth/logRedactor'

// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });

process.on('uncaughtException', (err) => {
  void exitAfterCriticalFailure(
    logToFileAsync('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err)),
  )
});

process.on('unhandledRejection', (reason, promise) => {
  void exitAfterCriticalFailure(
    logToFileAsync('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason)),
  )
});

// NAT-011 / audit S-5: do NOT write logs to ~/Documents in release builds
// (it leaks the product's presence to anyone browsing the home folder, and
// the file name "natively_debug.log" itself is a fingerprint). The path is
// now under `userData/Logs/` and dated, and *all* file logging is gated
// behind `NATIVELY_DEBUG_LOG=1` for non-development builds. Dev builds keep
// file logging on for convenience.
const isDev = process.env.NODE_ENV === "development";
const fileLoggingExplicitlyEnabled = (() => {
  const raw = process.env.NATIVELY_DEBUG_LOG;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
})();
export const fileLoggingEnabled = isDev || fileLoggingExplicitlyEnabled;

export function buildLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(app.getPath('userData'), 'Logs', `natively-${date}.log`);
}
const logFile = buildLogFilePath();
export const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const LOG_ROTATION_COUNT = 3; // Keep 3 rotated files

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

// Log queue for non-blocking async writes
const LOG_QUEUE_MAX_SIZE = 10000;
let logQueue: string[] = [];
let logFlushInProgress = false;
let logRotationCheckPending = false;
let droppedLogMessages = 0;
let logDirEnsured = false;

async function ensureLogDirOnce(): Promise<void> {
  if (logDirEnsured) return;
  try {
    await fsPromises.mkdir(path.dirname(logFile), { recursive: true });
    logDirEnsured = true;
  } catch (error) {
    // Surface to stderr but keep the queue draining so we don't spin.
    originalError('[Logging] Failed to create log directory:', error);
    logDirEnsured = true;
  }
}

/**
 * Rotate log files asynchronously if they exceed the maximum size.
 * Keeps LOG_ROTATION_COUNT rotated files (e.g., .log.1, .log.2, .log.3)
 */
async function rotateLogsIfNeededAsync(): Promise<void> {
  if (logRotationCheckPending) return;
  logRotationCheckPending = true;

  try {
    // Check if log file exists and exceeds max size
    try {
      const stats = await fsPromises.stat(logFile);
      if (stats.size < LOG_MAX_SIZE_BYTES) return;

      // Rotate existing files: .log.3 -> delete, .log.2 -> .log.3, .log.1 -> .log.2, .log -> .log.1
      for (let i = LOG_ROTATION_COUNT; i >= 1; i--) {
        const rotatedPath = `${logFile}.${i}`;
        try {
          await fsPromises.access(rotatedPath);
          if (i === LOG_ROTATION_COUNT) {
            await fsPromises.unlink(rotatedPath);
          } else {
            await fsPromises.rename(rotatedPath, `${logFile}.${i + 1}`);
          }
        } catch {
          // File doesn't exist, skip
        }
      }

      // Rename current log to .log.1
      await fsPromises.rename(logFile, `${logFile}.1`);
      originalLog(`[LogRotation] Rotated debug log (size was ${Math.round(stats.size / 1024 / 1024)}MB)`);
    } catch {
      // Log file doesn't exist yet, nothing to rotate
    }
  } catch (e) {
    originalError('[LogRotation] Failed to rotate logs:', e);
  } finally {
    logRotationCheckPending = false;
  }
}

/**
 * Flush the log queue to disk asynchronously
 */
async function flushLogQueue(): Promise<void> {
  if (logFlushInProgress || logQueue.length === 0) return;
  logFlushInProgress = true;

  const pending = logQueue.splice(0, logQueue.length);
  if (pending.length === 0) {
    logFlushInProgress = false;
    return;
  }

  try {
    await ensureLogDirOnce();
    await rotateLogsIfNeededAsync();
    if (droppedLogMessages > 0) {
      pending.unshift(`[Logging] Dropped ${droppedLogMessages} log messages because the log queue exceeded ${LOG_QUEUE_MAX_SIZE} entries.`);
      droppedLogMessages = 0;
    }
    // NAT-011 / audit S-5: every line must pass through the stealth
    // redactor before it touches disk. We do this here (rather than at
    // enqueue time) so the in-memory queue and stdout/stderr remain
    // unaffected — only the persisted file is sanitized.
    const content = pending
      .map(msg => `${new Date().toISOString()} ${redactStealthSubstrings(msg)}`)
      .join('\n') + '\n';
    await fsPromises.appendFile(logFile, content);
  } catch (error) {
    originalError('[Logging] Failed to append debug log:', error);
  } finally {
    logFlushInProgress = false;
    if (logQueue.length > 0) {
      void flushLogQueue();
    }
  }
}

/**
 * Non-blocking async log to file. NAT-011: in release builds without
 * `NATIVELY_DEBUG_LOG=1`, this is a no-op so we leave nothing on disk.
 */
export async function logToFileAsync(msg: string): Promise<void> {
  if (!fileLoggingEnabled) return;
  if (logQueue.length >= LOG_QUEUE_MAX_SIZE) {
    const dropped = logQueue.length - LOG_QUEUE_MAX_SIZE + 1;
    logQueue.splice(0, dropped);
    droppedLogMessages += dropped;
  }
  logQueue.push(msg);
  void flushLogQueue();
}

// Synchronous version for backwards compatibility with console overrides
export function logToFile(msg: string): void {
  void logToFileAsync(msg);
}

export function isEnvFlagEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

console.log = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[LOG] ' + msg);
  try {
    originalLog.apply(console, args);
  } catch { }
};

console.warn = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[WARN] ' + msg);
  try {
    originalWarn.apply(console, args);
  } catch { }
};

console.error = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[ERROR] ' + msg);
  try {
    originalError.apply(console, args);
  } catch { }
};
