import type { RuntimeLane } from '../config/optimizations';

export type InferenceRequestClass = 'fast' | 'verify' | 'quality';
export type InferenceLaneName = 'fast-draft' | 'verification' | 'quality';
export type InferenceLaneStatus = 'completed' | 'discarded' | 'rejected' | 'failed';

export interface InferenceRequest {
  requestId: string;
  requestClass: InferenceRequestClass;
  transcriptRevision: number;
  contextSnapshot: string;
  budgetDeadlineMs: number;
  draft?: string | null;
  /** NAT-057: when set with RouteDirector + quality route, race fast-draft vs quality (first valid wins). */
  parallelCandidates?: boolean;
}

export interface RouteDecision {
  lane: InferenceLaneName;
  schedulerLane: RuntimeLane;
  providers: string[];
  degraded: boolean;
  reason: string;
}

export interface LaneResult {
  requestId: string;
  lane: InferenceLaneName;
  status: InferenceLaneStatus;
  output: string | null;
  provider: string | null;
  transcriptRevision: number;
  reason?: string;
}
