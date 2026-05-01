const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readBenchmarkEvents(benchmarkFile) {
  return readFileSync(benchmarkFile, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function summarizeBenchmarkEvents(benchmarkEvents) {
  const latestMetrics = new Map();
  for (const event of benchmarkEvents) {
    latestMetrics.set(event.metric, event);
  }

  return Object.fromEntries(
    Array.from(latestMetrics.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, event]) => [metric, typeof event.durationMs === 'number' ? event.durationMs : null]),
  );
}

function printComparisonTable(currentMetrics, baseline) {
  const metricRows = Object.keys(currentMetrics)
    .sort((left, right) => left.localeCompare(right))
    .map((metric) => ({
      metric,
      current: currentMetrics[metric] === null ? 'n/a' : `${currentMetrics[metric]} ms`,
      baseline: Object.prototype.hasOwnProperty.call(baseline, metric)
        ? `${baseline[metric]} ms`
        : 'n/a',
    }));

  const columnWidths = metricRows.reduce(
    (widths, row) => ({
      metric: Math.max(widths.metric, row.metric.length),
      current: Math.max(widths.current, row.current.length),
      baseline: Math.max(widths.baseline, row.baseline.length),
    }),
    { metric: 'Metric'.length, current: 'Current'.length, baseline: 'Baseline'.length },
  );

  const formatRow = (metric, current, baselineValue) =>
    `${metric.padEnd(columnWidths.metric)}  ${current.padEnd(columnWidths.current)}  ${baselineValue.padEnd(columnWidths.baseline)}`;

  console.log('\nBaseline benchmark comparison');
  console.log(formatRow('Metric', 'Current', 'Baseline'));
  console.log(formatRow('-'.repeat(columnWidths.metric), '-'.repeat(columnWidths.current), '-'.repeat(columnWidths.baseline)));
  for (const row of metricRows) {
    console.log(formatRow(row.metric, row.current, row.baseline));
  }
}

function runBaselineBenchmark(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const benchmarkDir = options.benchmarkDir ?? path.join(os.tmpdir(), 'natively-baseline-benchmark');
  const benchmarkFile = options.benchmarkFile ?? path.join(benchmarkDir, 'performance-metrics.jsonl');
  const baselineFile = options.baselineFile ?? path.join(repoRoot, 'docs', 'superpowers', 'plans', 'baseline-metrics.json');
  const compiledBenchmarkTest = options.compiledBenchmarkTest ?? path.resolve(
    repoRoot,
    'dist-electron',
    'electron',
    'tests',
    'baselineBenchmarks.test.js',
  );
  const summaryFile = options.summaryFile ?? process.env.NATIVELY_BENCHMARK_SUMMARY_FILE;

  rmSync(benchmarkDir, { recursive: true, force: true });
  mkdirSync(benchmarkDir, { recursive: true });

  execFileSync(
    process.execPath,
    ['--test', compiledBenchmarkTest],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NATIVELY_BENCHMARK_DIR: benchmarkDir,
      },
      stdio: 'inherit',
    },
  );

  if (!existsSync(benchmarkFile)) {
    throw new Error(`Benchmark output missing: ${benchmarkFile}`);
  }

  const benchmarkEvents = readBenchmarkEvents(benchmarkFile);
  const currentMetrics = summarizeBenchmarkEvents(benchmarkEvents);

  let baseline = {};
  if (existsSync(baselineFile)) {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  }

  if (summaryFile) {
    mkdirSync(path.dirname(summaryFile), { recursive: true });
    writeFileSync(
      summaryFile,
      JSON.stringify(
        {
          benchmarkFile,
          metrics: currentMetrics,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  printComparisonTable(currentMetrics, baseline);

  return {
    benchmarkEvents,
    currentMetrics,
    baseline,
  };
}

if (require.main === module) {
  try {
    runBaselineBenchmark();
  } catch (error) {
    console.error('[baseline-benchmark] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  readBenchmarkEvents,
  runBaselineBenchmark,
  summarizeBenchmarkEvents,
};
