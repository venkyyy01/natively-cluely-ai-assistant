/**
 * NAT-207: Golden interview transcript fixture — 5 probe turns.
 * Used by twoTierAnswerContract.test.ts to gate the Two-Tier contract.
 */
import type { ConsciousModeStructuredResponse } from '../../ConsciousMode';

const EMPTY_RESPONSE: ConsciousModeStructuredResponse = {
  mode: 'reasoning_first',
  openingReasoning: "So basically I'd use a sliding window with a deque to track the max.",
  implementationPlan: [
    'Iterate with right pointer, shrink left when window exceeds k.',
    'Deque stores indices, front is always the max index.',
    'Pop from back if current element >= deque back.',
  ],
  tradeoffs: ['O(n) time, O(k) space — optimal for streaming input.'],
  edgeCases: ['k=0 returns empty; all-same values keep front stable.'],
  scaleConsiderations: [],
  pushbackResponses: [],
  likelyFollowUps: ['What if k > n?', 'Can you do it in-place?'],
  codeTransition: "I'll code this up now.",
  codingInterviewAnswer: null,
  behavioralAnswer: null,
};

export interface GoldenTurn {
  question: string;
  /** Expected probe type if routed via Two-Tier */
  expectedProbeType?: string;
}

export const GOLDEN_TRANSCRIPT: GoldenTurn[] = [
  { question: 'What is the time complexity of your sliding window approach?', expectedProbeType: 'complexity' },
  { question: 'What edge cases does your deque solution miss?', expectedProbeType: 'edge_case' },
  { question: 'What are the tradeoffs between using a deque vs a sorted structure?', expectedProbeType: 'tradeoff' },
  { question: 'Why a deque and not a max-heap?', expectedProbeType: 'data_structure' },
  { question: 'Could you solve this without extra space instead?', expectedProbeType: 'alternative' },
];

export const GOLDEN_ROOT_RESPONSE = EMPTY_RESPONSE;
