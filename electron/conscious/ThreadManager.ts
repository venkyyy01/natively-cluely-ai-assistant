// electron/conscious/ThreadManager.ts
import { randomUUID } from 'crypto';
import { 
  ConversationThread, 
  InterviewPhase, 
  ThreadCodeContext,
  ConfidenceScore 
} from './types';
import { ConfidenceScorer } from './ConfidenceScorer';

const MAX_SUSPENDED_THREADS = 3;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateThreadId(): string {
  return `thread_${randomUUID()}`;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
    'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not', 'only',
    'own', 'same', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'me', 'you', 'it', 'we', 'they', 'i', 'let', 'about', 'tell', 'design', 'implement']);
  
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

export class ThreadManager {
  private activeThread: ConversationThread | null = null;
  private suspendedThreads: ConversationThread[] = [];
  private confidenceScorer: ConfidenceScorer = new ConfidenceScorer();

  private buildPseudoEmbedding(text: string): number[] {
    const DIM = 32;
    const vec = new Array<number>(DIM).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return vec;

    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % DIM;
      vec[idx] += 1;
    }

    const norm = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0));
    if (norm === 0) return vec;
    return vec.map((n) => n / norm);
  }

  createThread(topic: string, phase: InterviewPhase): ConversationThread {
    // Suspend current active thread if exists
    if (this.activeThread) {
      this.suspendActive(topic);
    }
    
    const now = Date.now();
    const newThread: ConversationThread = {
      id: generateThreadId(),
      status: 'active',
      topic,
      goal: `Discuss ${topic}`,
      phase,
      keyDecisions: [],
      constraints: [],
      codeContext: { snippets: [], maxSnippets: 3, totalTokenBudget: 500 },
      createdAt: now,
      lastActiveAt: now,
      ttlMs: DEFAULT_TTL_MS,
      resumeKeywords: extractKeywords(topic),
      turnCount: 0,
      tokenCount: 0,
      resumeCount: 0,
      embedding: this.buildPseudoEmbedding(`${topic} Discuss ${topic}`),
    };
    
    this.activeThread = newThread;
    return newThread;
  }

  suspendActive(interruptedBy?: string): void {
    if (!this.activeThread) return;

    // Refresh embedding before suspension for better resume matching
    this.activeThread.embedding = this.buildPseudoEmbedding(
      `${this.activeThread.topic} ${this.activeThread.goal} ${this.activeThread.resumeKeywords.join(' ')}`
    );
    
    this.activeThread.status = 'suspended';
    this.activeThread.suspendedAt = Date.now();
    if (interruptedBy) {
      this.activeThread.interruptedBy = interruptedBy;
    }
    
    // Add to suspended list
    this.suspendedThreads.unshift(this.activeThread);
    
    // Enforce max suspended threads (evict oldest)
    while (this.suspendedThreads.length > MAX_SUSPENDED_THREADS) {
      this.suspendedThreads.pop();
    }
    
    this.activeThread = null;
  }

  resumeThread(threadId: string): boolean {
    // First, find if thread exists
    const index = this.suspendedThreads.findIndex(t => t.id === threadId);
    if (index === -1) return false;
    
    // Suspend current active thread FIRST (this modifies suspendedThreads)
    if (this.activeThread) {
      this.suspendActive();
    }
    
    // Re-find the thread since array may have changed after suspendActive
    const newIndex = this.suspendedThreads.findIndex(t => t.id === threadId);
    if (newIndex === -1) {
      // Thread may have been evicted when we suspended (hit MAX_SUSPENDED limit)
      return false;
    }
    
    // Now safe to splice
    const [thread] = this.suspendedThreads.splice(newIndex, 1);
    
    // Clean up suspension metadata and reactivate thread
    thread.suspendedAt = undefined;
    thread.interruptedBy = undefined;
    thread.lastActiveAt = Date.now();
    thread.status = 'active';
    thread.resumeCount++;
    
    this.activeThread = thread;
    return true;
  }

  getActiveThread(): ConversationThread | null {
    return this.activeThread;
  }

  getSuspendedThreads(): ConversationThread[] {
    return [...this.suspendedThreads];
  }

  findMatchingThread(
    transcript: string,
    currentPhase: InterviewPhase = 'requirements_gathering',
    transcriptEmbedding?: number[]
  ): { thread: ConversationThread; confidence: ConfidenceScore } | null {
    if (this.suspendedThreads.length === 0) return null;

    const effectiveEmbedding = transcriptEmbedding || this.buildPseudoEmbedding(transcript);
    
    let bestMatch: { thread: ConversationThread; confidence: ConfidenceScore } | null = null;
    
    for (const thread of this.suspendedThreads) {
      const confidence = this.confidenceScorer.calculateResumeConfidence(
        transcript, 
        thread, 
        currentPhase,
        0.9,
        effectiveEmbedding
      );
      
      if (!bestMatch || confidence.total > bestMatch.confidence.total) {
        bestMatch = { thread, confidence };
      }
    }
    
    return bestMatch;
  }

  pruneExpired(): number {
    const now = Date.now();
    const initialCount = this.suspendedThreads.length;
    
    this.suspendedThreads = this.suspendedThreads.filter(thread => {
      const suspendedAt = thread.suspendedAt || thread.lastActiveAt;
      const age = now - suspendedAt;
      return age < thread.ttlMs;
    });
    
    return initialCount - this.suspendedThreads.length;
  }

  updateActiveThread(updates: Partial<ConversationThread>): void {
    if (!this.activeThread) return;
    
    Object.assign(this.activeThread, updates, { lastActiveAt: Date.now() });
  }

  addDecisionToActive(decision: string): void {
    if (!this.activeThread) return;
    
    if (!this.activeThread.keyDecisions.includes(decision)) {
      this.activeThread.keyDecisions.push(decision);
    }
  }

  addConstraintToActive(constraint: string): void {
    if (!this.activeThread) return;

    if (!this.activeThread.constraints.includes(constraint)) {
      this.activeThread.constraints.push(constraint);
    }
  }

  addKeywordsToActive(keywords: string[]): void {
    if (!this.activeThread) return;
    
    const existing = new Set(this.activeThread.resumeKeywords);
    for (const keyword of keywords) {
      if (!existing.has(keyword)) {
        this.activeThread.resumeKeywords.push(keyword);
      }
    }
  }

  reset(): void {
    this.activeThread = null;
    this.suspendedThreads = [];
  }

  completeActiveThread(): void {
    if (this.activeThread) {
      this.activeThread.status = 'completed';
      this.activeThread = null;
    }
  }
}
