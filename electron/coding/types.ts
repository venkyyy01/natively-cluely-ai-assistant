/**
 * NAT-201: Shared coding / two-tier types.
 * NAT-301: CodingProblem schema added here.
 */

// ─── Two-Tier: ProbeAnswer ────────────────────────────────────────────────────

export const PROBE_ANSWER_SCHEMA_VERSION = 'probe_answer_v1' as const;

export type ProbeType =
  | 'complexity'
  | 'edge_case'
  | 'tradeoff'
  | 'pushback'
  | 'alternative'
  | 'data_structure'
  | 'generic';

export interface ProbeDelta {
  /** Single declarative fact to splice into the root response (≤ 1 sentence) */
  fact: string;
  /** Key of the root array to append to: 'tradeoffs' | 'edgeCases' | 'implementationPlan' */
  attachTo: 'tradeoffs' | 'edgeCases' | 'implementationPlan';
}

export interface ProbeAnswer {
  schemaVersion: typeof PROBE_ANSWER_SCHEMA_VERSION;
  probeType: ProbeType;
  question: string;
  /** Spoken answer — max 4 sentences */
  answer: string;
  /** Optional single fact to apply exactly once to the immutable root */
  delta?: ProbeDelta;
  confidence: number;
  createdAt: number;
}

export type ParseError =
  | { kind: 'invalid_json'; raw: string }
  | { kind: 'schema_mismatch'; raw: string; missing: string[] }
  | { kind: 'empty_answer'; raw: string };

export type Result<T, E> = { success: true; data: T } | { success: false; error: E };

/** Parse a raw LLM string into a ProbeAnswer. Never throws. */
export function parseProbeAnswer(raw: string): Result<ProbeAnswer, ParseError> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { success: false, error: { kind: 'empty_answer', raw } };
  }

  const jsonCandidate = extractJson(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return { success: false, error: { kind: 'invalid_json', raw } };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { success: false, error: { kind: 'schema_mismatch', raw, missing: ['<object>'] } };
  }

  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (!obj.answer || typeof obj.answer !== 'string') missing.push('answer');
  if (!obj.question || typeof obj.question !== 'string') missing.push('question');

  if (missing.length > 0) {
    return { success: false, error: { kind: 'schema_mismatch', raw, missing } };
  }

  const probe: ProbeAnswer = {
    schemaVersion: PROBE_ANSWER_SCHEMA_VERSION,
    probeType: isProbeType(obj.probeType) ? obj.probeType : 'generic',
    question: obj.question as string,
    answer: obj.answer as string,
    delta: parseDelta(obj.delta),
    confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.8,
    createdAt: Date.now(),
  };

  if (!probe.delta) {
    delete probe.delta;
  }

  return { success: true, data: probe };
}

function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return raw.slice(first, last + 1);
  return raw;
}

function isProbeType(value: unknown): value is ProbeType {
  return typeof value === 'string' && [
    'complexity', 'edge_case', 'tradeoff', 'pushback',
    'alternative', 'data_structure', 'generic',
  ].includes(value);
}

function parseDelta(raw: unknown): ProbeDelta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.fact !== 'string' || !d.fact.trim()) return undefined;
  const validTargets = ['tradeoffs', 'edgeCases', 'implementationPlan'];
  if (!validTargets.includes(d.attachTo as string)) return undefined;
  return { fact: d.fact, attachTo: d.attachTo as ProbeDelta['attachTo'] };
}

// ─── NAT-301: CodingProblem ───────────────────────────────────────────────────

export const CODING_PROBLEM_SCHEMA_VERSION = 'coding_problem_v1' as const;

export type ProblemType =
  | 'arrays'
  | 'strings'
  | 'linked_list'
  | 'trees'
  | 'graphs'
  | 'dynamic_programming'
  | 'backtracking'
  | 'binary_search'
  | 'heap_priority_queue'
  | 'hash_map'
  | 'two_pointers'
  | 'sliding_window'
  | 'stack_queue'
  | 'greedy'
  | 'design'
  | 'system_design'
  | 'unknown';

export interface CodingExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface CodingProblem {
  schemaVersion: typeof CODING_PROBLEM_SCHEMA_VERSION;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'unknown';
  source?: string;
  problemStatement: string;
  examples: CodingExample[];
  constraints: string[];
  problemType: ProblemType;
  inputSpec?: string;
  outputSpec?: string;
  rawOcr?: string;
  extractedAt: number;
  /** True when only OCR succeeded; vision extraction failed */
  extraction_partial?: boolean;
}
