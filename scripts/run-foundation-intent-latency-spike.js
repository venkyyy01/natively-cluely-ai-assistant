#!/usr/bin/env node

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseRuns(argv) {
  const runsArg = argv.find((arg) => arg.startsWith('--runs='));
  const parsed = runsArg ? Number(runsArg.slice('--runs='.length)) : 15;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15;
}

async function runFoundationIntentLatencySpike(options = {}) {
  const runs = options.runs ?? 15;
  const {
    FoundationModelsIntentProvider,
  } = require('../dist-electron/electron/llm/providers/index.js');

  const provider = new FoundationModelsIntentProvider();
  const available = await provider.isAvailable();
  if (!available) {
    return { available: false, runs };
  }

  const samples = [
    'Tell me about a time you handled conflict with a teammate.',
    'Implement an idempotent webhook handler in TypeScript.',
    'Why would you choose Kafka over RabbitMQ here?',
    'Can you clarify what you meant by eventual consistency?',
    'What happened next after you paused the deployment?',
    'Give me one concrete example of that approach.',
    'So you are saying writes stay synchronous and fan-out is async, right?',
    'What interests you most about this role?',
  ];

  const latencies = [];
  const intents = {};
  const errorsByCode = {};

  for (let index = 0; index < runs; index += 1) {
    const question = samples[index % samples.length];
    const startedAt = process.hrtime.bigint();
    try {
      const result = await provider.classify({
        lastInterviewerTurn: question,
        preparedTranscript: `[INTERVIEWER]: ${question}`,
        assistantResponseCount: 1,
      });
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      latencies.push(latencyMs);
      intents[result.intent] = (intents[result.intent] ?? 0) + 1;
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      latencies.push(latencyMs);
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
      errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
    }
  }

  return {
    available: true,
    runs,
    successCount: runs - Object.values(errorsByCode).reduce((sum, count) => sum + count, 0),
    failureCount: Object.values(errorsByCode).reduce((sum, count) => sum + count, 0),
    errorsByCode,
    intents,
    latencyMs: {
      first: Number((latencies[0] ?? 0).toFixed(2)),
      min: Number((Math.min(...latencies)).toFixed(2)),
      mean: Number(mean(latencies).toFixed(2)),
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      max: Number((Math.max(...latencies)).toFixed(2)),
    },
  };
}

async function main() {
  const report = await runFoundationIntentLatencySpike({ runs: parseRuns(process.argv.slice(2)) });
  console.log(JSON.stringify(report, null, 2));
  if (!report.available) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Foundation intent latency spike failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  runFoundationIntentLatencySpike,
};
