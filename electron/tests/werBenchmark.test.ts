import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWER,
  computeDiarizationAccuracy,
  type DiarizedTurn,
} from '../audio/WERBenchmark';

test('NAT-085: WER is 0 for identical strings', () => {
  const result = computeWER('hello world', 'hello world');
  assert.equal(result.wer, 0);
  assert.equal(result.substitutions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.insertions, 0);
});

test('NAT-085: WER handles single substitution', () => {
  const result = computeWER('hello world', 'hello there');
  assert.equal(result.substitutions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.insertions, 0);
  assert.equal(result.wer, 0.5);
});

test('NAT-085: WER handles single deletion', () => {
  const result = computeWER('hello world test', 'hello test');
  assert.equal(result.deletions, 1);
  assert.equal(result.insertions, 0);
  assert.equal(result.substitutions, 0);
  assert.equal(result.wer, 1 / 3);
});

test('NAT-085: WER handles single insertion', () => {
  const result = computeWER('hello test', 'hello world test');
  assert.equal(result.insertions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.substitutions, 0);
  assert.equal(result.wer, 0.5);
});

test('NAT-085: WER is 1 for completely different text', () => {
  const result = computeWER('apple banana', 'x y z w');
  assert.equal(result.wer, 1);
});

test('NAT-085: WER ignores punctuation and case', () => {
  const result = computeWER('Hello, World!', 'hello world');
  assert.equal(result.wer, 0);
});

test('NAT-085: WER for empty reference with non-empty hypothesis is 1', () => {
  const result = computeWER('', 'some words');
  assert.equal(result.wer, 1);
});

test('NAT-085: WER for empty reference and empty hypothesis is 0', () => {
  const result = computeWER('', '');
  assert.equal(result.wer, 0);
});

test('NAT-085: diarization accuracy is 1 when all speakers match', () => {
  const ref: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
    { speaker: 'B', text: 'hi there' },
  ];
  const result = computeDiarizationAccuracy(ref, ref);
  assert.equal(result.accuracy, 1);
  assert.equal(result.turns.every((t) => t.correct), true);
});

test('NAT-085: diarization accuracy drops on speaker mismatch', () => {
  const ref: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
    { speaker: 'B', text: 'hi there' },
  ];
  const hyp: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
    { speaker: 'A', text: 'hi there' },
  ];
  const result = computeDiarizationAccuracy(ref, hyp);
  assert.equal(result.accuracy, 0.5);
  assert.equal(result.turns[0].correct, true);
  assert.equal(result.turns[1].correct, false);
});

test('NAT-085: diarization accuracy handles missing turns', () => {
  const ref: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
    { speaker: 'B', text: 'hi there' },
  ];
  const hyp: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
  ];
  const result = computeDiarizationAccuracy(ref, hyp);
  assert.equal(result.accuracy, 0.5);
});

test('NAT-085: diarization accuracy handles extra turns', () => {
  const ref: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
  ];
  const hyp: DiarizedTurn[] = [
    { speaker: 'A', text: 'hello' },
    { speaker: 'B', text: 'extra' },
  ];
  const result = computeDiarizationAccuracy(ref, hyp);
  assert.equal(result.accuracy, 0.5);
});
