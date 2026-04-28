// sessionContext.ts
// Transcript assembly, context building, and adaptive context selection.

import type { SessionTracker } from '../SessionTracker';
import {
  type ContextItem,
  type TranscriptSegment,
  type PinnedItem,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_ASSISTANT_HISTORY,
  mapSpeakerToRole,
} from './sessionTypes';
import type { InterviewPhase } from '../conscious';
import { AdaptiveContextWindow, ContextEntry, ContextSelectionConfig } from '../conscious/AdaptiveContextWindow';
import { detectQuestion } from '../conscious';
import { isOptimizationActive } from '../config/optimizations';
import { getEmbeddingProvider } from '../cache/ParallelContextAssembler';
import { getActiveAccelerationManager } from '../services/AccelerationManager';
import { TokenCounter } from '../shared/TokenCounter';

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Pure utilities (no tracker state required)
// ---------------------------------------------------------------------------

export function buildPseudoEmbedding(text: string): number[] {
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

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function tokenizeForMemory(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  ));
}

export function lexicalOverlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = new Set(tokenizeForMemory(text));
  if (haystack.size === 0) {
    return 0;
  }

  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

export function computePhaseAlignmentScore(candidatePhase: InterviewPhase | undefined, currentPhase: InterviewPhase): number {
  if (!candidatePhase) {
    return 0.45;
  }

  if (candidatePhase === currentPhase) {
    return 1;
  }

  const phaseOrder: InterviewPhase[] = [
    'requirements_gathering',
    'high_level_design',
    'deep_dive',
    'implementation',
    'complexity_analysis',
    'scaling_discussion',
    'failure_handling',
    'behavioral_story',
    'wrap_up',
  ];

  const left = phaseOrder.indexOf(candidatePhase);
  const right = phaseOrder.indexOf(currentPhase);
  if (left >= 0 && right >= 0 && Math.abs(left - right) <= 1) {
    return 0.72;
  }

  const related = new Set([
    'requirements_gathering:high_level_design',
    'high_level_design:deep_dive',
    'deep_dive:implementation',
    'complexity_analysis:scaling_discussion',
    'scaling_discussion:failure_handling',
  ]);

  if (related.has(`${candidatePhase}:${currentPhase}`) || related.has(`${currentPhase}:${candidatePhase}`)) {
    return 0.5;
  }

  return 0.15;
}

export function computeFacetQueryBoost(text: string, queryTokens: string[]): number {
  const lower = text.toLowerCase();
  let boost = 0;

  if (lower.startsWith('data_model:') && (queryTokens.includes('schema') || queryTokens.includes('model') || queryTokens.includes('data'))) {
    boost += 0.12;
    if (/(table|index|indexes|append-only|schema|secondary index|entity)/i.test(lower)) {
      boost += 0.1;
    }
  }

  if (lower.startsWith('api_contracts:') && (queryTokens.includes('api') || queryTokens.includes('contract') || queryTokens.includes('interface'))) {
    boost += 0.14;
  }

  if (lower.startsWith('failure_modes:') && (queryTokens.includes('failure') || queryTokens.includes('failover') || queryTokens.includes('reliability'))) {
    boost += 0.14;
  }

  if (lower.startsWith('scaling_plan:') && (queryTokens.includes('scale') || queryTokens.includes('throughput') || queryTokens.includes('hotspot'))) {
    boost += 0.12;
  }

  if (lower.startsWith('tradeoffs:') && (queryTokens.includes('tradeoff') || queryTokens.includes('tradeoffs'))) {
    boost += 0.1;
  }

  return boost;
}

