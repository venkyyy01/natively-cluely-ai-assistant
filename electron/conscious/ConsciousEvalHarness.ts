import type { ConsciousModeQuestionRoute, ConsciousModeStructuredResponse } from '../ConsciousMode';
import { QuestionReactionClassifier, type QuestionReaction } from './QuestionReactionClassifier';
import { AnswerHypothesisStore } from './AnswerHypothesisStore';
import { ConsciousVerifier } from './ConsciousVerifier';

export interface ConsciousEvalScenario {
  id: string;
  description: string;
  priorQuestion: string;
  followUpQuestion: string;
  response: ConsciousModeStructuredResponse;
  expected: 'accept' | 'reject';
}

export interface ConsciousEvalScenarioResult {
  scenario: ConsciousEvalScenario;
  reaction: QuestionReaction;
  verdict: { ok: boolean; reason?: string };
  passed: boolean;
}

export interface ConsciousEvalSummary {
  total: number;
  passed: number;
  failed: number;
}

function buildBaselineResponse(): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would partition by tenant to keep writes isolated.',
    implementationPlan: ['Partition by tenant', 'Add read-side aggregation'],
    tradeoffs: ['Cross-tenant reads get more expensive'],
    edgeCases: ['One tenant can become disproportionately hot'],
    scaleConsiderations: ['Promote hot tenants to dedicated partitions'],
    pushbackResponses: ['The design keeps the write path simple while isolating noisy tenants.'],
    likelyFollowUps: [],
    codeTransition: '',
  };
}

export function getDefaultConsciousEvalScenarios(): ConsciousEvalScenario[] {
  return [
    {
      id: 'tradeoff-accept',
      description: 'Tradeoff follow-up should accept a tradeoff-aware answer',
      priorQuestion: 'How would you partition a multi-tenant analytics system?',
      followUpQuestion: 'What are the tradeoffs?',
      response: buildBaselineResponse(),
      expected: 'accept',
    },
    {
      id: 'tradeoff-reject',
      description: 'Tradeoff follow-up should reject a shallow duplicate answer',
      priorQuestion: 'How would you partition a multi-tenant analytics system?',
      followUpQuestion: 'What are the tradeoffs?',
      response: {
        ...buildBaselineResponse(),
        tradeoffs: [],
        pushbackResponses: [],
        implementationPlan: ['Partition by tenant'],
      },
      expected: 'reject',
    },
    {
      id: 'metric-accept',
      description: 'Metric probe should accept an answer with scale/measurement content',
      priorQuestion: 'How would you partition a multi-tenant analytics system?',
      followUpQuestion: 'What metrics would you watch first?',
      response: {
        ...buildBaselineResponse(),
        scaleConsiderations: ['I would watch p95 latency, hot-tenant skew, and queue lag first'],
      },
      expected: 'accept',
    },
    {
      id: 'metric-reject',
      description: 'Metric probe should reject an answer with no measurement detail',
      priorQuestion: 'How would you partition a multi-tenant analytics system?',
      followUpQuestion: 'What metrics would you watch first?',
      response: {
        ...buildBaselineResponse(),
        scaleConsiderations: [],
        tradeoffs: [],
        pushbackResponses: [],
      },
      expected: 'reject',
    },
  ];
}

export async function runConsciousEvalHarness(options: {
  verifier: ConsciousVerifier;
  scenarios?: ConsciousEvalScenario[];
}): Promise<{ results: ConsciousEvalScenarioResult[]; summary: ConsciousEvalSummary }> {
  const classifier = new QuestionReactionClassifier();
  const scenarios = options.scenarios ?? getDefaultConsciousEvalScenarios();
  const results: ConsciousEvalScenarioResult[] = [];

  for (const scenario of scenarios) {
    const store = new AnswerHypothesisStore();
    store.recordStructuredSuggestion(scenario.priorQuestion, buildBaselineResponse(), 'start');

    const reaction = classifier.classify({
      question: scenario.followUpQuestion,
      activeThread: {
        rootQuestion: scenario.priorQuestion,
        lastQuestion: scenario.priorQuestion,
        response: buildBaselineResponse(),
        followUpCount: 0,
        updatedAt: Date.now(),
      },
      latestResponse: buildBaselineResponse(),
      latestHypothesis: store.getLatestHypothesis(),
    });
    store.noteObservedReaction(scenario.followUpQuestion, reaction);

    const route: ConsciousModeQuestionRoute = { qualifies: true, threadAction: 'continue' };
    const verdict = await options.verifier.verify({
      response: scenario.response,
      route,
      reaction,
      hypothesis: store.getLatestHypothesis(),
      question: scenario.followUpQuestion,
    });

    const passed = scenario.expected === 'accept' ? verdict.ok : !verdict.ok;
    results.push({ scenario, reaction, verdict, passed });
  }

  const summary = {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
  };

  return { results, summary };
}
