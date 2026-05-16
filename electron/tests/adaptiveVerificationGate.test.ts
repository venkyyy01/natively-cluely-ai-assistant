import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AdaptiveVerificationGate } from '../conscious/AdaptiveVerificationGate';

describe('AdaptiveVerificationGate', () => {
  const gate = new AdaptiveVerificationGate();

  it('runs the full pipeline at strict level', () => {
    const plan = gate.buildPlan('strict');
    assert.deepStrictEqual(
      { provenance: plan.runProvenance, deterministic: plan.runDeterministic, judge: plan.runJudge },
      { provenance: true, deterministic: true, judge: true },
    );
  });

  it('skips the judge at moderate level', () => {
    const plan = gate.buildPlan('moderate');
    assert.strictEqual(plan.runProvenance, true);
    assert.strictEqual(plan.runDeterministic, true);
    assert.strictEqual(plan.runJudge, false);
  });

  it('runs only deterministic rules at relaxed level', () => {
    const plan = gate.buildPlan('relaxed');
    assert.strictEqual(plan.runProvenance, false);
    assert.strictEqual(plan.runDeterministic, true);
    assert.strictEqual(plan.runJudge, false);
  });

  it('skips everything at skip level', () => {
    const plan = gate.buildPlan('skip');
    assert.strictEqual(plan.runProvenance, false);
    assert.strictEqual(plan.runDeterministic, false);
    assert.strictEqual(plan.runJudge, false);
  });

  it('applyDegradedMode forces judge off without changing other gates', () => {
    const strict = gate.buildPlan('strict');
    const degraded = gate.applyDegradedMode(strict, true);
    assert.strictEqual(degraded.runProvenance, true);
    assert.strictEqual(degraded.runDeterministic, true);
    assert.strictEqual(degraded.runJudge, false);
    assert.ok(degraded.reason.includes('degraded'));
  });

  it('applyDegradedMode is a no-op when not degraded', () => {
    const strict = gate.buildPlan('strict');
    const same = gate.applyDegradedMode(strict, false);
    assert.deepStrictEqual(same, strict);
  });

  it('applyExplicitSkipJudge forces judge off when requested', () => {
    const strict = gate.buildPlan('strict');
    const skipped = gate.applyExplicitSkipJudge(strict, true);
    assert.strictEqual(skipped.runJudge, false);
    assert.ok(skipped.reason.includes('skip_judge'));
  });

  it('applyExplicitSkipJudge is a no-op when skipJudge is false', () => {
    const strict = gate.buildPlan('strict');
    const same = gate.applyExplicitSkipJudge(strict, false);
    assert.deepStrictEqual(same, strict);
  });

  it('defaults unknown verification levels to strict for safety', () => {
    // @ts-expect-error -- intentional invalid input.
    const plan = gate.buildPlan('not-a-real-level');
    assert.strictEqual(plan.runProvenance, true);
    assert.strictEqual(plan.runDeterministic, true);
    assert.strictEqual(plan.runJudge, true);
  });
});
