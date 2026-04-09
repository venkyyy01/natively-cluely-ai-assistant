import test from 'node:test';
import assert from 'node:assert/strict';
import { runConsciousEvalHarness } from '../conscious/ConsciousEvalHarness';
import { ConsciousVerifier } from '../conscious/ConsciousVerifier';

test('Conscious eval harness runs default scenarios and produces a summary', async () => {
  const { results, summary } = await runConsciousEvalHarness({
    verifier: new ConsciousVerifier(),
  });

  assert.equal(summary.total, results.length);
  assert.ok(summary.total > 0);
  assert.equal(summary.failed, 0);
});
