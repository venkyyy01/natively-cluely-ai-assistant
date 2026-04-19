import { spawn } from 'node:child_process';

import type { ConversationIntent, IntentResult } from '../IntentClassifier';
import { getAnswerShapeGuidance } from '../IntentClassifier';
import { isOptimizationActive } from '../../config/optimizations';
import { resolveFoundationModelsIntentHelperPath } from './FoundationModelsIntentHelperPath';
import {
  createIntentProviderError,
  type IntentClassificationInput,
  type IntentInferenceProvider,
  type IntentProviderErrorType,
} from './IntentInferenceProvider';

const INTENT_CANDIDATES: ConversationIntent[] = [
  'behavioral',
  'coding',
  'deep_dive',
  'clarification',
  'follow_up',
  'example_request',
  'summary_probe',
  'general',
];

interface FoundationIntentHelperRequest {
  version: 1;
  question: string;
  preparedTranscript: string;
  assistantResponseCount: number;
  candidateIntents: ConversationIntent[];
}

interface FoundationIntentHelperSuccessEnvelope {
  ok: true;
  intent: string;
  confidence: number;
  answerShape?: string;
  provider?: string;
}

interface FoundationIntentHelperErrorEnvelope {
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
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  isOptimizationEnabled?: (flag: 'useFoundationModelsIntent') => boolean;
}

const DEFAULT_TIMEOUT_MS = 2600;
const MAX_COMPACT_TRANSCRIPT_LINES = 6;
const MAX_COMPACT_TRANSCRIPT_CHARS = 1200;

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

function mapExitFailure(stderr: string): IntentProviderErrorType {
  const normalized = stderr.toLowerCase();
  if (normalized.includes('timeout')) {
    return 'timeout';
  }
  if (normalized.includes('unavailable')) {
    return 'unavailable';
  }
  if (normalized.includes('refusal')) {
    return 'refusal';
  }
  if (normalized.includes('rate')) {
    return 'rate_limited';
  }
  return 'unknown';
}

export class FoundationModelsIntentProvider implements IntentInferenceProvider {
  readonly name = 'foundation';

  private readonly helperPathResolver: () => string | null;
  private readonly helperRunner: (helperPath: string, request: FoundationIntentHelperRequest, timeoutMs: number) => Promise<HelperCommandResult>;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly isOptimizationEnabled: (flag: 'useFoundationModelsIntent') => boolean;

  constructor(options: FoundationModelsIntentProviderOptions = {}) {
    this.helperPathResolver = options.helperPathResolver ?? (() => resolveFoundationModelsIntentHelperPath());
    this.helperRunner = options.helperRunner ?? this.runHelperBinary;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.isOptimizationEnabled = options.isOptimizationEnabled ?? ((flag: 'useFoundationModelsIntent'): boolean => isOptimizationActive(flag));
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

    const request: FoundationIntentHelperRequest = {
      version: 1,
      question: input.lastInterviewerTurn ?? '',
      preparedTranscript: compactPreparedTranscript(input.preparedTranscript, input.lastInterviewerTurn ?? ''),
      assistantResponseCount: input.assistantResponseCount,
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

  private async runHelperBinary(
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
