import test from 'node:test';
import assert from 'node:assert/strict';
import { detectQuestion } from '../conscious/QuestionDetector';

test('detectQuestion recognizes direct questions with high confidence', () => {
  const detection = detectQuestion('How would you design this system?');
  assert.equal(detection.isQuestion, true);
  assert.ok(detection.confidence >= 0.6);
  assert.equal(detection.questionType, 'information');
});

test('detectQuestion recognizes clarification prompts', () => {
  const detection = detectQuestion('Could you clarify what exactly you mean by scale?');
  assert.equal(detection.isQuestion, true);
  assert.equal(detection.questionType, 'clarification');
});

test('detectQuestion does not misclassify plain statements', () => {
  const detection = detectQuestion('I can walk through the architecture now');
  assert.equal(detection.isQuestion, false);
});
