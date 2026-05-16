import {
  ConsciousModeStructuredResponse,
  ReasoningThread,
  mergeConsciousModeResponses,
} from '../ConsciousMode';
import { ThreadManager } from './ThreadManager';
import { InterviewPhase, RESUME_THRESHOLD } from './types';
import type { ProbeAnswer } from '../coding/types';
import { isConsciousOptimizationActive } from '../config/optimizations';

const MAX_PROBES = 8;

export interface PersistedActiveThreadSnapshot {
  id: string;
  topic: string;
  goal?: string;
  phase?: InterviewPhase;
  turnCount: number;
}

export interface PersistedConsciousThreadState {
  latestConsciousResponse: ConsciousModeStructuredResponse | null;
  activeReasoningThread: ReasoningThread | null;
}

export class ConsciousThreadStore {
  private latestConsciousResponse: ConsciousModeStructuredResponse | null = null;
  private activeReasoningThread: ReasoningThread | null = null;
  private readonly threadManager: ThreadManager;

  constructor(threadManager: ThreadManager = new ThreadManager()) {
    this.threadManager = threadManager;
  }

  handleObservedInterviewerTranscript(
    transcript: string,
    detectPhaseFromTranscript: (transcript: string) => InterviewPhase,
    setCurrentPhase: (phase: InterviewPhase) => void,
  ): void {
    const normalized = transcript.trim();
    if (!normalized) {
      return;
    }

    const phase = detectPhaseFromTranscript(normalized);
    setCurrentPhase(phase);
    this.threadManager.pruneExpired();

    const activeThread = this.threadManager.getActiveThread();
    const matchingThread = this.threadManager.findMatchingThread(normalized, phase);

    if (!activeThread && matchingThread && matchingThread.confidence.total >= RESUME_THRESHOLD) {
      this.threadManager.resumeThread(matchingThread.thread.id);
    }

    const currentThread = this.threadManager.getActiveThread();
    const resumeKeywords = Array.from(new Set(
      normalized
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4)
    ));

    if (!currentThread) {
      if (resumeKeywords.length > 0 || normalized.split(/\s+/).length >= 4) {
        this.threadManager.createThread(normalized, phase);
        this.threadManager.addKeywordsToActive(resumeKeywords);
      }
      return;
    }

    const phaseShift = currentThread.phase !== phase;
    const majorPhaseShift = phaseShift && (
      phase === 'behavioral_story' ||
      phase === 'wrap_up' ||
      currentThread.phase === 'behavioral_story'
    );

    if (majorPhaseShift) {
      this.threadManager.createThread(normalized, phase);
      this.threadManager.addKeywordsToActive(resumeKeywords);
      return;
    }

