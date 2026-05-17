import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousAnswerPlanner } from '../conscious/ConsciousAnswerPlanner';

test('ConsciousAnswerPlanner selects tradeoff_defense for tradeoff probes', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What are the tradeoffs?',
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.91,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
  });

  assert.equal(plan.answerShape, 'tradeoff_defense');
  assert.deepEqual(plan.focalFacets, ['tradeoffs']);
  assert.ok(planner.buildContextBlock(plan).includes('ANSWER_SHAPE: tradeoff_defense'));
});

test('ConsciousAnswerPlanner selects metric_backed_answer for metric probes', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What metrics would you watch?',
    reaction: {
      kind: 'metric_probe',
      confidence: 0.88,
      cues: ['metric_language'],
      targetFacets: ['scaleConsiderations'],
      shouldContinueThread: true,
    },
    hypothesis: null,
  });

  assert.equal(plan.answerShape, 'metric_backed_answer');
});

test('ConsciousAnswerPlanner emits mandatory interview structure for live coding questions', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Write the debounce function in TypeScript.',
    reaction: null,
    hypothesis: null,
  });

  assert.equal(plan.questionMode, 'live_coding');
  assert.equal(plan.deliveryFormat, 'mandatory_interview_coding_structure');
  assert.equal(plan.deliveryStyle, 'structured_senior_candidate');
  assert.ok(plan.maxWords >= 260);
  assert.ok(plan.focalFacets.includes('codingInterviewAnswer'));
  assert.ok(plan.focalFacets.includes('codeTransition'));
  assert.match(planner.buildContextBlock(plan), /QUESTION_MODE: live_coding/);
  assert.match(planner.buildContextBlock(plan), /DELIVERY_FORMAT: mandatory_interview_coding_structure/);
  assert.match(planner.buildContextBlock(plan), /A\/B\/C\/D interview structure/);
});

test('ConsciousAnswerPlanner converts behavioral questions into short grounded narrative hints', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Tell me about a time you handled disagreement on a team.',
    reaction: null,
    hypothesis: null,
  });

  assert.equal(plan.questionMode, 'behavioral');
  assert.equal(plan.answerShape, 'example_answer');
  assert.equal(plan.deliveryFormat, 'full_star_narrative');
  assert.equal(plan.deliveryStyle, 'first_person_professional');
  assert.ok(plan.maxWords <= 250);
  assert.match(planner.buildContextBlock(plan), /GROUNDING_HINT: Ground the answer in concrete past experience/);
});

test('ConsciousAnswerPlanner uses strong coding intent to force live-coding mode for ambiguous prompts', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Can you show me how you would approach this?',
    reaction: null,
    hypothesis: null,
    intentResult: {
      intent: 'coding',
      confidence: 0.94,
      answerShape: 'Provide a full implementation.',
    },
  });

  assert.equal(plan.questionMode, 'live_coding');
  assert.equal(plan.deliveryFormat, 'mandatory_interview_coding_structure');
});

test('ConsciousAnswerPlanner uses screenshot-backed live coding to force live-coding mode', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Can you show me how you would approach this?',
    reaction: null,
    hypothesis: null,
    forceLiveCoding: true,
  });

  assert.equal(plan.questionMode, 'live_coding');
  assert.equal(plan.deliveryFormat, 'mandatory_interview_coding_structure');
});

test('ConsciousAnswerPlanner uses strong deep-dive intent to force system-design mode', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What tradeoffs matter most here?',
    reaction: null,
    hypothesis: null,
    intentResult: {
      intent: 'deep_dive',
      confidence: 0.91,
      answerShape: 'Discuss the tradeoffs directly.',
    },
  });

  assert.equal(plan.questionMode, 'system_design');
  // NAT-CM-AUDIT: with no thread follow-up count provided, the planner treats
  // this as a fresh design and uses the requirements-aware delivery format.
  // For probes (threadFollowUpCount > 0) it falls back to architecture_then_tradeoffs.
  assert.ok(
    plan.deliveryFormat === 'requirements_then_architecture_then_tradeoffs'
    || plan.deliveryFormat === 'architecture_then_tradeoffs',
    `unexpected delivery format: ${plan.deliveryFormat}`,
  );
});

// NAT-CM-AUDIT — System design depth & phase awareness ─────────────────────

test('Fresh system design gets generous word budget and full-walk delivery format', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Design a URL shortener that handles 100 million daily requests.',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 0,
  });

  assert.equal(plan.questionMode, 'system_design');
  assert.equal(plan.deliveryFormat, 'requirements_then_architecture_then_tradeoffs');
  // Fresh designs need real room: at least 200 words, no hard cap below.
  assert.ok(plan.maxWords >= 200, `expected fresh design >=200 words, got ${plan.maxWords}`);
  // Focal facets must include the canonical design dimensions.
  assert.ok(plan.focalFacets.includes('capacity'));
  assert.ok(plan.focalFacets.includes('partitioning'));
  assert.ok(plan.focalFacets.includes('failureModes'));
});

test('System design probe (threadFollowUpCount > 0) stays tight and anchored', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'How would you partition the storage layer?',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 2,
  });

  assert.equal(plan.questionMode, 'system_design');
  // Probes are tight — stay under 100.
  assert.ok(plan.maxWords <= 100, `expected probe <=100 words, got ${plan.maxWords}`);
  assert.equal(plan.deliveryFormat, 'architecture_then_tradeoffs');
});

test('System design in requirements_gathering phase clarifies before designing', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Design a notification system.',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 0,
    interviewPhase: 'requirements_gathering',
  });

  assert.equal(plan.answerShape, 'clarification_answer');
  assert.equal(plan.deliveryFormat, 'requirements_clarification');
  assert.ok(plan.focalFacets.includes('requirements'));
});

test('System design in scaling_discussion phase prioritizes capacity facets', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'How does this scale to 10x the load?',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 1,
    interviewPhase: 'scaling_discussion',
  });

  assert.equal(plan.questionMode, 'system_design');
  assert.equal(plan.deliveryFormat, 'capacity_then_strategy');
  assert.ok(plan.focalFacets.includes('capacity'));
  assert.ok(plan.focalFacets.includes('hotspots'));
  assert.ok(plan.focalFacets.includes('backpressure'));
});

test('System design in failure_handling phase lists modes and recovery', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What happens when the cache layer goes down?',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 1,
    interviewPhase: 'failure_handling',
  });

  assert.equal(plan.questionMode, 'system_design');
  assert.equal(plan.deliveryFormat, 'failure_modes_then_recovery');
  assert.ok(plan.focalFacets.includes('failureModes'));
  assert.ok(plan.focalFacets.includes('blastRadius'));
  assert.ok(plan.focalFacets.includes('recovery'));
});

test('System design respects concise preference but never crushes fresh design below 120 words', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'Design a payment processing service.',
    reaction: null,
    hypothesis: null,
    threadFollowUpCount: 0,
    preferenceSummary: {
      preferConcise: true,
      preferFirstPerson: false,
      preferConversational: false,
      preferIndianEnglish: false,
      preferPlainLanguage: false,
      avoidRoboticTone: false,
      relevantFrameworkHints: [],
      hardPreferenceCount: 1,
    },
  });

  assert.equal(plan.questionMode, 'system_design');
  // Concise preference may shrink the budget but must never drop a fresh
  // design below 120 — that's the floor it needs to actually answer.
  assert.ok(plan.maxWords >= 120, `concise floor violated: ${plan.maxWords}`);
});
