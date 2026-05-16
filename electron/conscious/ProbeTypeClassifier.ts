/**
 * NAT-204: Probe-type classifier.
 * Regex-first with LLM fallback.  All paths are synchronous unless the caller
 * explicitly wants the LLM fallback via classifyWithLLM().
 */
import type { ProbeType } from '../coding/types';

const PROBE_RULES: Array<{ pattern: RegExp; type: ProbeType }> = [
  { pattern: /\bbig[\s-]?o\b|\bcomplexi(ty|ties)\b|\btime.{0,20}space\b|\bspace.{0,20}time\b|\bO\([^)]{1,30}\)/i, type: 'complexity' },
  { pattern: /\bedge[\s-]?case\b|\bcorner[\s-]?case\b|\boverflow\b|\bunderflow\b|\bnull\b|\bempty\b|\bnegative\b|\bwrap.?around\b/i, type: 'edge_case' },
  { pattern: /\btradeoff\b|\btrade[\s-]?off\b|\bpros?\b.{0,20}\bcons?\b|\bupside\b|\bdownside\b|\bcompromise\b/i, type: 'tradeoff' },
  { pattern: /\bwhy (did you|not|this|choose|use|pick)\b|\bdefend\b|\bjustif(y|ied)\b|\bchallenge\b|\bpushback\b/i, type: 'pushback' },
  { pattern: /\binstead\b|\balternative\b|\bother (?:way|approach|option|solution)\b|\bdifferent (?:approach|way)\b|\bcould you also\b/i, type: 'alternative' },
  { pattern: /\bdata[\s-]?structure\b|\bwhy (?:a |an )?(hash|tree|heap|trie|queue|stack|graph|linked)\b|\barray vs\b|\bwhich data\b/i, type: 'data_structure' },
];

/** Fast regex classify — O(k) where k = number of rules */
export function classifyProbeType(question: string): ProbeType {
  const lower = question.toLowerCase();
  for (const { pattern, type } of PROBE_RULES) {
    if (pattern.test(lower)) {
      return type;
    }
  }
  return 'generic';
}

/**
 * Returns true when this probe question should bypass Tier-B and trigger a
 * full Tier-A reset instead.  Behavioral re-asks always go through Tier-A.
 */
export function isBehavioralReask(question: string): boolean {
  const lower = question.toLowerCase();
  return (
    /\btell me about a time\b/.test(lower)
    || /\bdescribe a (time|situation)\b/.test(lower)
    || /\bgive me an example\b/.test(lower)
    || /\bwalk me through\b/.test(lower)
    || /\bhow do you handle\b/.test(lower)
    || /\bstar\s+(story|method|format)\b/.test(lower)
  );
}