export function computeBM25Scores(query: string, documents: string[]): number[] {
  if (documents.length === 0) {
    return [];
  }

  const queryTerms = tokenizeForMemory(query);
  if (queryTerms.length === 0) {
    return new Array(documents.length).fill(0);
  }

  const docTerms = documents.map((document) => tokenizeForMemory(document));
  const avgDocLength = Math.max(
    1,
    docTerms.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, docTerms.length),
  );
  const k1 = 1.5;
  const b = 0.75;

  return docTerms.map((terms) => {
    if (terms.length === 0) {
      return 0;
    }

    let score = 0;
    for (const term of queryTerms) {
      const tf = terms.filter((candidate) => candidate === term || candidate.includes(term)).length;
      if (tf === 0) {
        continue;
      }

      const df = docTerms.filter((doc) => doc.some((candidate) => candidate === term || candidate.includes(term))).length;
      const idf = Math.log((documents.length - df + 0.5) / (df + 0.5) + 1);
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (terms.length / avgDocLength)));
    }

    return score;
  });
}

// ---------------------------------------------------------------------------
// Tracker-dependent helpers
// ---------------------------------------------------------------------------

export function buildPinnedContextSection(tracker: SessionTracker): string {
  const t = tracker as any;
  if (t.pinnedItems.length === 0) return '';
  const rows = t.pinnedItems
    .map((item: PinnedItem) => item.label ? `[${item.label}] ${item.text}` : item.text)
    .join('\n');
  return `<pinned_context>\n${rows}\n</pinned_context>`;
}

export function estimateContextTokenCount(tracker: SessionTracker, assembled: string): number {
  const t = tracker as any;
  return Math.max(1, t.tokenCounter.count(assembled, 'openai'));
}

export function scoreConsciousMemoryEntry(
  queryTokens: string[],
  queryEmbedding: number[],
  text: string,
  timestamp: number,
  boost: number = 0,
): number {
  const lexical = lexicalOverlapScore(queryTokens, text);
  const semantic = cosineSimilarity(buildPseudoEmbedding(text), queryEmbedding);
  const ageMinutes = Math.max(0, (Date.now() - timestamp) / 60_000);
  const recency = Math.max(0, 1 - (ageMinutes / 45));
  return (lexical * 0.55) + (semantic * 0.25) + (recency * 0.10) + boost;
}

export function takeWithinTokenBudget(tracker: SessionTracker, values: string[], maxTokens: number): string[] {
  if (maxTokens <= 0) {
    return [];
  }

  const t = tracker as any;
  const selected: string[] = [];
  let used = 0;

  for (const value of values) {
    const tokens = t.tokenCounter.count(value, 'openai');
    if (used + tokens > maxTokens) {
      continue;
    }
    selected.push(value);
    used += tokens;
  }

  return selected;
}

export function selectConsciousMemoryLines(
  tracker: SessionTracker,
  candidates: Array<{ text: string; timestamp: number; boost?: number }>,
  queryTokens: string[],
  queryEmbedding: number[],
  maxItems: number,
  maxTokens: number,
): string[] {
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreConsciousMemoryEntry(
        queryTokens,
        queryEmbedding,
        candidate.text,
        candidate.timestamp,
        candidate.boost ?? 0,
      ),
    }))
    .filter((candidate) => candidate.score > 0 || (candidate.boost ?? 0) > 0)
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);

  return takeWithinTokenBudget(
    tracker,
    scored.slice(0, Math.max(maxItems * 3, maxItems)).map((candidate) => candidate.text).slice(0, maxItems),
    maxTokens,
  );
}

export async function getSemanticEmbedding(tracker: SessionTracker, text: string): Promise<number[]> {
  const t = tracker as any;
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return buildPseudoEmbedding(text);
  }

  const cached = t.semanticEmbeddingCache.get(normalized);
  if (cached && (Date.now() - cached.createdAt) < t.semanticEmbeddingTTLms) {
    return cached.embedding;
  }

  const provider = getEmbeddingProvider();
  if (provider?.isInitialized()) {
    try {
      const accelerationManager = getActiveAccelerationManager();
      const embedding = accelerationManager
        ? await accelerationManager.runInLane('semantic', () => provider.embed(text))
        : await provider.embed(text);
      t.semanticEmbeddingCache.set(normalized, { embedding, createdAt: Date.now() });
      return embedding;
    } catch (error) {
      console.warn('[SessionTracker] Semantic embedding fallback to pseudo embedding:', error);
    }
  }

  return buildPseudoEmbedding(text);
}

