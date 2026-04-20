import {
  classifyConsciousModeQuestion,
  type ConsciousModeQuestionRoute,
  type ConsciousModeStructuredResponse,
  type ReasoningThread,
} from '../ConsciousMode';
import { QuestionReactionClassifier, type QuestionReaction } from './QuestionReactionClassifier';
import { AnswerHypothesisStore } from './AnswerHypothesisStore';
import { ConsciousProvenanceVerifier } from './ConsciousProvenanceVerifier';
import { ConsciousVerifier } from './ConsciousVerifier';

export interface ConsciousEvalFamilySummary {
  total: number;
  passed: number;
  failed: number;
}

export interface ConsciousEvalScenario {
  id: string;
  family: string;
  description: string;
  priorQuestion: string;
  followUpQuestion: string;
  response: ConsciousModeStructuredResponse;
  expected: 'accept' | 'reject';
  expectedProvenance?: 'accept' | 'reject';
  semanticContextBlock?: string;
  evidenceContextBlock?: string;
}

export interface ConsciousEvalScenarioResult {
  scenario: ConsciousEvalScenario;
  reaction: QuestionReaction;
  verdict: { ok: boolean; reason?: string };
  provenanceVerdict: { ok: boolean; reason?: string };
  passed: boolean;
}

export interface ConsciousEvalSummary {
  total: number;
  passed: number;
  failed: number;
  byFamily: Record<string, ConsciousEvalFamilySummary>;
}

