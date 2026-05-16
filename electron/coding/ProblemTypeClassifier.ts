/**
 * NAT-302: ProblemTypeClassifier.
 * Two-pass: regex fast-path (no LLM), then optional LLM classification.
 * SHA-256 cached per problem statement.
 */
import crypto from 'crypto';
import type { ProblemType } from './types';

const TYPE_RULES: Array<{ patterns: RegExp[]; type: ProblemType }> = [
  { patterns: [/\bdynamic\s+programming\b/i, /\bdp\b.*table/i, /\bmemoiz/i, /\btabulation\b/i], type: 'dynamic_programming' },
  { patterns: [/\bbacktrack/i, /\bpermutation\b.*recursi/i, /\bsubset\b.*recursi/i], type: 'backtracking' },
  { patterns: [/\bbinary\s+search\b/i, /\bsorted\s+array\b.*find\b/i], type: 'binary_search' },
  { patterns: [/\bbinary\s+tree\b/i, /\btree\b.*\b(traversal|inorder|preorder|postorder|root|leaf|node)\b/i, /\binorder\b/i, /\bpreorder\b/i, /\bpostorder\b/i, /\bBST\b/i, /\broot\s*->\s*left\b/i], type: 'trees' },
  { patterns: [/\bgraph\b/i, /\bBFS\b/i, /\bDFS\b/i, /\badjacency\s+(list|matrix)\b/i, /\bshortest\s+path\b/i], type: 'graphs' },
  { patterns: [/\blinked\s+list\b/i, /\bsingly\s+linked\b/i, /\bdoubly\s+linked\b/i, /\bListNode\b/i], type: 'linked_list' },
  { patterns: [/\bheap\b/i, /\bpriority\s+queue\b/i, /\bkth\s+largest\b/i, /\bkth\s+smallest\b/i], type: 'heap_priority_queue' },
  { patterns: [/\bhash\s*map\b/i, /\bhash\s*table\b/i, /\bfrequency\s+count\b/i, /\blookup\s+in\s+O\(1\)\b/i], type: 'hash_map' },
  { patterns: [/\btwo[\s-]pointer\b/i, /\bleft.*right.*pointer\b/i], type: 'two_pointers' },
  { patterns: [/\bsliding\s+window\b/i, /\bcontiguous\s+subarray\b.*max\b/i], type: 'sliding_window' },
  { patterns: [/\bstack\b/i, /\bqueue\b/i, /\bbalanced\s+parenthes/i, /\bmonoton\b/i], type: 'stack_queue' },
  { patterns: [/\bgreedy\b/i, /\binterval\s+scheduling\b/i], type: 'greedy' },
  { patterns: [/\bsystem\s+design\b/i, /\bdesign\s+a\s+(scalable|distributed|real-time)\b/i], type: 'system_design' },
  { patterns: [/\bdesign\b.*\b(class|data\s+structure|cache|lru|lfu)\b/i, /\bimplement\s+a\b.*\b(class|data\s+structure|cache)\b/i, /\bdesign\b.*\bimplement\b.*\bget\b.*\bput\b/i], type: 'design' },
  { patterns: [/\bpalindrome\b/i, /\banagram\b/i, /\bsubstring\b/i, /\bstring\s+compression\b/i], type: 'strings' },
  { patterns: [/\barray\b/i, /\bmatrix\b/i, /\bsubarray\b/i, /\brotate\s+array\b/i], type: 'arrays' },
];

const classifyCache = new Map<string, ProblemType>();

/** Regex fast-path classification — synchronous, no network. */
export function classifyProblemTypeFromText(text: string): ProblemType {
  const cacheKey = crypto.createHash('sha256').update(text.slice(0, 500)).digest('hex');
  const cached = classifyCache.get(cacheKey);
  if (cached) return cached;

  for (const { patterns, type } of TYPE_RULES) {
    if (patterns.some((p) => p.test(text))) {
      classifyCache.set(cacheKey, type);
      return type;
    }
  }
  classifyCache.set(cacheKey, 'unknown');
  return 'unknown';
}

const LLM_CLASSIFY_PROMPT = (types: ProblemType[]) => `Classify the coding problem into exactly one type from this list:
${types.join(', ')}

Respond with ONLY the type string — no explanation, no punctuation.`;

const ALL_TYPES: ProblemType[] = [
  'arrays', 'strings', 'linked_list', 'trees', 'graphs', 'dynamic_programming',
  'backtracking', 'binary_search', 'heap_priority_queue', 'hash_map',
  'two_pointers', 'sliding_window', 'stack_queue', 'greedy', 'design',
  'system_design', 'unknown',
];

export type LLMClassifyCall = (prompt: string, problemText: string) => Promise<string>;

/** LLM-backed classification — only called when regex returns 'unknown'. */
export async function classifyProblemTypeWithLLM(
  text: string,
  llmCall: LLMClassifyCall,
): Promise<ProblemType> {
  const regexResult = classifyProblemTypeFromText(text);
  if (regexResult !== 'unknown') return regexResult;

  try {
    const cacheKey = crypto.createHash('sha256').update(text.slice(0, 500)).digest('hex') + ':llm';
    if (classifyCache.has(cacheKey)) return classifyCache.get(cacheKey)!;

    const raw = await llmCall(LLM_CLASSIFY_PROMPT(ALL_TYPES), text.slice(0, 1500));
    const candidate = raw.trim().toLowerCase().replace(/[^a-z_]/g, '') as ProblemType;
    const result: ProblemType = ALL_TYPES.includes(candidate) ? candidate : 'unknown';
    classifyCache.set(cacheKey, result);
    return result;
  } catch {
    return 'unknown';
  }
}