export function semanticRedundancyScore(
  text: string,
  selectedTexts: string[],
  embedding: number[],
  selectedEmbeddings: number[][],
): number {
  if (selectedTexts.length === 0) {
    return 0;
  }

  let maxScore = 0;
  for (let i = 0; i < selectedTexts.length; i++) {
    const semantic = selectedEmbeddings[i]?.length ? cosineSimilarity(embedding, selectedEmbeddings[i]) : 0;
    const lexical = lexicalOverlapScore(tokenizeForMemory(text), selectedTexts[i]);
    maxScore = Math.max(maxScore, Math.max(semantic, lexical));
  }

  return maxScore;
}

export function ensureFacetCoverage(
  queryTokens: string[],
  rankedCandidates: Array<{ item: ContextItem; finalScore: number }>,
  selected: Array<{ item: ContextItem; embedding: number[] }>,
): Array<{ item: ContextItem; embedding: number[] }> {
  const desiredMatchers: Array<(text: string) => boolean> = [];

  if (queryTokens.includes('schema') || queryTokens.includes('model') || queryTokens.includes('data')) {
    desiredMatchers.push((text) => /^data_model:/i.test(text) && /(table|index|append-only|schema|secondary index)/i.test(text));
  }

  if (queryTokens.includes('failure') || queryTokens.includes('failover') || queryTokens.includes('reliability')) {
    desiredMatchers.push((text) => /^failure_modes:/i.test(text));
  }

  if (queryTokens.includes('api') || queryTokens.includes('contract') || queryTokens.includes('interface')) {
    desiredMatchers.push((text) => /^api_contracts:/i.test(text));
  }

  const current = [...selected];
  for (const matcher of desiredMatchers) {
    if (current.some((entry) => matcher(entry.item.text))) {
      continue;
    }

    const candidate = rankedCandidates.find((entry) => matcher(entry.item.text) && !current.some((selectedEntry) => selectedEntry.item.text === entry.item.text));
    if (!candidate) {
      continue;
    }

    current.push({
      item: candidate.item,
      embedding: [],
    });
  }

  return current;
}

