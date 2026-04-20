import {
  ConsciousModeStructuredResponse,
  ReasoningThread,
  mergeConsciousModeResponses,
} from '../ConsciousMode';
import { ThreadManager } from './ThreadManager';
import { InterviewPhase, RESUME_THRESHOLD } from './types';

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

  recordConsciousResponse(
    question: string,
    response: ConsciousModeStructuredResponse,
    threadAction: 'start' | 'continue' | 'reset'
  ): void {
    this.latestConsciousResponse = response;
    const designThreadId = this.threadManager.getActiveThread()?.id;

    if (threadAction === 'continue' && this.activeReasoningThread) {
      this.activeReasoningThread = {
        ...this.activeReasoningThread,
        threadId: designThreadId ?? this.activeReasoningThread.threadId,
        lastQuestion: question,
        followUpCount: this.activeReasoningThread.followUpCount + 1,
        response: mergeConsciousModeResponses(this.activeReasoningThread.response, response),
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
