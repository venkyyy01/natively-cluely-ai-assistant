import { ProviderCapabilityClass } from './providerCapability';
import { getPerformanceInstrumentation } from '../runtime/PerformanceInstrumentation';

export type AnswerRoute = 'fast_standard_answer' | 'enriched_standard_answer' | 'conscious_answer' | 'manual_answer' | 'follow_up_refinement';
export type TrackedProviderCapabilityClass = ProviderCapabilityClass | 'non_streaming_custom';
export type ProfileEnrichmentState = 'attempted' | 'completed' | 'failed' | 'timed_out';
export type ConsciousPath = 'fresh_start' | 'thread_continue';

export function normalizeTrackedProviderCapability(
  capability: ProviderCapabilityClass | 'non_streaming_custom',
): TrackedProviderCapabilityClass {
  return capability === 'non_streaming' ? 'non_streaming_custom' : capability;
}

export interface LatencyMetadata {
  transcriptRevision?: number;
  attemptedRoute?: AnswerRoute;
  fallbackOccurred?: boolean;
  profileFallbackReason?: string;
  interimQuestionSubstitutionOccurred?: boolean;
  profileEnrichmentState?: ProfileEnrichmentState;
  consciousPath?: ConsciousPath;
  firstVisibleAnswer?: number;
  contextItemIds?: string[];
  verifierOutcome?: {
    deterministic: 'pass' | 'fail' | 'skipped';
    provenance: 'pass' | 'fail' | 'skipped';
  };
  stealthContainmentActive?: boolean;
}

export interface LatencySnapshot extends LatencyMetadata {
  requestId: string;
  route: AnswerRoute;
  capability: TrackedProviderCapabilityClass;
  completed: boolean;
  marks: Record<string, number>;
}

export class AnswerLatencyTracker {
  private static nextId = 1;
  private readonly MAX_SNAPSHOTS = 100;
  private snapshots = new Map<string, LatencySnapshot>();

  private evictOldSnapshots(): void {
    while (this.snapshots.size > this.MAX_SNAPSHOTS) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey) this.snapshots.delete(oldestKey);
    }
  }

  private getMutableSnapshot(requestId: string): LatencySnapshot | undefined {
    const snapshot = this.snapshots.get(requestId);
    return snapshot && !snapshot.completed ? snapshot : undefined;
  }

  private writeMark(snapshot: LatencySnapshot, label: string, timestamp: number): void {
    snapshot.marks[label] = timestamp;
  }

  private createSnapshotCopy(snapshot: LatencySnapshot): LatencySnapshot {
    const marks = { ...snapshot.marks };
    return {
      ...snapshot,
      firstVisibleAnswer: marks.firstVisibleAnswer,
      marks,
    };
  }

  start(route: AnswerRoute, capability: ProviderCapabilityClass | 'non_streaming_custom', metadata: LatencyMetadata = {}): string {
    const requestId = `req_${AnswerLatencyTracker.nextId++}`;
    const normalizedCapability = normalizeTrackedProviderCapability(capability);
    const firstVisibleAnswer = metadata.firstVisibleAnswer;
    const normalizedMetadata = { ...metadata };
    delete normalizedMetadata.firstVisibleAnswer;
    this.snapshots.set(requestId, {
      requestId,
      route,
      capability: normalizedCapability,
      completed: false,
      marks: {
        startedAt: Date.now(),
        ...(firstVisibleAnswer === undefined ? {} : { firstVisibleAnswer }),
      },
      ...normalizedMetadata,
    });
    this.evictOldSnapshots();
    return requestId;
  }

  mark(requestId: string, label: string): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot) return;
    this.writeMark(snapshot, label, Date.now());
  }

  markProviderRequestStarted(requestId: string): void {
    this.mark(requestId, 'providerRequestStarted');
  }

  markFirstStreamingUpdate(requestId: string): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot) return;

    const timestamp = Date.now();
    if (snapshot.capability === 'streaming' && snapshot.marks.firstToken === undefined) {
      this.writeMark(snapshot, 'firstToken', timestamp);
    }
    if (snapshot.marks.firstVisibleAnswer === undefined) {
      this.writeMark(snapshot, 'firstVisibleAnswer', timestamp);
    }
  }

  markFirstVisibleAnswer(requestId: string): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot || snapshot.marks.firstVisibleAnswer !== undefined) return;
    this.writeMark(snapshot, 'firstVisibleAnswer', Date.now());
  }

  markFallbackOccurred(requestId: string, profileFallbackReason?: string): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot) return;
    snapshot.fallbackOccurred = true;
    if (profileFallbackReason !== undefined) {
      snapshot.profileFallbackReason = profileFallbackReason;
    }
  }

  markDegradedToRoute(requestId: string, route: AnswerRoute, metadata: Partial<LatencyMetadata> = {}): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot) return;
    if (snapshot.attemptedRoute === undefined) {
      snapshot.attemptedRoute = snapshot.route;
    }
    snapshot.route = route;
    this.annotate(requestId, metadata);
  }

  markProfileEnrichmentState(requestId: string, state: ProfileEnrichmentState, profileFallbackReason?: string): void {
    const snapshot = this.getMutableSnapshot(requestId);
    if (!snapshot) return;
    snapshot.profileEnrichmentState = state;
    snapshot.profileFallbackReason = profileFallbackReason;
  }

  annotate(requestId: string, metadata: LatencyMetadata): void {
    const snapshot = this.snapshots.get(requestId);
    if (!snapshot || snapshot.completed) return;
    const normalizedMetadata = { ...metadata };
    if (normalizedMetadata.firstVisibleAnswer !== undefined) {
      this.writeMark(snapshot, 'firstVisibleAnswer', normalizedMetadata.firstVisibleAnswer);
      delete normalizedMetadata.firstVisibleAnswer;
    }
    Object.assign(snapshot, normalizedMetadata);
  }

  complete(requestId: string): LatencySnapshot | undefined {
    const snapshot = this.snapshots.get(requestId);
    if (!snapshot) return undefined;
    snapshot.completed = true;
    snapshot.marks.completedAt = Date.now();

    const startedAt = snapshot.marks.startedAt;
    const firstVisibleAnswer = snapshot.marks.firstVisibleAnswer;
    if (startedAt !== undefined && firstVisibleAnswer !== undefined) {
      getPerformanceInstrumentation().recordMeasurement(
        'answer.firstVisible',
        firstVisibleAnswer - startedAt,
        {
        requestId: snapshot.requestId,
        route: snapshot.route,
        capability: snapshot.capability,
        attemptedRoute: snapshot.attemptedRoute,
        fallbackOccurred: snapshot.fallbackOccurred ?? false,
        transcriptRevision: snapshot.transcriptRevision,
        },
      );
    }

    return this.createSnapshotCopy(snapshot);
  }

  getSnapshot(requestId: string): LatencySnapshot | undefined {
    const snapshot = this.snapshots.get(requestId);
    return snapshot ? this.createSnapshotCopy(snapshot) : undefined;
  }
}