export async function rankConsciousContextItems(
  tracker: SessionTracker,
  query: string,
  queryEmbedding: number[],
  candidates: Array<{ item: ContextItem; boost?: number }>,
  tokenBudget: number,
): Promise<ContextItem[]> {
  const t = tracker as any;
  const deduped = new Map<string, { item: ContextItem; boost: number }>();
  for (const candidate of candidates) {
    const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
    const existing = deduped.get(key);
    if (!existing || (candidate.boost ?? 0) > existing.boost) {
      deduped.set(key, {
        item: candidate.item,
        boost: candidate.boost ?? 0,
      });
    }
  }

  const merged = Array.from(deduped.values());
  if (merged.length === 0) {
    return [];
  }

  const documents = merged.map((candidate) => candidate.item.text);
  const bm25Scores = computeBM25Scores(query, documents);
  const maxBm25 = Math.max(1, ...bm25Scores);
  const queryTokens = tokenizeForMemory(query);
  const currentPhase = t.phaseDetector.getCurrentPhase();
  const now = Date.now();

  const preRanked = merged
    .map((candidate, index) => {
      const ageMinutes = Math.max(0, (now - candidate.item.timestamp) / 60_000);
      const recency = Math.exp(-ageMinutes / 20);
      const lexical = lexicalOverlapScore(queryTokens, candidate.item.text);
      const phase = computePhaseAlignmentScore(candidate.item.phase, currentPhase);
      const bm25 = bm25Scores[index] / maxBm25;
      const facetBoost = computeFacetQueryBoost(candidate.item.text, queryTokens);
      return {
        ...candidate,
        bm25,
        lexical,
        phase,
        recency,
        facetBoost,
        preScore: (bm25 * 0.38) + (lexical * 0.22) + (phase * 0.12) + (recency * 0.08) + candidate.boost + facetBoost,
      };
    })
    .sort((left, right) => right.preScore - left.preScore || right.item.timestamp - left.item.timestamp);

  const shortlist = preRanked.slice(0, Math.max(16, Math.min(32, preRanked.length)));
  const semanticEmbeddings = await Promise.all(
    shortlist.map(async (candidate) => ({
      key: `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`,
      embedding: candidate.item.embedding && candidate.item.embedding.length === queryEmbedding.length
        ? candidate.item.embedding
        : await getSemanticEmbedding(tracker, candidate.item.text),
    }))
  );
  const embeddingByKey = new Map(semanticEmbeddings.map((entry) => [entry.key, entry.embedding]));

  const scored = shortlist.map((candidate) => {
    const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
    const semantic = cosineSimilarity(embeddingByKey.get(key) || [], queryEmbedding);
    return {
      ...candidate,
      semantic,
      finalScore: (candidate.bm25 * 0.34)
        + (candidate.lexical * 0.18)
        + (semantic * 0.2)
        + (candidate.phase * 0.1)
        + (candidate.recency * 0.08)
        + candidate.boost
        + candidate.facetBoost,
    };
  }).sort((left, right) => right.finalScore - left.finalScore || right.item.timestamp - left.item.timestamp);
  const rankedCandidates = preRanked.map((candidate) => ({
    item: candidate.item,
    finalScore: candidate.preScore,
  }));

  const selected: Array<{ item: ContextItem; embedding: number[] }> = [];
  let usedTokens = 0;
  const lambda = 0.78;

  while (scored.length > 0) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < scored.length; index++) {
      const candidate = scored[index];
      const candidateTokens = t.tokenCounter.count(candidate.item.text, 'openai');
      if (usedTokens > 0 && usedTokens + candidateTokens > tokenBudget) {
        continue;
      }

      const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
      const embedding = embeddingByKey.get(key) || [];
      const redundancy = semanticRedundancyScore(
        candidate.item.text,
        selected.map((entry) => entry.item.text),
        embedding,
        selected.map((entry) => entry.embedding),
      );
      const mmrScore = (lambda * candidate.finalScore) - ((1 - lambda) * redundancy);
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const [winner] = scored.splice(bestIndex, 1);
    const key = `${winner.item.role}:${winner.item.text.trim().toLowerCase()}`;
    selected.push({
      item: winner.item,
      embedding: embeddingByKey.get(key) || [],
    });
    usedTokens += t.tokenCounter.count(winner.item.text, 'openai');

    if (selected.length >= 12 || usedTokens >= tokenBudget) {
      break;
    }
  }

  return ensureFacetCoverage(queryTokens, rankedCandidates, selected)
    .map((entry) => entry.item)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function inferItemPhase(tracker: SessionTracker, role: ContextItem['role'], text: string): InterviewPhase {
  const t = tracker as any;
  if (role !== 'interviewer') {
    return t.phaseDetector.getCurrentPhase();
  }
  return t.detectPhaseFromTranscript(text);
}

export function getClampedQuery(tracker: SessionTracker, query: string): string {
  const t = tracker as any;
  const trimmed = query.trim();
  if (trimmed.length <= t.ADAPTIVE_QUERY_MAX_LEN) return trimmed;
  return trimmed.slice(0, t.ADAPTIVE_QUERY_MAX_LEN);
}

export function getCacheEntryKey(tracker: SessionTracker, query: string): string {
  const t = tracker as any;
  return `${t.sessionId}:${query.trim().toLowerCase()}`;
}

export function getCachedAssembledContext(tracker: SessionTracker, query: string): string | null {
  const t = tracker as any;
  const key = getCacheEntryKey(tracker, query);
  const entry = t.contextAssembleCache.get(key);
  if (!entry) return null;

  if (entry.revision !== t.transcriptRevision) {
    t.contextAssembleCache.delete(key);
    return null;
  }

  if (Date.now() - entry.createdAt > t.contextCacheTTLms) {
    t.contextAssembleCache.delete(key);
    return null;
  }

  return entry.assembled;
}

