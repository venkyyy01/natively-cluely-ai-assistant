#!/usr/bin/env node

const {
  DEFAULT_INTENT_EVAL_CASES,
  formatIntentEvalSummary,
  runIntentEval,
} = require('../dist-electron/electron/evals/intentClassificationEval.js');

const {
  FoundationModelsIntentProvider,
  IntentClassificationCoordinator,
  LegacyIntentProvider,
} = require('../dist-electron/electron/llm/providers/index.js');

function parseProviderMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--provider='));
  if (!modeArg) {
    return 'coordinated';
  }

  const mode = modeArg.split('=')[1] || 'coordinated';
  if (mode === 'foundation' || mode === 'legacy' || mode === 'coordinated') {
    return mode;
  }

  throw new Error(`Unsupported --provider mode: ${mode}`);
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

  const optimizationEnabled = process.env.INTENT_EVAL_DISABLE_FOUNDATION === '1'
    ? () => false
    : undefined;

  const coordinator = new IntentClassificationCoordinator(
    new FoundationModelsIntentProvider({
      isOptimizationEnabled: optimizationEnabled,
    }),
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

async function main() {
  const mode = parseProviderMode(process.argv.slice(2));
  const classify = buildClassifier(mode);
  const { outcomes, summary } = await runIntentEval(DEFAULT_INTENT_EVAL_CASES, classify);

  console.log('\nIntent Classification Eval');
  console.log('==========================');
  console.log(`Provider mode: ${mode}`);
  console.log(`Cases: ${outcomes.length}`);
  console.log('');
  console.log(formatIntentEvalSummary(summary));

  if (summary.total === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Intent eval failed:', error);
  process.exitCode = 1;
});
