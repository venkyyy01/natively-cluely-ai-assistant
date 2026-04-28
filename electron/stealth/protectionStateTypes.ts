export type ProtectionState =
  | 'boot'
  | 'protecting-hidden'
  | 'verified-hidden'
  | 'visible-protected'
  | 'degraded-observed'
  | 'fault-contained';

export type ProtectionEventType =
  | 'window-created'
  | 'protection-apply-started'
  | 'protection-apply-finished'
  | 'verification-passed'
  | 'verification-failed'
  | 'show-requested'
  | 'shown'
  | 'hide-requested'
  | 'hidden'
  | 'fault'
  | 'recovery-requested';

export type ProtectionViolationType =
  | 'show-before-verified'
  | 'shown-before-verified'
  | 'protecting-visible-window';

export interface ProtectionEventContext {
  windowId?: string;
  windowRole?: 'primary' | 'auxiliary' | 'unknown';
  source?: string;
  reason?: string;
  platform?: string;
  strict?: boolean;
  visible?: boolean;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProtectionEvent extends ProtectionEventContext {
  type: ProtectionEventType;
  timestampMs: number;
}

export interface ProtectionViolation {
  type: ProtectionViolationType;
  stateBefore: ProtectionState;
  event: ProtectionEvent;
  timestampMs: number;
}

export interface ProtectionSnapshot {
  state: ProtectionState;
  previousState: ProtectionState | null;
  lastEventType: ProtectionEventType | null;
  lastEvent: ProtectionEvent | null;
  updatedAtMs: number;
  eventCount: number;
  violations: ProtectionViolation[];
}

export interface ProtectionStateMachineOptions {
  logger?: Pick<Console, 'warn' | 'log'>;
  maxViolations?: number;
  now?: () => number;
}