export function setCachedAssembledContext(tracker: SessionTracker, query: string, assembled: string): void {
  const t = tracker as any;
  if (t.contextAssembleCache.size >= t.contextCacheMaxEntries) {
    const oldestKey = t.contextAssembleCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      t.contextAssembleCache.delete(oldestKey);
    }
  }

  t.contextAssembleCache.set(getCacheEntryKey(tracker, query), {
    assembled,
    tokenCount: estimateContextTokenCount(tracker, assembled),
    revision: t.transcriptRevision,
    createdAt: Date.now(),
  });
}

export function getAdaptiveFallbackContext(tracker: SessionTracker, tokenBudget: number): ContextItem[] {
  const t = tracker as any;
  // Deterministic fallback ladder:
  // Tier A/B approximation: recency + pinned
  // Tier C: pinned + last N turns
  // NOTE: use tokenBudget / 2 instead of / 4 so fallback still captures
  // meaningful conversation history (~2-4 minutes for typical budgets).
  const lastSeconds = Math.max(60, Math.floor(tokenBudget / 2));
  const recency = t.getContext(lastSeconds);
  const pinnedAsContext: ContextItem[] = t.pinnedItems.map((item: PinnedItem) => ({
    role: 'interviewer',
    text: item.label ? `[${item.label}] ${item.text}` : item.text,
    timestamp: item.pinnedAt,
  }));

  const merged = [...pinnedAsContext, ...recency];
  if (merged.length === 0) {
    return t.getContext(180).slice(-Math.max(4, Math.floor(tokenBudget / 20)));
  }
  return merged;
}

export async function getAdaptiveContext(
  tracker: SessionTracker,
  query: string,
  queryEmbedding: number[],
  tokenBudget: number = 500
): Promise<ContextItem[]> {
  const t = tracker as any;

  if (t.pendingRestorePromise) {
    await t.pendingRestorePromise.catch(() => {
      // restore failures should not block live flow
    });
  }

  if (!isOptimizationActive('useAdaptiveWindow')) {
    return getAdaptiveFallbackContext(tracker, tokenBudget);
  }

  const startedAt = Date.now();
  t.adaptiveWindowStats.calls += 1;

  const candidates: ContextEntry[] = t.contextItemsBuffer.toArray().map((item: ContextItem) => ({
    role: item.role,
    text: item.text,
    timestamp: item.timestamp,
    phase: item.phase ?? t.phaseDetector.getCurrentPhase(),
    embedding: item.embedding,
  }));

  for (const pinned of t.pinnedItems) {
    candidates.push({
      role: 'interviewer',
      text: pinned.label ? `[${pinned.label}] ${pinned.text}` : pinned.text,
      timestamp: pinned.pinnedAt,
      phase: t.phaseDetector.getCurrentPhase(),
      embedding: buildPseudoEmbedding(pinned.text),
    });
  }

  const normalizedQuery = getClampedQuery(tracker, query);
  const effectiveEmbedding = queryEmbedding.length > 0
    ? queryEmbedding
    : buildPseudoEmbedding(normalizedQuery);
  const questionSignal = detectQuestion(normalizedQuery);

  const config: ContextSelectionConfig = {
    tokenBudget,
    recencyWeight: questionSignal.isQuestion ? 0.35 : 0.45,
    semanticWeight: questionSignal.isQuestion ? 0.45 : 0.35,
    phaseAlignmentWeight: 0.2,
  };

  if (!t.adaptiveContextWindow) {
    t.adaptiveContextWindow = new AdaptiveContextWindow();
  }
  const window = t.adaptiveContextWindow;
  window.setCurrentPhase(t.phaseDetector.getCurrentPhase());
  let selected: ContextEntry[];
  try {
    selected = await withTimeout(
      window.selectContext(normalizedQuery, effectiveEmbedding, candidates, config),
      t.ADAPTIVE_WINDOW_TIMEOUT_MS,
      'AdaptiveContextWindow.selectContext'
    );
  } catch (error) {
    t.adaptiveWindowStats.timeouts += 1;
    console.warn('[SessionTracker] Adaptive window timeout, falling back:', error);
    return getAdaptiveFallbackContext(tracker, tokenBudget);
  }

  const duration = Date.now() - startedAt;
  t.adaptiveWindowStats.totalMs += duration;
  if (duration > 50) {
    t.adaptiveWindowStats.over50ms += 1;
  }

  return selected.map((entry: ContextEntry) => ({
    role: entry.role ?? 'interviewer',
    text: entry.text,
    timestamp: entry.timestamp,
  }));
}

