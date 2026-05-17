import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');
const MODEL_DIR = resolve(PROJECT_ROOT, 'resources/models/Xenova/nli-deberta-v3-small');
const LABEL_MAP = { 0: 'clarification', 1: 'follow_up', 2: 'deep_dive', 3: 'behavioral', 4: 'example_request', 5: 'summary_probe', 6: 'coding', 7: 'general' };

const EVAL_CASES = [
  { id: 'behavioral-01', expected: 'behavioral', text: 'Tell me about a time you disagreed with your manager and how you resolved it.' },
  { id: 'behavioral-02', expected: 'behavioral', text: 'Describe a situation where you had to influence people without formal authority.' },
  { id: 'behavioral-03', expected: 'behavioral', text: 'Walk me through a failure you owned end to end and what you learned.' },
  { id: 'coding-01', expected: 'coding', text: 'Implement debouncing in JavaScript.' },
  { id: 'coding-02', expected: 'coding', text: 'Debug this function: it should deduplicate IDs but still returns duplicates.' },
  { id: 'coding-03', expected: 'coding', text: 'Design and code an LRU cache in TypeScript.' },
  { id: 'deep-dive-01', expected: 'deep_dive', text: 'Why would you choose Kafka over RabbitMQ for this architecture?' },
  { id: 'deep-dive-02', expected: 'deep_dive', text: 'Explain the tradeoffs you made between consistency and availability.' },
  { id: 'deep-dive-03', expected: 'deep_dive', text: 'How would you handle conflict between cache freshness and latency?' },
  { id: 'clarification-01', expected: 'clarification', text: 'When you say eventual consistency here, what exactly do you mean?' },
  { id: 'clarification-02', expected: 'clarification', text: 'Can you unpack what you meant by backpressure in your queue workers?' },
  { id: 'clarification-03', expected: 'clarification', text: 'Sorry, can you clarify the scope boundary you drew between services?' },
  { id: 'follow-up-01', expected: 'follow_up', text: 'What happened next after you paused the deployment?' },
  { id: 'follow-up-02', expected: 'follow_up', text: 'And then what did you do once the queue recovered?' },
  { id: 'follow-up-03', expected: 'follow_up', text: 'After that, how did you roll out the fix safely?' },
  { id: 'example-01', expected: 'example_request', text: 'Can you give me one concrete example of that?' },
  { id: 'example-02', expected: 'example_request', text: 'What is one specific instance where this tradeoff hurt you?' },
  { id: 'example-03-coding', expected: 'coding', text: 'Can you show an example API payload and handler code for this endpoint?' },
  { id: 'summary-01', expected: 'summary_probe', text: 'So you are saying writes stay synchronous while fan-out is async, right?' },
  { id: 'summary-02', expected: 'summary_probe', text: 'Let me make sure I got this: you sharded by tenant before region?' },
  { id: 'summary-03', expected: 'summary_probe', text: 'So to summarize, your first step is hot partition isolation?' },
  { id: 'general-01', expected: 'general', text: 'What interests you most about this role?' },
  { id: 'general-02', expected: 'general', text: 'What kind of team environment helps you do your best work?' },
  { id: 'general-03', expected: 'general', text: 'Do you have any questions for us about the position?' },
  { id: 'ambiguous-01', expected: 'example_request', text: 'Can you give a concrete example of retry jitter in practice?' },
  { id: 'ambiguous-02', expected: 'clarification', text: 'Can you clarify that part about replay protection?' },
  { id: 'ambiguous-03', expected: 'follow_up', text: 'And what did you do after that?' },
];

async function main() {
  const ort = await import('onnxruntime-node');
  const { pipeline } = await import('@xenova/transformers');

  const env = (await import('@xenova/transformers')).env;
  env.allowRemoteModels = false;
  env.localModelPath = resolve(__dirname, '../resources/models/');

  console.log('Loading fine-tuned model...');
  const classifier = await pipeline('text-classification', 'Xenova/nli-deberta-v3-small', { quantized: true });
  console.log('Model loaded.\n');

  let correct = 0;
  const results = [];

  for (const testCase of EVAL_CASES) {
    const output = await classifier(testCase.text, { top_k: 8 });
    const allScores = Array.isArray(output) ? output : [output];
    allScores.sort((a, b) => b.score - a.score);
    const top = allScores[0];
    const predicted = top.label;
    const isCorrect = predicted === testCase.expected;
    if (isCorrect) correct++;

    results.push({
      id: testCase.id,
      expected: testCase.expected,
      predicted,
      confidence: top.score,
      correct: isCorrect,
    });
  }

  console.log('=== EVAL RESULTS ===');
  console.log(`Overall: ${correct}/${EVAL_CASES.length} (${(correct / EVAL_CASES.length * 100).toFixed(1)}%)\n`);

  const perIntent = {};
  for (const r of results) {
    if (!perIntent[r.expected]) perIntent[r.expected] = { total: 0, correct: 0 };
    perIntent[r.expected].total++;
    if (r.correct) perIntent[r.expected].correct++;
  }

  console.log('Per-intent accuracy:');
  for (const [intent, stats] of Object.entries(perIntent)) {
    console.log(`  ${intent}: ${stats.correct}/${stats.total} (${(stats.correct / stats.total * 100).toFixed(0)}%)`);
  }

  console.log('\nMispredictions:');
  for (const r of results) {
    if (!r.correct) {
      console.log(`  ${r.id}: expected=${r.expected} predicted=${r.predicted} conf=${(r.confidence * 100).toFixed(1)}%`);
    }
  }
}

main().catch(console.error);
