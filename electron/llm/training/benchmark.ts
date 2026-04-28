// electron/llm/training/benchmark.ts
// Benchmark runner for intent classification models.
// Evaluates accuracy, latency, and per-class metrics BEFORE and AFTER training.
//
// Usage:
//   npx tsx electron/llm/training/benchmark.ts --model=current --output=pre-training-metrics.json
//   npx tsx electron/llm/training/benchmark.ts --model=setfit --output=post-training-metrics.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllExamples, splitTrainTest } from './intentDataset';
import { LayeredIntentRouter } from '../LayeredIntentRouter';
import { SetFitIntentProvider } from '../providers/SetFitIntentProvider';
import { classifyIntent } from '../IntentClassifier';
import { SemanticEmbeddingRouter } from '../SemanticEmbeddingRouter';

interface BenchmarkResult {
  timestamp: string;
  model: string;
  totalExamples: number;
  accuracy: number;
  macroF1: number;
  weightedF1: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  perClassMetrics: Record<string, {
    precision: number;
    recall: number;
    f1: number;
    support: number;
  }>;
  confusionMatrix: Record<string, Record<string, number>>;
}

interface Prediction {
  expected: string;
  predicted: string;
  latencyMs: number;
  text: string;
}

async function benchmarkModel(
  modelName: string,
  testExamples: Array<{ text: string; label: string }>,
  predictFn: (text: string) => Promise<{ intent: string; latencyMs: number }>,
): Promise<BenchmarkResult> {
  const predictions: Prediction[] = [];
  const latencies: number[] = [];

  console.log(`[Benchmark] Evaluating ${modelName} on ${testExamples.length} examples...`);

  for (const example of testExamples) {
    const start = Date.now();
    try {
      const result = await predictFn(example.text);
      const latency = Date.now() - start;
      predictions.push({
        expected: example.label,
        predicted: result.intent,
        latencyMs: latency,
        text: example.text,
      });
      latencies.push(latency);
    } catch (error) {
      predictions.push({
        expected: example.label,
        predicted: 'general', // fallback
        latencyMs: Date.now() - start,
        text: example.text,
      });
      latencies.push(Date.now() - start);
    }
  }

  // Calculate accuracy
  const correct = predictions.filter((p) => p.expected === p.predicted).length;
  const accuracy = correct / predictions.length;

  // Calculate per-class metrics
  const labels = [...new Set(testExamples.map((e) => e.label))];
  const perClassMetrics: Record<string, { precision: number; recall: number; f1: number; support: number }> = {};
  const confusionMatrix: Record<string, Record<string, number>> = {};

  for (const label of labels) {
    confusionMatrix[label] = {};
    for (const otherLabel of labels) {
      confusionMatrix[label][otherLabel] = predictions.filter(
        (p) => p.expected === label && p.predicted === otherLabel
      ).length;
    }

    const truePositives = predictions.filter((p) => p.expected === label && p.predicted === label).length;
    const falsePositives = predictions.filter((p) => p.expected !== label && p.predicted === label).length;
    const falseNegatives = predictions.filter((p) => p.expected === label && p.predicted !== label).length;
    const support = predictions.filter((p) => p.expected === label).length;

    const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
    const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClassMetrics[label] = { precision, recall, f1, support };
  }

  // Calculate macro and weighted F1
  const macroF1 = Object.values(perClassMetrics).reduce((sum, m) => sum + m.f1, 0) / labels.length;
  const weightedF1 = Object.values(perClassMetrics).reduce(
    (sum, m) => sum + m.f1 * m.support,
    0
  ) / predictions.length;

  // Calculate latency percentiles
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95Index = Math.floor(sortedLatencies.length * 0.95);
  const p99Index = Math.floor(sortedLatencies.length * 0.99);

  return {
    timestamp: new Date().toISOString(),
    model: modelName,
    totalExamples: testExamples.length,
    accuracy,
    macroF1,
    weightedF1,
    averageLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p95LatencyMs: sortedLatencies[p95Index] || 0,
    p99LatencyMs: sortedLatencies[p99Index] || 0,
    perClassMetrics,
    confusionMatrix,
  };
}