export async function getConsciousRelevantContext(tracker: SessionTracker, query: string, tokenBudget: number = 900): Promise<ContextItem[]> {
  const t = tracker as any;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return t.getContext(600).slice(-12);
  }

  const queryEmbedding = await getSemanticEmbedding(tracker, trimmedQuery);
  const adaptive = await getAdaptiveContext(tracker, trimmedQuery, queryEmbedding, Math.max(320, Math.floor(tokenBudget * 0.7)));
  const recentTurns = t.getContext(600).slice(-14);
  const designStateEntries = t.designStateStore.getRetrievalEntries(trimmedQuery, 2).map((entry: any) => ({
    item: {
      role: 'interviewer' as const,
      text: entry.text,
      timestamp: entry.timestamp,
      phase: entry.phase,
      embedding: buildPseudoEmbedding(entry.text),
    },
    boost: entry.boost,
  }));
  const pinnedEntries = t.pinnedItems.map((item: PinnedItem) => ({
    item: {
      role: 'interviewer' as const,
      text: item.label ? `[${item.label}] ${item.text}` : item.text,
      timestamp: item.pinnedAt,
      phase: t.phaseDetector.getCurrentPhase(),
      embedding: buildPseudoEmbedding(item.text),
    },
    boost: 0.2,
  }));
  const constraintEntries = t.extractedConstraints.slice(-8).map((constraint: any) => ({
    item: {
      role: 'interviewer' as const,
      text: `[${constraint.type}] ${constraint.raw}`,
      timestamp: Date.now(),
      phase: t.phaseDetector.getCurrentPhase(),
      embedding: buildPseudoEmbedding(constraint.raw),
    },
    boost: 0.16,
  }));
  const summaryEntries = t.transcriptEpochSummaries.slice(-3).map((summary: string, index: number) => ({
    item: {
      role: 'interviewer' as const,
      text: `[Earlier summary ${index + 1}] ${summary}`,
      timestamp: Date.now() - ((t.transcriptEpochSummaries.length - index) * 60_000),
      phase: t.phaseDetector.getCurrentPhase(),
      embedding: buildPseudoEmbedding(summary),
    },
    boost: 0.12,
  }));

  const ranked = await rankConsciousContextItems(
    tracker,
    trimmedQuery,
    queryEmbedding,
    [
      ...adaptive.map((item: ContextItem) => ({ item, boost: 0.08 })),
      ...recentTurns.map((item: ContextItem) => ({ item, boost: item.role === 'interviewer' ? 0.06 : 0.03 })),
      ...designStateEntries,
      ...pinnedEntries,
      ...constraintEntries,
      ...summaryEntries,
    ],
    Math.max(360, tokenBudget),
  );

  const anchoredRecentTurns = recentTurns.slice(-4);
  const merged = [...ranked, ...anchoredRecentTurns];
  const deduped = new Map<string, ContextItem>();
  for (const item of merged) {
    const key = `${item.role}:${item.text.trim().toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => left.timestamp - right.timestamp);
}

export function getConsciousLongMemoryContext(tracker: SessionTracker, query: string): string {
  const t = tracker as any;
  const activeThread = t.consciousThreadStore.getThreadManager().getActiveThread();
  const latestResponse = t.consciousThreadStore.getLatestConsciousResponse();
  const queryTokens = tokenizeForMemory(query);
  const queryEmbedding = buildPseudoEmbedding(query);
  const designStateBlock = t.designStateStore.buildContextBlock(query);

  t.tokenBudgetManager.reset();
  const allocations = t.tokenBudgetManager.getAllocations();

  const constraintLines = selectConsciousMemoryLines(
    tracker,
    t.extractedConstraints.map((constraint: any) => ({
      text: `[${constraint.type}] ${constraint.raw}`,
      timestamp: Date.now(),
      boost: 0.18,
    })),
    queryTokens,
    queryEmbedding,
    5,
    Math.min(allocations.entities.max, 220),
  );

  const pinnedLines = selectConsciousMemoryLines(
    tracker,
    t.pinnedItems.map((item: PinnedItem) => ({
      text: item.label ? `[${item.label}] ${item.text}` : item.text,
      timestamp: item.pinnedAt,
      boost: 0.22,
    })),
    queryTokens,
    queryEmbedding,
    5,
    Math.min(allocations.entities.max, 240),
  );

  const summaryLines = selectConsciousMemoryLines(
    tracker,
    t.transcriptEpochSummaries.map((summary: string, index: number) => ({
      text: `[Earlier summary ${index + 1}] ${summary}`,
      timestamp: Date.now() - ((t.transcriptEpochSummaries.length - index) * 60_000),
      boost: 0.12,
    })),
    queryTokens,
    queryEmbedding,
    3,
    Math.min(allocations.epochSummaries.max, 420),
  );

  const recentTurns = takeWithinTokenBudget(
    tracker,
    t.contextItemsBuffer.toArray()
      .slice(-10)
      .map((item: ContextItem) => `[${item.role.toUpperCase()}] ${item.text}`),
    Math.min(allocations.recentTranscript.max, 320),
  );

  const lines = [
    '<conscious_long_memory>',
    `CURRENT_PHASE: ${t.phaseDetector.getCurrentPhase()}`,
  ];

  if (activeThread) {
    lines.push(`ACTIVE_THREAD_TOPIC: ${activeThread.topic}`);
    lines.push(`ACTIVE_THREAD_GOAL: ${activeThread.goal}`);
    lines.push(`ACTIVE_THREAD_PHASE: ${activeThread.phase}`);
    lines.push(`ACTIVE_THREAD_TURNS: ${activeThread.turnCount}`);
    if (activeThread.resumeKeywords.length > 0) {
      lines.push(`ACTIVE_THREAD_KEYWORDS: ${activeThread.resumeKeywords.slice(0, 12).join(', ')}`);
    }
    if (activeThread.keyDecisions.length > 0) {
      lines.push(`ACTIVE_THREAD_DECISIONS: ${activeThread.keyDecisions.slice(0, 6).join(' | ')}`);
    }
    if (activeThread.constraints.length > 0) {
      lines.push(`ACTIVE_THREAD_CONSTRAINTS: ${activeThread.constraints.slice(0, 6).join(' | ')}`);
    }
  }

  if (latestResponse) {
    const latestReasoningSummary = [
      latestResponse.openingReasoning,
      latestResponse.implementationPlan[0],
      latestResponse.tradeoffs[0],
      latestResponse.scaleConsiderations[0],
      latestResponse.pushbackResponses[0],
    ].filter(Boolean).join(' ');
    if (latestReasoningSummary) {
      lines.push(`LATEST_REASONING_SUMMARY: ${latestReasoningSummary}`);
    }
  }

  if (constraintLines.length > 0) {
    lines.push('KEY_CONSTRAINTS:');
    lines.push(...constraintLines.map((line: string) => `- ${line}`));
  }

  if (pinnedLines.length > 0) {
    lines.push('PINNED_MEMORY:');
    lines.push(...pinnedLines.map((line: string) => `- ${line}`));
  }

  if (summaryLines.length > 0) {
    lines.push('EARLIER_SESSION_SUMMARIES:');
    lines.push(...summaryLines.map((line: string) => `- ${line}`));
  }

  if (recentTurns.length > 0) {
    lines.push('LATEST_TURNS:');
    lines.push(...recentTurns.map((line: string) => `- ${line}`));
  }

  lines.push('</conscious_long_memory>');
  return designStateBlock
    ? `${lines.join('\n')}\n\n${designStateBlock}`
    : lines.join('\n');
}

export function getFormattedContext(tracker: SessionTracker, lastSeconds: number = 120): string {
  const baseCached = getCachedAssembledContext(tracker, `formatted:${lastSeconds}`);
  if (baseCached) {
    return baseCached;
  }

  const t = tracker as any;

  // Phase-aware context expansion: system design conversations span 5-10 minutes.
  // When in design phases, use a much longer window so early constraints
  // (e.g., "100 invoice PDFs, 1 page each") are not lost.
  const currentPhase = t.phaseDetector.getCurrentPhase();
  const designPhases = new Set(['high_level_design', 'deep_dive', 'scaling_discussion', 'failure_handling']);
  const effectiveLastSeconds = designPhases.has(currentPhase)
    ? Math.max(lastSeconds, 480) // 8 minutes for design phases
    : lastSeconds;

  const items = t.getContext(effectiveLastSeconds);
  const baseContext = items.map((item: ContextItem) => {
    const label = item.role === 'interviewer' ? 'INTERVIEWER' :
      item.role === 'user' ? 'ME' :
        'ASSISTANT (PREVIOUS SUGGESTION)';
    return `[${label}]: ${item.text}`;
  }).join('\n');

  const pinnedSection = buildPinnedContextSection(tracker);
  let assembled = pinnedSection ? `${pinnedSection}\n${baseContext}` : baseContext;

  // Inject meeting metadata so the LLM knows the topic/domain
  const meetingMeta = t.currentMeetingMetadata;
  if (meetingMeta?.title) {
    const metaLine = `[CURRENT_TOPIC]: ${meetingMeta.title}`;
    assembled = `${metaLine}\n${assembled}`;
  }

  setCachedAssembledContext(tracker, `formatted:${lastSeconds}`, assembled);
  return assembled;
}

export function getCompactTranscriptSnapshot(tracker: SessionTracker, maxTurns: number = 12, snapshotType: 'standard' | 'fast' = 'standard'): string {
  const t = tracker as any;
  const cacheKey = `${t.sessionId}:${snapshotType}:${maxTurns}`;
  const cached = t.compactSnapshotCache.get(cacheKey);
  if (cached && cached.revision === t.transcriptRevision) {
    return cached.value;
  }

  const items = t.getContextItems().slice(-maxTurns);
  const snapshot = items.map((item: ContextItem) => ({
    role: item.role,
    text: item.text,
    timestamp: item.timestamp,
  })).map((item: any) => {
    const label = item.role === 'interviewer' ? 'INTERVIEWER' : item.role === 'assistant' ? 'ASSISTANT' : 'ME';
    return `[${label}]: ${item.text}`;
  }).join('\n');

  t.compactSnapshotCache.set(cacheKey, {
    revision: t.transcriptRevision,
    value: snapshot,
  });
  return snapshot;
}

export function buildFullSessionContext(transcript: TranscriptSegment[], epochSummaries: string[]): string {
  const recentTranscript = transcript.map((segment) => {
    const role = mapSpeakerToRole(segment.speaker);
    const label = role === 'interviewer' ? 'INTERVIEWER' :
      role === 'user' ? 'ME' :
        'ASSISTANT';
    return `[${label}]: ${segment.text}`;
  }).join('\n');

  if (epochSummaries.length > 0) {
    const epochContext = epochSummaries.join('\n---\n');
    return `[SESSION HISTORY - EARLIER DISCUSSION]\n${epochContext}\n\n[RECENT TRANSCRIPT]\n${recentTranscript}`;
  }

  return recentTranscript;
}
