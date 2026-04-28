import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseFingerprinter } from '../conscious/ResponseFingerprint';

test('ResponseFingerprinter flags exact duplicates', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  fingerprinter.record('I would start with a token bucket.');

  const duplicate = fingerprinter.isDuplicate('I would start with a token bucket.');
  assert.equal(duplicate.isDupe, true);
});

test('ResponseFingerprinter keeps bounded hash history', () => {
  const fingerprinter = new ResponseFingerprinter(3);
  fingerprinter.record('A');
  fingerprinter.record('B');
  fingerprinter.record('C');
  fingerprinter.record('D');

  assert.equal(fingerprinter.getHashes().length, 3);
});
