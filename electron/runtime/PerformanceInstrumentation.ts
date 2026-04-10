import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PerformanceMetricRecord {
  metric: string;
  recordedAt: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

interface PerformanceInstrumentationOptions {
  logDirectory?: string;
  logger?: Pick<Console, 'warn'>;
  now?: () => number;
}

const BENCHMARK_DIR_ENV = 'NATIVELY_BENCHMARK_DIR';
const BENCHMARK_FILE_NAME = 'performance-metrics.jsonl';

let sharedInstrumentation: PerformanceInstrumentation | null = null;

function getDefaultLogDirectory(): string {
  return process.env[BENCHMARK_DIR_ENV] || join(homedir(), '.natively', 'benchmarks');
}

export class PerformanceInstrumentation {
  private readonly logDirectory: string;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly now: () => number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: PerformanceInstrumentationOptions = {}) {
    this.logDirectory = options.logDirectory ?? getDefaultLogDirectory();
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  getLogDirectory(): string {
    return this.logDirectory;
  }

  getLogFilePath(): string {
    return join(this.logDirectory, BENCHMARK_FILE_NAME);
  }

  recordEvent(metric: string, metadata?: Record<string, unknown>): void {
    this.enqueueWrite({
      metric,
      recordedAt: this.now(),
      metadata,
    });
  }

  recordDuration(
    metric: string,
    startedAt: number,
    metadata?: Record<string, unknown>,
  ): void {
    this.recordMeasurement(metric, this.now() - startedAt, metadata);
  }

  recordMeasurement(
    metric: string,
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): void {
    this.enqueueWrite({
      metric,
      recordedAt: this.now(),
      durationMs: Math.max(0, durationMs),
      metadata,
    });
  }

  async readAll(): Promise<PerformanceMetricRecord[]> {
    try {
      const content = await fs.readFile(this.getLogFilePath(), 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as PerformanceMetricRecord);
    } catch {
      return [];
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueWrite(record: PerformanceMetricRecord): void {
    const payload = `${JSON.stringify(record)}\n`;
    const logFilePath = this.getLogFilePath();

    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(dirname(logFilePath), { recursive: true });
        await fs.appendFile(logFilePath, payload, 'utf-8');
      })
      .catch((error) => {
        this.logger.warn('[PerformanceInstrumentation] Failed to append metric record:', error);
      });
  }
}

export function getPerformanceInstrumentation(): PerformanceInstrumentation {
  if (!sharedInstrumentation) {
    sharedInstrumentation = new PerformanceInstrumentation();
  }

  return sharedInstrumentation;
}

export function setPerformanceInstrumentationForTesting(
  instrumentation: PerformanceInstrumentation | null,
): void {
  sharedInstrumentation = instrumentation;
}
