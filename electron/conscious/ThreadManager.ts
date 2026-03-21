// electron/conscious/ThreadManager.ts
import { 
  ConversationThread, 
  InterviewPhase, 
  ThreadCodeContext,
  ConfidenceScore 
} from './types';
import { ConfidenceScorer } from './ConfidenceScorer';

const MAX_SUSPENDED_THREADS = 3;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

let threadIdCounter = 0;

function generateThreadId(): string {
  threadIdCounter += 1;
  return `thread_${Date.now()}_${threadIdCounter}_${Math.random().toString(36).substr(2, 9)}`;
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
    };
    
    this.activeThread = newThread;
    return newThread;
  }

  suspendActive(interruptedBy?: string): void {
    if (!this.activeThread) return;
    
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
    const index = this.suspendedThreads.findIndex(t => t.id === threadId);
    if (index === -1) return false;
    
    // Remove the thread from suspended list FIRST (before suspending active)
    const thread = this.suspendedThreads.splice(index, 1)[0];
    
    // Suspend current active (this may add to suspendedThreads)
    if (this.activeThread) {
      this.suspendActive();
    }
    
    // Resume the target thread
    thread.status = 'active';
    thread.lastActiveAt = Date.now();
    thread.resumeCount += 1;
    delete thread.suspendedAt;
    delete thread.interruptedBy;
    
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
    currentPhase: InterviewPhase = 'requirements_gathering'
  ): { thread: ConversationThread; confidence: ConfidenceScore } | null {
    if (this.suspendedThreads.length === 0) return null;
    
    let bestMatch: { thread: ConversationThread; confidence: ConfidenceScore } | null = null;
    
    for (const thread of this.suspendedThreads) {
      const confidence = this.confidenceScorer.calculateResumeConfidence(
        transcript, 
        thread, 
        currentPhase
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
