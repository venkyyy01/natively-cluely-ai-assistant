#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const OUT_PATH = path.join(process.cwd(), 'electron', 'evals', 'intentEvalVariants.generated.json');

const baseCases = [
  {
    id: 'deep-dive-03-cache-freshness',
    expectedIntent: 'deep_dive',
    assistantResponseCount: 0,
    variants: [
      'How would you handle conflict between cache freshness and latency?',
      'How do you trade off cache freshness against response latency?',
      'What tradeoffs would you make between freshness and latency in your cache?',
      'How would you reason about freshness versus latency under heavy traffic?',
      'How would you compare stale reads risk against latency targets?',
      'If cache freshness drops, how do you balance correctness with speed?',
      'How do you tune freshness windows without blowing latency budgets?',
      'What is your approach to freshness-latency tradeoffs for this design?',
      'How do you prioritize freshness vs throughput and latency in this system?',
      'How would you reason about cache invalidation cadence versus API latency?',
    ],
  },
  {
    id: 'clarification-01-eventual-consistency',
    expectedIntent: 'clarification',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: I would prioritize availability and rely on eventual consistency for replicas.',
    variants: [
      'When you say eventual consistency here, what exactly do you mean?',
      'Can you clarify what eventual consistency means in this design?',
      'Could you unpack what you mean by eventual consistency?',
      'What do you mean by eventual consistency in this context?',
      'Can you explain eventual consistency a bit more precisely?',
      'When you said eventual consistency, what behavior should I expect?',
      'Can you clarify how eventual consistency shows up for users?',
      'What exactly is eventually consistent in your write path?',
      'Can you explain what eventual consistency implies for reads?',
      'Can you clarify your eventual consistency statement?',
    ],
  },
  {
    id: 'example-request-02-specific-instance',
    expectedIntent: 'example_request',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: We accepted eventual consistency to keep write latency low.',
    variants: [
      'What is one specific instance where this tradeoff hurt you?',
      'Can you give one concrete instance where that tradeoff backfired?',
      'What is a real example where this tradeoff caused pain?',
      'Can you share one specific example where this decision hurt outcomes?',
      'Give me one concrete case where this tradeoff failed.',
      'What is one scenario where this tradeoff created issues?',
      'Could you provide one real incident where this tradeoff was costly?',
      'Can you point to a specific case where this tradeoff hurt reliability?',
      'What is one practical example where this tradeoff caused trouble?',
      'Share one concrete instance where this tradeoff did not work well.',
    ],
  },
  {
    id: 'summary-probe-01-you-saying',
    expectedIntent: 'summary_probe',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: I keep writes synchronous for correctness and move fan-out async.',
    variants: [
      'So you are saying writes stay synchronous while fan-out is async, right?',
      'So to summarize, writes are sync and fan-out is async?',
      'Let me make sure I got this: synchronous writes, asynchronous fan-out?',
      'If I understood correctly, writes remain synchronous and fan-out runs async?',
      'Correct me if I am wrong: you keep writes sync but fan-out async?',
      'So your design keeps writes synchronous and fan-out asynchronous, yes?',
      'Am I right that writes are sync while fan-out happens async?',
      'Just to confirm, write path is synchronous and fan-out is asynchronous?',
      'Do I have this right: sync writes, async fan-out?',
      'To confirm, you preserve sync writes and push fan-out async?',
    ],
  },
  {
    id: 'follow-up-01-what-next',
    expectedIntent: 'follow_up',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: I paused the rollout and paged the on-call backend team.',
    variants: [
      'What happened next after you paused the deployment?',
      'Then what did you do right after pausing the deploy?',
      'After that, what was your next step?',
      'What did you do next once the rollout was paused?',
      'What happened immediately after you paged on-call?',
      'Then how did you proceed?',
      'What was your next move after the pause?',
      'After pausing rollout, what did you do next?',
      'What happened after that step?',
      'And then what happened?',
    ],
  },
  {
    id: 'coding-03-lru',
    expectedIntent: 'coding',
    assistantResponseCount: 0,
    variants: [
      'Design and code an LRU cache in TypeScript.',
      'Implement an LRU cache with O(1) operations in TypeScript.',
      'Write code for an LRU cache in TypeScript.',
      'Can you implement an LRU cache class in TypeScript?',
      'Build an LRU cache data structure in TypeScript.',
      'Code an LRU cache with get/put in TypeScript.',
      'Implement LRU cache logic in TS with hash map + list.',
      'Write a production-ready TypeScript LRU cache.',
      'Implement least-recently-used cache behavior in TypeScript.',
      'Create a TypeScript LRU cache implementation.',
    ],
  },
  {
    id: 'behavioral-01-conflict',
    expectedIntent: 'behavioral',
    assistantResponseCount: 0,
    variants: [
      'Tell me about a time you disagreed with your manager and how you resolved it.',
      'Describe a situation where you had conflict with your manager and what you did.',
      'Walk me through a disagreement with your manager and your resolution.',
      'Can you share a time you and your manager disagreed and how it ended?',
      'Tell me about a conflict with your manager and how you handled it.',
      'Describe a time you had to navigate disagreement with leadership.',
      'Give me an example of conflict with your manager and your approach.',
      'What is one time you disagreed with your manager and resolved it well?',
      'Share a story where you and your manager had conflicting views.',
      'Tell me about a manager conflict and how you reached alignment.',
    ],
  },
  {
    id: 'general-01-role-interest',
    expectedIntent: 'general',
    assistantResponseCount: 0,
    variants: [
      'What interests you most about this role?',
      'Why are you interested in this position?',
      'What attracts you to this job?',
      'What excites you most about this opportunity?',
      'Why do you want this role in particular?',
      'What part of this role appeals to you?',
      'What makes this position interesting to you?',
      'Why does this role feel like a fit for you?',
      'What are you hoping to get from this role?',
      'What drew you to this position?',
    ],
  },
  {
    id: 'clarification-02-backpressure',
    expectedIntent: 'clarification',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: We add explicit backpressure by slowing producers when queue lag spikes.',
    variants: [
      'Can you unpack what you meant by backpressure in your queue workers?',
      'Can you clarify what backpressure means in your worker setup?',
      'What do you mean by backpressure there?',
      'Could you explain your backpressure mechanism a bit more?',
      'Can you break down that backpressure point?',
      'When you say backpressure, what behavior are you enforcing?',
      'Can you explain how your backpressure approach works?',
      'Could you clarify the backpressure logic in workers?',
      'What exactly is applying pressure in that design?',
      'Can you unpack your queue backpressure statement?',
    ],
  },
  {
    id: 'example-request-01-concrete',
    expectedIntent: 'example_request',
    assistantResponseCount: 1,
    transcriptPrefix: '[ASSISTANT]: I usually start by instrumenting latency and queue lag first.',
    variants: [
      'Can you give me one concrete example of that?',
      'Can you share a specific example?',
      'Give me one real example of that approach.',
      'Could you provide one concrete instance?',
      'What is one practical example of that?',
      'Can you show one specific case?',
      'Share one clear example of that strategy.',
      'What is one concrete case where you did that?',
      'Give one tangible example of this in action.',
      'Can you provide a specific instance?',
    ],
  },
];

function buildCase(base, variant, index) {
  const transcriptLines = [];
  if (base.transcriptPrefix) {
    transcriptLines.push(base.transcriptPrefix);
  }
  transcriptLines.push(`[INTERVIEWER]: ${variant}`);

  return {
    id: `${base.id}-v${String(index + 1).padStart(2, '0')}`,
    description: `${base.id} paraphrase ${index + 1}`,
    expectedIntent: base.expectedIntent,
    lastInterviewerTurn: variant,
    preparedTranscript: transcriptLines.join('\n'),
    assistantResponseCount: base.assistantResponseCount,
    tags: ['generated', 'paraphrase', base.id],
  };
}

const generatedCases = [];
for (const base of baseCases) {
  base.variants.forEach((variant, index) => {
    generatedCases.push(buildCase(base, variant, index));
  });
}

const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  totalCases: generatedCases.length,
  cases: generatedCases,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`Wrote ${generatedCases.length} generated intent eval cases to ${OUT_PATH}`);
