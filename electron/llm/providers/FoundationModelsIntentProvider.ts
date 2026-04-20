import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';

import type { ConversationIntent, IntentResult } from '../IntentClassifier';
import { getAnswerShapeGuidance } from '../IntentClassifier';
import { isOptimizationActive } from '../../config/optimizations';
import { resolveFoundationModelsIntentHelperPath } from './FoundationModelsIntentHelperPath';
import {
  FOUNDATION_INTENT_ALLOWED_INTENTS,
  FOUNDATION_INTENT_PROMPT_VERSION,
  FOUNDATION_INTENT_SCHEMA_VERSION,
} from './FoundationIntentPromptAssets';
import {
  createIntentProviderError,
  type IntentClassificationInput,
  type IntentInferenceProvider,
  type IntentProviderErrorType,
} from './IntentInferenceProvider';

const INTENT_CANDIDATES: ConversationIntent[] = [...FOUNDATION_INTENT_ALLOWED_INTENTS];

interface FoundationIntentHelperRequest {
  requestId?: string;
  version: 1;
  question: string;
  preparedTranscript: string;
  assistantResponseCount: number;
  promptVersion: string;
  schemaVersion: string;
  locale?: string;
  candidateIntents: ConversationIntent[];
}

interface FoundationIntentHelperSuccessEnvelope {
  requestId?: string | null;
  ok: true;
  intent: string;
  confidence: number;
  answerShape?: string;
  provider?: string;
}

interface FoundationIntentHelperErrorEnvelope {
  requestId?: string | null;
  ok: false;
  errorType?: IntentProviderErrorType;
  message?: string;
}

type FoundationIntentHelperEnvelope = FoundationIntentHelperSuccessEnvelope | FoundationIntentHelperErrorEnvelope;

interface HelperCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FoundationModelsIntentProviderOptions {
  helperPathResolver?: () => string | null;
  helperRunner?: (helperPath: string, request: FoundationIntentHelperRequest, timeoutMs: number) => Promise<HelperCommandResult>;
  localeResolver?: () => string | null;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  isOptimizationEnabled?: (flag: 'useFoundationModelsIntent') => boolean;
  /** When set, overrides `NATIVELY_FOUNDATION_PERSISTENT` for tests. */
  usePersistentHelper?: boolean;
}

const DEFAULT_TIMEOUT_MS = 2600;
const MAX_COMPACT_TRANSCRIPT_LINES = 6;
const MAX_COMPACT_TRANSCRIPT_CHARS = 1200;
const PERSISTENT_MAX_SPAWNS_PER_WINDOW = 5;
const PERSISTENT_SPAWN_WINDOW_MS = 60_000;

function compactPreparedTranscript(preparedTranscript: string, question: string): string {
  const normalizedTranscript = preparedTranscript
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const dialogueLines = normalizedTranscript.filter((line) => /^\[(INTERVIEWER|ASSISTANT|ME|USER)\]/i.test(line));
  const compactLines = (dialogueLines.length > 0 ? dialogueLines : normalizedTranscript)
    .slice(-MAX_COMPACT_TRANSCRIPT_LINES);

  const fallbackQuestion = question.trim() ? [`[INTERVIEWER]: ${question.trim()}`] : [];
  const compactTranscript = (compactLines.length > 0 ? compactLines : fallbackQuestion).join('\n');

  if (compactTranscript.length <= MAX_COMPACT_TRANSCRIPT_CHARS) {
    return compactTranscript;
  }

  return compactTranscript.slice(compactTranscript.length - MAX_COMPACT_TRANSCRIPT_CHARS).trim();
}

function isConversationIntent(value: string): value is ConversationIntent {
  return INTENT_CANDIDATES.includes(value as ConversationIntent);
}

function mapHelperErrorType(code: unknown): IntentProviderErrorType {
  if (
    code === 'unavailable'
    || code === 'model_not_ready'
    || code === 'unsupported_locale'
    || code === 'rate_limited'
    || code === 'refusal'
    || code === 'timeout'
    || code === 'invalid_response'
    || code === 'unknown'
  ) {
    return code;
  }

  return 'unknown';
}