export interface ConsciousReplayContextItem {
  id: string;
  role: 'interviewer' | 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface ConsciousReplayScenario {
  id: string;
  family: string;
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

function buildBehavioralResponse(overrides: Partial<ConsciousModeStructuredResponse['behavioralAnswer']> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: '',
    implementationPlan: [],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
    behavioralAnswer: {
      question: 'Tell me about a time you handled disagreement on a team.',
      headline: 'I aligned a skeptical partner team around a safer rollout plan.',
      situation: 'We were about to launch a billing change and the partner team wanted to compress testing to hit the date.',
      task: 'I needed to protect the launch quality without turning the discussion into a turf fight.',
      action: 'I pulled the recent incident data, showed exactly where regressions were most likely, proposed a two-phase rollout with ownership checkpoints, and walked both managers through the rollback plan until we agreed on the sequence.',
      result: 'We shipped one week later, avoided a repeat incident, and cut rollout rollback volume by 38 percent on the next release.',
      whyThisAnswerWorks: [
        'It shows I handled conflict directly.',
        'It proves I used data instead of opinion.',
        'It ends with a measurable result.',
      ],
      ...overrides,
    },
  };
}

export function getDefaultConsciousEvalScenarios(): ConsciousEvalScenario[] {
  return [
    {
      id: 'tradeoff-accept',
      family: 'system_design',
      description: 'Tradeoff follow-up should accept a tradeoff-aware answer',
      priorQuestion: 'How would you partition a multi-tenant analytics system?',
      followUpQuestion: 'What are the tradeoffs?',
      response: buildBaselineResponse(),
      expected: 'accept',
    },
    {
      id: 'tradeoff-reject',
      family: 'system_design',
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
      family: 'system_design',
      description: 'Metric probe should accept an answer with scale and measurement content',
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
      family: 'system_design',
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
    {
      id: 'behavioral-accept',
      family: 'behavioral',
      description: 'Behavioral follow-up should accept a grounded STAR story with strong action depth',
      priorQuestion: 'Tell me about a time you handled disagreement on a team.',
      followUpQuestion: 'Tell me about a time you handled disagreement on a team.',
      response: buildBehavioralResponse(),
      expected: 'accept',
      // NAT-004 / audit A-4: the STAR result quotes "38 percent". The provenance
      // verifier now fails closed on metric claims with no grounding context, so
      // we ground the candidate's own behavioral memory here. In production this
      // is the role the semantic memory plays for behavioral answers.
      semanticContextBlock:
        '<conscious_semantic_memory>Past projects: ran a two-phase billing rollout with the partner team and cut rollout rollback volume by 38 percent on the next release.</conscious_semantic_memory>',
    },
    {
      id: 'behavioral-reject',
      family: 'behavioral',
      description: 'Behavioral follow-up should reject weak STAR answers with shallow action detail',
      priorQuestion: 'Tell me about a time you handled disagreement on a team.',
      followUpQuestion: 'Tell me about a time you handled disagreement on a team.',
      response: buildBehavioralResponse({
        action: 'I talked to the team and we aligned.',
        result: 'It worked out well.',
        whyThisAnswerWorks: ['It is short', 'It sounds clear', 'It resolves the issue'],
      }),
      expected: 'reject',
    },
    {
      id: 'provenance-technology-reject',
      family: 'provenance',
      description: 'Unsupported technology claims should fail provenance even when the verifier passes',
      priorQuestion: 'How would you evolve the ingestion path?',
      followUpQuestion: 'Go deeper on the storage layer.',
      response: {
        ...buildBaselineResponse(),
        openingReasoning: 'I would move the write path to Cassandra to absorb the tenant spikes.',
        implementationPlan: ['Use Cassandra for the write path', 'Keep Kafka for async fan-out'],
      },
      expected: 'accept',
      expectedProvenance: 'reject',
      semanticContextBlock: '<conscious_semantic_memory>Technologies: Redis, Kafka</conscious_semantic_memory>',
    },
    {
      id: 'provenance-metric-reject',
      family: 'provenance',
      description: 'Unsupported metric claims should fail provenance even when the verifier passes',
      priorQuestion: 'How would you evolve the ingestion path?',
      followUpQuestion: 'Go deeper on the rollout checks.',
      response: {
        ...buildBaselineResponse(),
        scaleConsiderations: ['I would target 10ms p99 latency immediately before broad rollout'],
      },
      expected: 'accept',
      expectedProvenance: 'reject',
      semanticContextBlock: '<conscious_semantic_memory>Current production baseline is 70ms p99 latency.</conscious_semantic_memory>',
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
      family: 'system_design_continuation',
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
    {
      id: 'topic-shift-reset',
      family: 'topic_shift',
      description: 'Explicit topic shifts should reset the active thread while keeping the verifier trace visible.',
      question: 'Let us switch gears and talk about the launch plan.',
      activeThread,
      contextItems: [
        {
          id: 'ctx_3',
          role: 'assistant',
          text: 'Partition by tenant and promote hot tenants to dedicated partitions.',
          timestamp: Date.now() - 300,
        },
        {
          id: 'ctx_4',
          role: 'interviewer',
          text: 'Let us switch gears and talk about the launch plan.',
          timestamp: Date.now() - 200,
        },
      ],
      response,
      expected: {
        route: { qualifies: true, threadAction: 'reset' },
        verifierOk: true,
      },
    },
    {
      id: 'live-coding-continuation',
      family: 'live_coding_continuation',
      description: 'Deterministic continuation phrases should keep a technical thread alive for implementation follow-ups.',
      question: 'What happens during failover?',
      activeThread: {
        rootQuestion: 'Implement an idempotent webhook handler.',
        lastQuestion: 'Implement an idempotent webhook handler.',
        response: {
          ...response,
          openingReasoning: 'I would start with a durable dedupe key and replay protection.',
          implementationPlan: ['Generate a stable idempotency key', 'Persist processed deliveries'],
          edgeCases: ['Retries can arrive out of order', 'The provider can replay stale events'],
        },
        followUpCount: 1,
        updatedAt: Date.now() - 800,
      },
      contextItems: [
        {
          id: 'ctx_5',
          role: 'assistant',
          text: 'Start with an idempotency key and persist processed deliveries.',
          timestamp: Date.now() - 250,
        },
        {
          id: 'ctx_6',
          role: 'interviewer',
          text: 'What happens during failover?',
          timestamp: Date.now() - 150,
        },
      ],
      response: {
        ...response,
        edgeCases: ['Retries can arrive out of order', 'The provider can replay stale events'],
      },
      expected: {
        route: { qualifies: true, threadAction: 'continue' },
        verifierOk: true,
      },
    },
  ];
}

function summarizeResults<T extends { passed: boolean; scenario: { family: string } }>(results: T[]): ConsciousEvalSummary {
  const byFamily: Record<string, ConsciousEvalFamilySummary> = {};

  for (const result of results) {
    const family = result.scenario.family;
    byFamily[family] = byFamily[family] ?? { total: 0, passed: 0, failed: 0 };
    byFamily[family].total += 1;
    if (result.passed) {
      byFamily[family].passed += 1;
    } else {
      byFamily[family].failed += 1;
    }
  }

  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    byFamily,
  };
}

export async function runConsciousEvalHarness(options: {
  verifier: ConsciousVerifier;
  scenarios?: ConsciousEvalScenario[];
}): Promise<{ results: ConsciousEvalScenarioResult[]; summary: ConsciousEvalSummary }> {
  const classifier = new QuestionReactionClassifier();
  const provenanceVerifier = new ConsciousProvenanceVerifier();
  const scenarios = options.scenarios ?? getDefaultConsciousEvalScenarios();
  const results: ConsciousEvalScenarioResult[] = [];

  for (const scenario of scenarios) {
    const store = new AnswerHypothesisStore();
    store.recordStructuredSuggestion(scenario.priorQuestion, scenario.response, 'start');

    const reaction = classifier.classify({
      question: scenario.followUpQuestion,
      activeThread: {
        rootQuestion: scenario.priorQuestion,
        lastQuestion: scenario.priorQuestion,
        response: scenario.response,
        followUpCount: 0,
        updatedAt: Date.now(),
      },
      latestResponse: scenario.response,
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
    const provenanceVerdict = provenanceVerifier.verify({
      response: scenario.response,
      semanticContextBlock: scenario.semanticContextBlock,
      evidenceContextBlock: scenario.evidenceContextBlock,
      question: scenario.followUpQuestion,
      hypothesis: store.getLatestHypothesis(),
    });

    const expectedProvenance = scenario.expectedProvenance ?? 'accept';
    const verifierPassed = scenario.expected === 'accept' ? verdict.ok : !verdict.ok;
    const provenancePassed = expectedProvenance === 'accept' ? provenanceVerdict.ok : !provenanceVerdict.ok;
    results.push({
      scenario,
      reaction,
      verdict,
      provenanceVerdict,
      passed: verifierPassed && provenancePassed,
    });
  }

  return {
    results,
    summary: summarizeResults(results),
  };
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

  return {
    results,
    summary: summarizeResults(results),
  };
}
