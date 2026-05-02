import type {
  ProtectionEventContext,
  ProtectionEventType,
  ProtectionSnapshot,
} from './protectionStateTypes';
import type { VisibilityIntent } from './privacyShieldState';

export type StartupProtectionGateReason =
  | 'protection-verified'
  | 'startup-verification-failed'
  | 'startup-verification-timeout'
  | 'startup-verification-error';

export interface StartupProtectionGateContext extends ProtectionEventContext {
  source: string;
  intent?: VisibilityIntent;
}

export interface StartupProtectionGateDecision {
  allowReveal: boolean;
  strict: boolean;
  verified: boolean;
  wouldBlock: boolean;
  reason: StartupProtectionGateReason;
  source: string;
  intent?: VisibilityIntent;
  elapsedMs: number;
  error?: unknown;
}

interface StartupProtectionGateOptions {
  verifyProtection: (context: StartupProtectionGateContext) => boolean | Promise<boolean>;
  isStrictProtectionEnabled?: () => boolean;
  recordProtectionEvent?: (type: ProtectionEventType, context?: ProtectionEventContext) => ProtectionSnapshot | void;
  onBlocked?: (decision: StartupProtectionGateDecision) => void;
  timeoutMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
}

class StartupVerificationTimeoutError extends Error {
  constructor() {
    super('startup protection verification timed out');
    this.name = 'StartupVerificationTimeoutError';
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof StartupVerificationTimeoutError;
}

export class StartupProtectionGate {
  private readonly verifyProtection: StartupProtectionGateOptions['verifyProtection'];
  private readonly isStrictProtectionEnabled: () => boolean;
  private readonly recordProtectionEvent?: StartupProtectionGateOptions['recordProtectionEvent'];
  private readonly onBlocked?: StartupProtectionGateOptions['onBlocked'];
  private readonly timeoutMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;

  constructor(options: StartupProtectionGateOptions) {
    this.verifyProtection = options.verifyProtection;
    this.isStrictProtectionEnabled = options.isStrictProtectionEnabled ?? (() => false);
    this.recordProtectionEvent = options.recordProtectionEvent;
    this.onBlocked = options.onBlocked;
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env.NATIVELY_STARTUP_GATE_TIMEOUT_MS || '1500', 10);
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
  }

  async evaluateReveal(context: StartupProtectionGateContext): Promise<StartupProtectionGateDecision> {
    const startedAt = this.now();
    const strict = this.isStrictProtectionEnabled();
    let verified = false;
    let reason: StartupProtectionGateReason = 'startup-verification-failed';
    let error: unknown;

    try {
      verified = await this.verifyWithTimeout(context);
      reason = verified ? 'protection-verified' : 'startup-verification-failed';
    } catch (caught) {
      error = caught;
      reason = isTimeoutError(caught) ? 'startup-verification-timeout' : 'startup-verification-error';
      this.logger.error('[StartupProtectionGate] startup protection verification failed:', caught);
    }

    this.recordProtectionEvent?.(verified ? 'verification-passed' : 'verification-failed', {
      ...context,
      strict,
      reason,
      metadata: {
        ...context.metadata,
        startupGate: true,
      },
    });

    const wouldBlock = !verified;
    const allowReveal = verified || !strict;
    const decision: StartupProtectionGateDecision = {
      allowReveal,
      strict,
      verified,
      wouldBlock,
      reason,
      source: context.source,
      intent: context.intent,
      elapsedMs: Math.max(0, this.now() - startedAt),
      error,
    };

    if (wouldBlock) {
      const mode = strict ? 'blocking' : 'observe-only would block';
      this.logger.warn(
        `[StartupProtectionGate] ${mode} startup reveal: reason=${reason} source=${context.source}`,
      );
    }

    if (!allowReveal) {
      this.onBlocked?.(decision);
    }

    return decision;
  }

  private verifyWithTimeout(context: StartupProtectionGateContext): Promise<boolean> {
    const verification = Promise.resolve().then(() => this.verifyProtection(context));
    if (this.timeoutMs <= 0) {
      return verification;
    }

    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new StartupVerificationTimeoutError());
      }, this.timeoutMs);

      verification.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }
}
