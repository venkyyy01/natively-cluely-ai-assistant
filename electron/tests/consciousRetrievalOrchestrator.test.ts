import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousRetrievalOrchestrator } from '../conscious/ConsciousRetrievalOrchestrator';

test('ConsciousRetrievalOrchestrator builds a structured state block from thread and evidence', () => {
  const orchestrator = new ConsciousRetrievalOrchestrator({
    getFormattedContext: () => '[INTERVIEWER]: What are the tradeoffs?',
    getConsciousEvidenceContext: () => '<conscious_evidence>demo</conscious_evidence>',
    getActiveReasoningThread: () => ({
      rootQuestion: 'How would you partition a multi-tenant analytics system?',
      lastQuestion: 'Why this approach?',
      response: {
        mode: 'reasoning_first',
        openingReasoning: 'I would partition by tenant.',
        implementationPlan: ['Partition by tenant'],
        tradeoffs: ['Cross-tenant reads get more expensive'],
        edgeCases: [],
        scaleConsiderations: ['Promote hot tenants to dedicated partitions'],
        pushbackResponses: ['The model keeps writes isolated.'],
        likelyFollowUps: [],
        codeTransition: '',
      },
      followUpCount: 2,
      updatedAt: Date.now(),
    }),
    getLatestConsciousResponse: () => ({
      mode: 'reasoning_first',
      openingReasoning: 'I would partition by tenant.',
      implementationPlan: ['Partition by tenant'],
      tradeoffs: ['Cross-tenant reads get more expensive'],
      edgeCases: [],
      scaleConsiderations: ['Promote hot tenants to dedicated partitions'],
      pushbackResponses: ['The model keeps writes isolated.'],
      likelyFollowUps: [],
      codeTransition: '',
    }),
    getLatestQuestionReaction: () => ({
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    }),
    getLatestAnswerHypothesis: () => ({
      sourceQuestion: 'What are the tradeoffs?',
      latestSuggestedAnswer: 'I would partition by tenant.',
      likelyThemes: ['Partition by tenant', 'Cross-tenant reads get more expensive'],
      confidence: 0.84,
      evidence: ['suggested', 'inferred'],
      reactionKind: 'tradeoff_probe',
      targetFacets: ['tradeoffs'],
      updatedAt: Date.now(),
    }),
  });

  const pack = orchestrator.buildPack({ question: 'What are the tradeoffs?' });

  assert.ok(pack.stateBlock.includes('<conscious_state>'));
  assert.ok(pack.stateBlock.includes('LATEST_INTERVIEWER_REACTION: tradeoff_probe'));
  assert.ok(pack.stateBlock.includes('LIKELY_USER_ANSWER_SUMMARY: I would partition by tenant.'));
  assert.ok(pack.combinedContext.includes('<conscious_evidence>demo</conscious_evidence>'));
  assert.ok(pack.combinedContext.includes('[INTERVIEWER]: What are the tradeoffs?'));
});