/** Prefer structured JSON on stderr; keep narrow substring fallbacks only when JSON is absent. */
export function mapExitFailure(stderr: string): IntentProviderErrorType {
  const trimmed = stderr.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string; errorType?: string };
      const code = parsed.kind ?? parsed.errorType;
      if (typeof code === 'string' && code.length > 0) {
        return mapHelperErrorType(code);
      }
    } catch {
      // fall through to heuristics
    }
  }

  const normalized = stderr.toLowerCase();
  if (normalized.includes('model_not_ready') || normalized.includes('model not ready')) {
    return 'model_not_ready';
  }
  if (normalized.includes('unsupported_locale') || normalized.includes('unsupported locale')) {
    return 'unsupported_locale';
  }
  if (normalized.includes('timeout')) {
    return 'timeout';
  }
  if (normalized.includes('unavailable')) {
    return 'unavailable';
  }
  if (normalized.includes('refusal')) {
    return 'refusal';
  }
  if (normalized.includes('rate_limited') || /\brate limit/i.test(stderr)) {
    return 'rate_limited';
  }
  return 'unknown';
}

function envPersistentEnabled(): boolean {
  const v = process.env.NATIVELY_FOUNDATION_PERSISTENT?.toLowerCase() ?? '';
  return v === '1' || v === 'true' || v === 'yes';
}

