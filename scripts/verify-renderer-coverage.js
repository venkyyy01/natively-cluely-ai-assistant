const { spawnSync } = require('node:child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const THRESHOLDS = {
  statements: 90,
  branches: 100,
  functions: 75,
  lines: 90,
};

function parseCoverageSummary(output) {
  const allFilesLine = output
    .split('\n')
    .find((line) => line.includes('All files'));

  if (!allFilesLine) {
    throw new Error('Renderer coverage summary not found in test output.');
  }

  const percentages = [...allFilesLine.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));

  if (percentages.length < 4) {
    throw new Error(`Renderer coverage gate failed: could not parse metrics from ${allFilesLine.trim()}`);
  }

  return {
    statements: percentages[0],
    branches: percentages[1],
    functions: percentages[2],
    lines: percentages[3],
  };
}

function evaluateCoverage(summary) {
  const failures = Object.entries(THRESHOLDS)
    .filter(([metric, threshold]) => summary[metric] < threshold)
    .map(([metric, threshold]) => `${metric} ${summary[metric]}% < ${threshold}%`);

  return failures.length > 0 ? failures.join(', ') : null;
}

function main() {
  const result = spawnSync(
    npmCommand,
    ['--prefix', 'renderer', 'run', 'test:coverage', '--', '--runInBand'],
    {
      encoding: 'utf8',
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  let summary;

  try {
    summary = parseCoverageSummary(output);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const failureMessage = evaluateCoverage(summary);

  if (failureMessage) {
    console.error(`Renderer coverage gate failed: ${failureMessage}`);
    process.exit(1);
  }

  console.log(
    `Renderer coverage gate passed (statements >= ${THRESHOLDS.statements}%, branches >= ${THRESHOLDS.branches}%, functions >= ${THRESHOLDS.functions}%, lines >= ${THRESHOLDS.lines}%).`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  THRESHOLDS,
  parseCoverageSummary,
  evaluateCoverage,
};
