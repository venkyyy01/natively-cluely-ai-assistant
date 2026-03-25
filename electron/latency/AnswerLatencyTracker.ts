import { ProviderCapabilityClass } from './providerCapability';

export type AnswerRoute = 'fast_standard_answer' | 'enriched_standard_answer' | 'conscious_answer' | 'manual_answer' | 'follow_up_refinement';

export interface LatencySnapshot {
  requestId: string;
  route: AnswerRoute;
  capability: ProviderCapabilityClass;
  completed: boolean;
  marks: Record<string, number>;
}

export class AnswerLatencyTracker {
  private static nextId = 1;
  private snapshots = new Map<string, LatencySnapshot>();

  start(route: AnswerRoute, capability: ProviderCapabilityClass): string {
    const requestId = `req_${AnswerLatencyTracker.nextId++}`;
    this.snapshots.set(requestId, {
      requestId,
      route,
      capability,
      completed: false,
      marks: { startedAt: Date.now() },
    });
    return requestId;
  }

  mark(requestId: string, label: string): void {
    const snapshot = this.snapshots.get(requestId);
    if (!snapshot || snapshot.completed) return;
    snapshot.marks[label] = Date.now();
  }

  complete(requestId: string): LatencySnapshot | undefined {
    const snapshot = this.snapshots.get(requestId);
    if (!snapshot) return undefined;
    snapshot.completed = true;
    snapshot.marks.completedAt = Date.now();
    return { ...snapshot, marks: { ...snapshot.marks } };
  }

  getSnapshot(requestId: string): LatencySnapshot | undefined {
    const snapshot = this.snapshots.get(requestId);
    return snapshot ? { ...snapshot, marks: { ...snapshot.marks } } : undefined;
  }
}
