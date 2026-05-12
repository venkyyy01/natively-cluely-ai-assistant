/**
 * NAT-306: Golden problem extractor CI gate.
 * Validates that parseProbeAnswer / classifyProblemTypeFromText / ProblemTypeClassifier
 * produce correct outputs on 12 canonical LeetCode-style problems.
 * No screenshots needed — we exercise the pure parse+classify layer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProblemTypeFromText } from '../coding/ProblemTypeClassifier';
import { parseProbeAnswer } from '../coding/types';
import type { ProblemType } from '../coding/types';

interface GoldenProblem {
  title: string;
  text: string;
  expectedType: ProblemType;
}

const GOLDEN_PROBLEMS: GoldenProblem[] = [
  {
    title: 'Two Sum',
    text: 'Given an array of integers, find two numbers that add up to target. Use a hash map for O(1) lookup.',
    expectedType: 'hash_map',
  },
  {
    title: 'Sliding Window Maximum',
    text: 'Given an array and integer k, return max of each sliding window of size k.',
    expectedType: 'sliding_window',
  },
  {
    title: 'Linked List Cycle',
    text: 'Given head of a linked list, determine if it has a cycle.',
    expectedType: 'linked_list',
  },
  {
    title: 'Binary Tree Level Order',
    text: 'Given root of a binary tree, return level order traversal. Use BFS with a queue.',
    expectedType: 'trees',
  },
  {
    title: 'Coin Change',
    text: 'Given coins and amount, find minimum coins using dynamic programming (tabulation).',
    expectedType: 'dynamic_programming',
  },
  {
    title: 'Word Ladder',
    text: 'Find shortest transformation sequence using BFS on a graph where adjacent words differ by one letter.',
    expectedType: 'graphs',
  },
  {
    title: 'Binary Search',
    text: 'Given a sorted array, find target using binary search returning index or -1.',
    expectedType: 'binary_search',
  },
  {
    title: 'K Closest Points',
    text: 'Return k closest points to origin. Use a max-heap (priority queue) to maintain k smallest distances.',
    expectedType: 'heap_priority_queue',
  },
  {
    title: 'Trapping Rain Water',
    text: 'Given height array, compute water trapped between bars. Use two-pointer approach from left and right.',
    expectedType: 'two_pointers',
  },
  {
    title: 'Valid Parentheses',
    text: 'Use a stack to validate balanced parentheses. Push opening, pop on closing match.',
    expectedType: 'stack_queue',
  },
  {
    title: 'LRU Cache',
    text: 'Design a data structure that implements get and put for LRU cache in O(1).',
    expectedType: 'design',
  },
  {
    title: 'N-Queens',
    text: 'Place N queens on NxN chessboard using backtracking. Recurse row by row, prune invalid placements.',
    expectedType: 'backtracking',
  },
];

for (const { title, text, expectedType } of GOLDEN_PROBLEMS) {
  test(`NAT-306: [${title}] classifies as '${expectedType}'`, () => {
    const result = classifyProblemTypeFromText(text);
    assert.equal(result, expectedType, `"${title}" expected type '${expectedType}', got '${result}'`);
  });
}

test('NAT-306: parseProbeAnswer works on all 7 probe types', () => {
  const probeTypes = ['complexity', 'edge_case', 'tradeoff', 'pushback', 'alternative', 'data_structure', 'generic'];
  for (const probeType of probeTypes) {
    const raw = JSON.stringify({
      schemaVersion: 'probe_answer_v1',
      probeType,
      question: `What about ${probeType}?`,
      answer: `This is the answer about ${probeType}.`,
      confidence: 0.9,
    });
    const result = parseProbeAnswer(raw);
    assert.ok(result.success, `parseProbeAnswer failed for probeType='${probeType}'`);
    if (result.success) {
      assert.equal(result.data.probeType, probeType);
    }
  }
});

test('NAT-306: parseProbeAnswer fence-strips code blocks', () => {
  const raw = '```json\n{"probeType":"generic","question":"Q?","answer":"A."}\n```';
  const result = parseProbeAnswer(raw);
  assert.ok(result.success, 'Should parse JSON inside fenced code block');
});

test('NAT-306: parseProbeAnswer clamped confidence 0..1', () => {
  const raw = JSON.stringify({ question: 'Q?', answer: 'A.', confidence: 1.5 });
  const result = parseProbeAnswer(raw);
  if (result.success) {
    assert.ok(result.data.confidence <= 1.0, 'confidence must be clamped to <= 1.0');
  }
});
