import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FlexibleResponseRouter } from '../conscious/FlexibleResponseRouter';

describe('FlexibleResponseRouter', () => {
  const router = new FlexibleResponseRouter();

  it('returns a strict legacy plan when the flag is disabled', () => {
    const plan = router.plan({
      utterance: 'Hi there',
      options: { enabled: false },
    });
    assert.strictEqual(plan.conversationKind, 'technical');
    assert.strictEqual(plan.responseShape, 'structured');
    assert.strictEqual(plan.verificationLevel, 'strict');
    assert.strictEqual(plan.verification.runProvenance, true);
    assert.strictEqual(plan.verification.runJudge, true);
    assert.strictEqual(plan.shouldBypassConscious, false);
  });

  it('routes smalltalk to bypass + free-form when flag is enabled', () => {
    const plan = router.plan({
      utterance: 'Hi',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'smalltalk');
    assert.strictEqual(plan.responseShape, 'free_form');
    assert.strictEqual(plan.shouldBypassConscious, true);
    assert.strictEqual(plan.verification.runJudge, false);
    assert.strictEqual(plan.verification.runProvenance, false);
  });

  it('routes acknowledgements to bypass + free-form', () => {
    const plan = router.plan({
      utterance: 'Got it',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'acknowledgement');
    assert.strictEqual(plan.shouldBypassConscious, true);
  });

  it('routes refinement requests with the right intent and relaxed verification', () => {
    const plan = router.plan({
      utterance: 'Make it shorter please',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'refinement');
    assert.strictEqual(plan.refinementIntent, 'shorten');
    assert.strictEqual(plan.responseShape, 'free_form');
    assert.strictEqual(plan.verification.runProvenance, false);
    assert.strictEqual(plan.verification.runDeterministic, true);
    // Refinement still routes through conscious (the orchestrator builds a refinement prompt).
    assert.strictEqual(plan.shouldBypassConscious, false);
  });

  it('routes clarification turns through relaxed verification', () => {
    const plan = router.plan({
      utterance: 'What do you mean?',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'clarification');
    assert.strictEqual(plan.verification.runProvenance, false);
    assert.strictEqual(plan.verification.runJudge, false);
  });

  it('keeps strict verification for technical questions even with the flag on', () => {
    const plan = router.plan({
      utterance: 'How would you design a distributed rate limiter?',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'technical');
    assert.strictEqual(plan.responseShape, 'structured');
    assert.strictEqual(plan.verificationLevel, 'strict');
    assert.strictEqual(plan.verification.runProvenance, true);
    assert.strictEqual(plan.verification.runJudge, true);
  });

  it('classifies off-topic asides at moderate verification', () => {
    const plan = router.plan({
      utterance: 'By the way, what about Redis Streams?',
      options: { enabled: true },
    });
    assert.strictEqual(plan.conversationKind, 'off_topic_aside');
    assert.strictEqual(plan.verificationLevel, 'moderate');
    assert.strictEqual(plan.verification.runJudge, false);
    assert.strictEqual(plan.verification.runProvenance, true);
  });
});
