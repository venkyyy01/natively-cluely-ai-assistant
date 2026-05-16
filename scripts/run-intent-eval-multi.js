#!/usr/bin/env node

const {
  DEFAULT_INTENT_EVAL_CASES,
  runIntentEval,
} = require('../dist-electron/electron/evals/intentClassificationEval.js');
const fs = require('node:fs');

const {
  FoundationModelsIntentProvider,
  IntentClassificationCoordinator,
  LegacyIntentProvider,
} = require('../dist-electron/electron/llm/providers/index.js');

function parseArgs(argv) {
  let provider = 'coordinated';
  let runs = 10;
  let datasetPath = null;

  for (const arg of argv) {
    if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length);
    }
    if (arg.startsWith('--runs=')) {
      const parsed = Number(arg.slice('--runs='.length));
      if (Number.isFinite(parsed) && parsed >= 1) {
        runs = Math.floor(parsed);
      }
    }
    if (arg.startsWith('--dataset=')) {
      const value = arg.slice('--dataset='.length).trim();
      datasetPath = value ? value : null;
    }
  }

  if (!['coordinated', 'foundation', 'legacy'].includes(provider)) {
    throw new Error(`Unsupported provider mode: ${provider}`);
  }

  return { provider, runs, datasetPath };
}

function loadCases(datasetPath) {
  if (!datasetPath) {
    return DEFAULT_INTENT_EVAL_CASES;
  }

  const raw = fs.readFileSync(datasetPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && Array.isArray(parsed.cases)) {
    return parsed.cases;
  }

  throw new Error(`Dataset at ${datasetPath} does not contain an array of cases`);
}

function buildClassifier(mode) {
  if (mode === 'foundation') {
    const provider = new FoundationModelsIntentProvider();
    return async (input) => {
      const result = await provider.classify(input);
      return {
        intent: result.intent,
        confidence: result.confidence,
        providerUsed: provider.name,
      };
    };
  }

  if (mode === 'legacy') {
    const provider = new LegacyIntentProvider();
    return async (input) => {
      const result = await provider.classify(input);
      return {
        intent: result.intent,
        confidence: result.confidence,
        providerUsed: provider.name,
      };
    };
  }

  const coordinator = new IntentClassificationCoordinator(
    new FoundationModelsIntentProvider(),
    new LegacyIntentProvider(),
  );

  return async (input) => {
    const result = await coordinator.classify(input);
    return {
      intent: result.intent,
      confidence: result.confidence,
      providerUsed: result.provider,
      fallbackReason: result.fallbackReason,
    };
  };
}

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (values.length <= 1) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * (sorted.length - 1))));
  return sorted[idx];
}

async function main() {
  const { provider, runs, datasetPath } = parseArgs(process.argv.slice(2));
  const cases = loadCases(datasetPath);
  const classify = buildClassifier(provider);

  const accuracySeries = [];
  const fallbackSeries = [];
  const runSummaries = [];

  const perCaseMisses = new Map();
  const perCaseExpected = new Map();

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const startedAt = Date.now();
    const { outcomes, summary } = await runIntentEval(cases, classify);
    const durationMs = Date.now() - startedAt;

    accuracySeries.push(summary.accuracy);
    fallbackSeries.push(summary.fallbackRate.rate);
    runSummaries.push({
      run: runIndex + 1,
      accuracy: summary.accuracy,
      fallbackRate: summary.fallbackRate.rate,
      durationMs,
    });

    for (const outcome of outcomes) {
      perCaseExpected.set(outcome.caseId, outcome.expectedIntent);
      if (outcome.predictedIntent !== outcome.expectedIntent) {
        perCaseMisses.set(outcome.caseId, (perCaseMisses.get(outcome.caseId) ?? 0) + 1);
      }
    }
  }

  const hardestCases = Array.from(perCaseMisses.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([caseId, misses]) => ({
      caseId,
      misses,
      missRate: misses / runs,
      expectedIntent: perCaseExpected.get(caseId) ?? 'unknown',
    }));

  const report = {
    provider,
    runs,
    casesPerRun: cases.length,
    datasetPath: datasetPath || 'default',
    accuracy: {
      mean: mean(accuracySeries),
      stddev: stddev(accuracySeries),
      min: Math.min(...accuracySeries),
      max: Math.max(...accuracySeries),
      p50: percentile(accuracySeries, 0.5),
      p95: percentile(accuracySeries, 0.95),
    },
    fallbackRate: {
      mean: mean(fallbackSeries),
      stddev: stddev(fallbackSeries),
      min: Math.min(...fallbackSeries),
      max: Math.max(...fallbackSeries),
      p50: percentile(fallbackSeries, 0.5),
      p95: percentile(fallbackSeries, 0.95),
    },
    runSummaries,
    hardestCases,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('Intent multi-eval failed:', error);
  process.exitCode = 1;
});
