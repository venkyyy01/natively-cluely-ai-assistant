import {
  classifyConsciousModeQuestion,
  type ConsciousModeQuestionRoute,
  type ConsciousModeStructuredResponse,
  type ReasoningThread,
} from '../ConsciousMode';
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

export interface ConsciousReplayContextItem {
  id: string;
  role: 'interviewer' | 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface ConsciousReplayScenario {
  id: string;
  description: string;
  question: string;
  activeThread: ReasoningThread | null;
  contextItems: ConsciousReplayContextItem[];
  response: ConsciousModeStructuredResponse;
  expected: {
    route: ConsciousModeQuestionRoute;
    verifierOk: boolean;
    fallbackReason?: 'route_not_qualified' | 'conscious_verification_failed';
  };
}

export interface ConsciousReplayTrace {
  question: string;
  route: ConsciousModeQuestionRoute;
  selectedContextItemIds: string[];
  verifierVerdict: { ok: boolean; reason?: string };
  fallbackReason?: 'route_not_qualified' | 'conscious_verification_failed';
}

export interface ConsciousReplayScenarioResult {
  scenario: ConsciousReplayScenario;
  trace: ConsciousReplayTrace;
  passed: boolean;
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

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  ));
}

function selectReplayContext(question: string, contextItems: ConsciousReplayContextItem[]): ConsciousReplayContextItem[] {
  const queryTokens = tokenize(question);
  return contextItems
    .map((item) => {
      const text = item.text.toLowerCase();
      const overlap = queryTokens.filter((token) => text.includes(token)).length;
      return { item, overlap };
    })
    .filter((candidate) => candidate.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.item.timestamp - left.item.timestamp)
    .slice(0, 6)
    .map((candidate) => candidate.item);
}

export function getDefaultConsciousReplayScenarios(): ConsciousReplayScenario[] {
  const response = buildBaselineResponse();
  const activeThread: ReasoningThread = {
    rootQuestion: 'How would you partition a multi-tenant analytics system?',
    lastQuestion: 'How would you partition a multi-tenant analytics system?',
    response,
    followUpCount: 0,
    updatedAt: Date.now() - 1000,
  };

  return [
    {
      id: 'question-to-verifier-trace',
      description: 'Reconstructs route, selected context, verifier verdict, and fallback reason for a follow-up.',
      question: 'What are the tradeoffs for hot tenants?',
      activeThread,
      contextItems: [
        {
          id: 'ctx_1',
          role: 'interviewer',
          text: 'What are the tradeoffs for hot tenants?',
          timestamp: Date.now() - 500,
        },
        {
          id: 'ctx_2',
          role: 'assistant',
          text: 'Partition by tenant and promote hot tenants to dedicated partitions.',
          timestamp: Date.now() - 400,
        },
      ],
      response,
      expected: {
        route: { qualifies: true, threadAction: 'continue' },
        verifierOk: true,
      },
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

export async function runConsciousReplayHarness(options: {
  verifier: ConsciousVerifier;
  scenarios?: ConsciousReplayScenario[];
}): Promise<{ results: ConsciousReplayScenarioResult[]; summary: ConsciousEvalSummary }> {
  const scenarios = options.scenarios ?? getDefaultConsciousReplayScenarios();
  const classifier = new QuestionReactionClassifier();
  const results: ConsciousReplayScenarioResult[] = [];

  for (const scenario of scenarios) {
    const route = classifyConsciousModeQuestion(scenario.question, scenario.activeThread);
    const selectedContext = selectReplayContext(scenario.question, scenario.contextItems);
    let verifierVerdict: { ok: boolean; reason?: string } = { ok: false, reason: 'route_not_qualified' };
    let fallbackReason: ConsciousReplayTrace['fallbackReason'] = 'route_not_qualified';

    if (route.qualifies) {
      const store = new AnswerHypothesisStore();
      if (scenario.activeThread) {
        store.recordStructuredSuggestion(scenario.activeThread.rootQuestion, scenario.activeThread.response, 'start');
      }
      const reaction = classifier.classify({
        question: scenario.question,
        activeThread: scenario.activeThread,
        latestResponse: scenario.activeThread?.response ?? null,
        latestHypothesis: store.getLatestHypothesis(),
      });
      store.noteObservedReaction(scenario.question, reaction);
      verifierVerdict = await options.verifier.verify({
        response: scenario.response,
        route,
        reaction,
        hypothesis: store.getLatestHypothesis(),
        question: scenario.question,
      });
      fallbackReason = verifierVerdict.ok ? undefined : 'conscious_verification_failed';
    }

    const trace: ConsciousReplayTrace = {
      question: scenario.question,
      route,
      selectedContextItemIds: selectedContext.map((item) => item.id),
      verifierVerdict,
      fallbackReason,
    };

    const passed = route.qualifies === scenario.expected.route.qualifies
      && route.threadAction === scenario.expected.route.threadAction
      && verifierVerdict.ok === scenario.expected.verifierOk
      && fallbackReason === scenario.expected.fallbackReason;

    results.push({ scenario, trace, passed });
  }

  const summary = {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
  };

  return { results, summary };
}