async function benchmarkCurrentSLM(testExamples: Array<{ text: string; label: string }>): Promise<BenchmarkResult> {
  return benchmarkModel('slm-xenova', testExamples, async (text) => {
    const result = await classifyIntent(text, '', 0);
    return { intent: result.intent, latencyMs: result.latencyMs || 0 };
  });
}

async function benchmarkCurrentSetFit(testExamples: Array<{ text: string; label: string }>): Promise<BenchmarkResult> {
  const provider = new SetFitIntentProvider();
  await provider.isAvailable(); // warmup

  return benchmarkModel('setfit-untrained', testExamples, async (text) => {
    const result = await provider.classify({
      lastInterviewerTurn: text,
      preparedTranscript: '',
      assistantResponseCount: 0,
    });
    return { intent: result.intent, latencyMs: result.latencyMs || 0 };
  });
}

async function benchmarkSemanticRouter(testExamples: Array<{ text: string; label: string }>): Promise<BenchmarkResult> {
  const router = SemanticEmbeddingRouter.getInstance();

  return benchmarkModel('semantic-router', testExamples, async (text) => {
    const start = Date.now();
    const result = await router.classify(text);
    return {
      intent: result?.intent || 'general',
      latencyMs: Date.now() - start,
    };
  });
}

async function benchmarkLayeredRouter(testExamples: Array<{ text: string; label: string }>): Promise<BenchmarkResult> {
  const router = LayeredIntentRouter.getInstance();

  return benchmarkModel('layered-router-fast', testExamples, async (text) => {
    const start = Date.now();
    const decision = await router.routeFast({
      question: text,
      transcript: '',
      assistantResponseCount: 0,
      prefetchedIntent: null,
    });
    return {
      intent: decision.intentResult.intent,
      latencyMs: Date.now() - start,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const modelArg = args.find((a) => a.startsWith('--model='))?.split('=')[1] || 'all';
  const outputArg = args.find((a) => a.startsWith('--output='))?.split('=')[1];

  console.log('[Benchmark] Loading dataset...');
  const allExamples = getAllExamples();
  const { test } = splitTrainTest(allExamples, 0.2);

  console.log(`[Benchmark] Test set: ${test.length} examples`);

  const results: BenchmarkResult[] = [];

  if (modelArg === 'all' || modelArg === 'slm') {
    console.log('\n[Benchmark] Running SLM (Xenova) benchmark...');
    results.push(await benchmarkCurrentSLM(test));
  }

  if (modelArg === 'all' || modelArg === 'setfit') {
    console.log('\n[Benchmark] Running SetFit (untrained) benchmark...');
    results.push(await benchmarkCurrentSetFit(test));
  }

  if (modelArg === 'all' || modelArg === 'semantic') {
    console.log('\n[Benchmark] Running Semantic Router benchmark...');
    results.push(await benchmarkSemanticRouter(test));
  }

  if (modelArg === 'all' || modelArg === 'layered') {
    console.log('\n[Benchmark] Running Layered Router benchmark...');
    results.push(await benchmarkLayeredRouter(test));
  }

  // Print results
  for (const result of results) {
    console.log(`\n=== ${result.model} ===`);
    console.log(`Accuracy: ${(result.accuracy * 100).toFixed(2)}%`);
    console.log(`Macro F1: ${(result.macroF1 * 100).toFixed(2)}%`);
    console.log(`Weighted F1: ${(result.weightedF1 * 100).toFixed(2)}%`);
    console.log(`Avg Latency: ${result.averageLatencyMs.toFixed(2)}ms`);
    console.log(`P95 Latency: ${result.p95LatencyMs.toFixed(2)}ms`);
    console.log('Per-class metrics:');
    for (const [label, metrics] of Object.entries(result.perClassMetrics)) {
      console.log(`  ${label}: P=${(metrics.precision * 100).toFixed(1)}% R=${(metrics.recall * 100).toFixed(1)}% F1=${(metrics.f1 * 100).toFixed(1)}% (n=${metrics.support})`);
    }
  }

  // Save to file
  if (outputArg) {
    const outputPath = path.resolve(outputArg);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n[Benchmark] Results saved to ${outputPath}`);
  }

  return results;
}

if (require.main === module) {
  main().catch(console.error);
}

export { benchmarkModel, benchmarkCurrentSLM, benchmarkCurrentSetFit };