type PendingPersistent = {
  resolve: (value: HelperCommandResult) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class FoundationModelsIntentProvider implements IntentInferenceProvider {
  readonly name = 'foundation';

  private readonly helperPathResolver: () => string | null;
  private readonly helperRunner: (helperPath: string, request: FoundationIntentHelperRequest, timeoutMs: number) => Promise<HelperCommandResult>;
  private readonly localeResolver: () => string | null;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly isOptimizationEnabled: (flag: 'useFoundationModelsIntent') => boolean;
  private readonly usePersistentHelper: boolean;

  private persistentChild: ChildProcess | null = null;
  private persistentLineReader: readline.Interface | null = null;
  private persistentStderr = '';
  private readonly pendingByRequestId = new Map<string, PendingPersistent>();
  private persistentSpawnCount = 0;
  private persistentWindowStart = 0;

  constructor(options: FoundationModelsIntentProviderOptions = {}) {
    this.helperPathResolver = options.helperPathResolver ?? (() => resolveFoundationModelsIntentHelperPath());
    this.helperRunner = options.helperRunner ?? ((helperPath, request, timeoutMs) => this.runHelperDispatch(helperPath, request, timeoutMs));
    this.localeResolver = options.localeResolver ?? (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().locale || null;
      } catch {
        return null;
      }
    });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.isOptimizationEnabled = options.isOptimizationEnabled ?? ((flag: 'useFoundationModelsIntent'): boolean => isOptimizationActive(flag));
    this.usePersistentHelper = options.usePersistentHelper ?? envPersistentEnabled();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.isOptimizationEnabled('useFoundationModelsIntent')) {
      return false;
    }

    if (this.platform !== 'darwin' || this.arch !== 'arm64') {
      return false;
    }

    return this.helperPathResolver() !== null;
  }

  async classify(input: IntentClassificationInput): Promise<IntentResult> {
    const available = await this.isAvailable();
    if (!available) {
      throw createIntentProviderError('unavailable', 'Foundation intent provider unavailable on this host');
    }

    const helperPath = this.helperPathResolver();
    if (!helperPath) {
      throw createIntentProviderError('unavailable', 'Foundation intent helper binary not found');
    }

    const requestId = randomUUID();
    const request: FoundationIntentHelperRequest = {
      requestId,
      version: 1,
      question: input.lastInterviewerTurn ?? '',
      preparedTranscript: compactPreparedTranscript(input.preparedTranscript, input.lastInterviewerTurn ?? ''),
      assistantResponseCount: input.assistantResponseCount,
      promptVersion: FOUNDATION_INTENT_PROMPT_VERSION,
      schemaVersion: FOUNDATION_INTENT_SCHEMA_VERSION,
      locale: this.localeResolver() ?? undefined,
      candidateIntents: INTENT_CANDIDATES,
    };

    const commandResult = await this.helperRunner(helperPath, request, this.timeoutMs);

    if (!commandResult.stdout.trim()) {
      if (commandResult.exitCode !== 0) {
        const failureCode = mapExitFailure(commandResult.stderr);
        throw createIntentProviderError(failureCode, commandResult.stderr.trim() || 'Foundation helper exited with no output');
      }
      throw createIntentProviderError('invalid_response', 'Foundation helper returned empty output');
    }

    let envelope: FoundationIntentHelperEnvelope;
    try {
      envelope = JSON.parse(commandResult.stdout) as FoundationIntentHelperEnvelope;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw createIntentProviderError('invalid_response', `Foundation helper returned invalid JSON: ${message}`);
    }

    if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw createIntentProviderError('invalid_response', 'Foundation helper response envelope missing ok flag');
    }

    if (!envelope.ok) {
      const errorEnvelope = envelope as FoundationIntentHelperErrorEnvelope;
      const code = mapHelperErrorType(errorEnvelope.errorType);
      throw createIntentProviderError(code, errorEnvelope.message ?? 'Foundation helper reported an error');
    }

    if (!isConversationIntent(envelope.intent)) {
      throw createIntentProviderError('invalid_response', `Foundation helper returned unsupported intent: ${String(envelope.intent)}`);
    }

    if (!Number.isFinite(envelope.confidence)) {
      throw createIntentProviderError('invalid_response', 'Foundation helper returned non-numeric confidence');
    }

    return {
      intent: envelope.intent,
      confidence: Math.min(Math.max(envelope.confidence, 0), 1),
      answerShape: (typeof envelope.answerShape === 'string' && envelope.answerShape.trim())
        ? envelope.answerShape
        : getAnswerShapeGuidance(envelope.intent),
    };
  }

  private runHelperDispatch(
    helperPath: string,
    request: FoundationIntentHelperRequest,
    timeoutMs: number,
  ): Promise<HelperCommandResult> {
    if (this.usePersistentHelper) {
      return this.runPersistentHelperBinary(helperPath, request, timeoutMs);
    }
    return this.runOneShotHelperBinary(helperPath, request, timeoutMs);
  }

  private resetSpawnWindowIfNeeded(): void {
    const now = Date.now();
    if (now - this.persistentWindowStart > PERSISTENT_SPAWN_WINDOW_MS) {
      this.persistentSpawnCount = 0;
      this.persistentWindowStart = now;
    }
  }

  private rejectAllPersistent(reason: unknown): void {
    for (const [, pending] of this.pendingByRequestId) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pendingByRequestId.clear();
  }

  private teardownPersistentChild(): void {
    if (this.persistentLineReader) {
      this.persistentLineReader.close();
      this.persistentLineReader = null;
    }
    if (this.persistentChild) {
      try {
        this.persistentChild.kill();
      } catch {
        // ignore
      }
      this.persistentChild = null;
    }
    this.persistentStderr = '';
  }

  private handlePersistentStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: FoundationIntentHelperEnvelope & { requestId?: string | null };
    try {
      parsed = JSON.parse(trimmed) as FoundationIntentHelperEnvelope & { requestId?: string | null };
    } catch {
      return;
    }

    const rid = typeof parsed.requestId === 'string' && parsed.requestId.length > 0 ? parsed.requestId : null;
    if (rid && this.pendingByRequestId.has(rid)) {
      const pending = this.pendingByRequestId.get(rid)!;
      this.pendingByRequestId.delete(rid);
      clearTimeout(pending.timeout);
      pending.resolve({
        exitCode: 0,
        stdout: trimmed,
        stderr: this.persistentStderr.trim(),
      });
      this.persistentStderr = '';
      return;
    }

    if (!rid && this.pendingByRequestId.size === 1) {
      const [onlyId, pending] = [...this.pendingByRequestId.entries()][0]!;
      this.pendingByRequestId.delete(onlyId);
      clearTimeout(pending.timeout);
      pending.resolve({
        exitCode: 0,
        stdout: trimmed,
        stderr: this.persistentStderr.trim(),
      });
      this.persistentStderr = '';
    }
  }

  private attachPersistentChildHandlers(child: ChildProcess): void {
    const out = child.stdout;
    if (!out) {
      return;
    }
    this.persistentLineReader = readline.createInterface({ input: out });
    this.persistentLineReader.on('line', (line) => {
      this.handlePersistentStdoutLine(line);
    });

    child.stderr?.on('data', (chunk) => {
      this.persistentStderr += chunk.toString();
    });

    child.on('close', (exitCode) => {
      const stderr = this.persistentStderr.trim();
      const err = createIntentProviderError(
        exitCode === 0 ? 'unknown' : mapExitFailure(stderr),
        stderr || `Foundation helper exited with code ${exitCode ?? 'unknown'}`,
      );
      this.rejectAllPersistent(err);
      this.teardownPersistentChild();
    });
  }

  private async ensurePersistentChild(helperPath: string): Promise<ChildProcess> {
    if (this.persistentChild && !this.persistentChild.killed) {
      return this.persistentChild;
    }

    this.resetSpawnWindowIfNeeded();
    if (this.persistentSpawnCount >= PERSISTENT_MAX_SPAWNS_PER_WINDOW) {
      throw createIntentProviderError('unavailable', 'Foundation helper persistent process exceeded restart budget');
    }

    return new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NATIVELY_FOUNDATION_PERSISTENT: '1',
        },
      });

      const fail = (err: unknown): void => {
        this.teardownPersistentChild();
        reject(err);
      };

      child.on('error', (error) => {
        if (this.persistentChild !== child) {
          fail(error);
          return;
        }
        this.rejectAllPersistent(error);
        this.teardownPersistentChild();
      });

      child.once('spawn', () => {
        this.persistentChild = child;
        this.persistentStderr = '';
        this.attachPersistentChildHandlers(child);
        this.persistentSpawnCount += 1;
        resolve(child);
      });
    });
  }

  private async runPersistentHelperBinary(
    helperPath: string,
    request: FoundationIntentHelperRequest,
    timeoutMs: number,
  ): Promise<HelperCommandResult> {
    const child = await this.ensurePersistentChild(helperPath);
    const requestId = request.requestId;
    if (!requestId) {
      throw createIntentProviderError('invalid_response', 'Foundation persistent mode requires requestId');
    }

    return new Promise<HelperCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByRequestId.delete(requestId);
        try {
          child.stdin.write(`${JSON.stringify({ type: 'cancel', requestId })}\n`);
        } catch {
          // ignore
        }
        reject(createIntentProviderError('timeout', `Foundation helper timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingByRequestId.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
        timeout: timer,
      });

      try {
        if (!child.stdin.writableEnded) {
          child.stdin.write(`${JSON.stringify(request)}\n`);
        } else {
          this.pendingByRequestId.delete(requestId);
          clearTimeout(timer);
          reject(createIntentProviderError('unavailable', 'Foundation helper stdin closed'));
        }
      } catch (error) {
        this.pendingByRequestId.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private async runOneShotHelperBinary(
    helperPath: string,
    request: FoundationIntentHelperRequest,
    timeoutMs: number,
  ): Promise<HelperCommandResult> {
    return new Promise<HelperCommandResult>((resolve, reject) => {
      const child = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      const timer = setTimeout(() => {
        finish(() => {
          child.kill();
          reject(createIntentProviderError('timeout', `Foundation helper timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        finish(() => {
          clearTimeout(timer);
          const message = error instanceof Error ? error.message : String(error);
          const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unknown';
          reject(createIntentProviderError(code, `Failed to launch Foundation helper: ${message}`));
        });
      });

      child.on('close', (exitCode) => {
        finish(() => {
          clearTimeout(timer);
          resolve({
            exitCode: exitCode ?? 1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        });
      });

      child.stdin.end(JSON.stringify(request));
    });
  }
}