    this.threadManager.updateActiveThread({
      phase,
      turnCount: currentThread.turnCount + 1,
    });
    this.threadManager.addKeywordsToActive(resumeKeywords);
  }

  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
    return this.latestConsciousResponse;
  }

  getActiveReasoningThread(): ReasoningThread | null {
    return this.activeReasoningThread;
  }

  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  clear(): void {
    this.latestConsciousResponse = null;
    this.activeReasoningThread = null;
  }

  /**
   * NAT-202: Append a Tier-B probe to the active thread.
   * Root response stays immutable. Probes are capped at MAX_PROBES (LRU eviction).
   * The optional delta.fact is applied exactly once (dedup by text).
   */
  appendProbe(probe: ProbeAnswer): void {
    if (!this.activeReasoningThread) {
      return;
    }
    const existing = this.activeReasoningThread.probes ?? [];
    const updated = existing.length >= MAX_PROBES ? existing.slice(1) : existing;
    updated.push(probe);

    let updatedRoot = this.activeReasoningThread.response;
    if (probe.delta) {
      const { fact, attachTo } = probe.delta;
      const arr: string[] = [...(updatedRoot[attachTo] ?? [])];
      if (!arr.includes(fact)) {
        const capped = arr.length >= 8 ? arr.slice(1) : arr;
        capped.push(fact);
        updatedRoot = { ...updatedRoot, [attachTo]: capped };
      }
    }

    this.activeReasoningThread = {
      ...this.activeReasoningThread,
      response: updatedRoot,
      probes: updated,
      followUpCount: this.activeReasoningThread.followUpCount + 1,
      lastQuestion: probe.question,
      updatedAt: Date.now(),
    };
    this.latestConsciousResponse = this.activeReasoningThread.response;
  }

  recordConsciousResponse(
    question: string,
    response: ConsciousModeStructuredResponse,
    threadAction: 'start' | 'continue' | 'reset'
  ): void {
    this.latestConsciousResponse = response;
    const designThreadId = this.threadManager.getActiveThread()?.id;

    if (threadAction === 'continue' && this.activeReasoningThread) {
      // NAT-202: When Two-Tier is ON, probe answers are appended via appendProbe().
      // The full mergeConsciousModeResponses path is only used in legacy (flag OFF) mode.
      const useTwoTier = isConsciousOptimizationActive('useTwoTierAnswerContract');
      const mergedResponse = useTwoTier
        ? this.activeReasoningThread.response
        : mergeConsciousModeResponses(this.activeReasoningThread.response, response);
      this.activeReasoningThread = {
        ...this.activeReasoningThread,
        threadId: designThreadId ?? this.activeReasoningThread.threadId,
        lastQuestion: question,
        followUpCount: this.activeReasoningThread.followUpCount + 1,
        response: mergedResponse,
        updatedAt: Date.now(),
      };
      this.latestConsciousResponse = this.activeReasoningThread.response;
      const decisions = [
        response.openingReasoning,
        response.implementationPlan[0],
        response.tradeoffs[0],
        response.scaleConsiderations[0],
        response.codeTransition,
      ].filter(Boolean);
      const constraints = [
        ...response.edgeCases,
        ...response.tradeoffs,
      ];
      for (const decision of decisions) {
        this.threadManager.addDecisionToActive(decision);
      }
      for (const constraint of constraints.slice(0, 4)) {
        this.threadManager.addConstraintToActive(constraint);
      }
      return;
    }

    this.activeReasoningThread = {
      threadId: designThreadId,
      rootQuestion: question,
      lastQuestion: question,
      response,
      followUpCount: 0,
      updatedAt: Date.now(),
    };

    const decisions = [
      response.openingReasoning,
      response.implementationPlan[0],
      response.tradeoffs[0],
      response.scaleConsiderations[0],
      response.codeTransition,
    ].filter(Boolean);
    const constraints = [
      ...response.edgeCases,
      ...response.tradeoffs,
    ];

    for (const decision of decisions) {
      this.threadManager.addDecisionToActive(decision);
    }
    for (const constraint of constraints.slice(0, 4)) {
      this.threadManager.addConstraintToActive(constraint);
    }
  }

  restoreActiveThread(snapshot: PersistedActiveThreadSnapshot): void {
    const restored = this.threadManager.createThread(
      snapshot.topic,
      snapshot.phase || 'requirements_gathering'
    );
    this.threadManager.updateActiveThread({
      id: snapshot.id,
      goal: snapshot.goal || restored.goal,
      turnCount: snapshot.turnCount,
    } as any);
  }

  reset(): void {
    this.clear();
    this.threadManager.reset();
  }

  getPersistenceSnapshot(): PersistedConsciousThreadState {
    return {
      latestConsciousResponse: this.latestConsciousResponse,
      activeReasoningThread: this.activeReasoningThread,
    };
  }

  restorePersistenceSnapshot(snapshot: PersistedConsciousThreadState | null | undefined): void {
    if (!snapshot) {
      this.latestConsciousResponse = null;
      this.activeReasoningThread = null;
      return;
    }

    this.latestConsciousResponse = snapshot.latestConsciousResponse;
    this.activeReasoningThread = snapshot.activeReasoningThread;
  }
}
