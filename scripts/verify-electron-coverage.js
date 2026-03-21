const { spawnSync } = require('node:child_process');

const THRESHOLDS = {
  lines: 50,
  branches: 75,
  functions: 30,
};

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function parseCoverageSummary(output) {
  const allFilesLine = output
    .split('\n')
    .find((line) => line.includes('all files'));

  if (!allFilesLine) {
    throw new Error('Coverage summary not found in test output.');
  }

  const percentages = [...allFilesLine.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));

  if (percentages.length < 3) {
    throw new Error(`Electron coverage gate failed: could not parse metrics from ${allFilesLine.trim()}`);
  }

  return {
    lines: percentages[0],
    branches: percentages[1],
    functions: percentages[2],
  };
}

function evaluateCoverage(summary) {
  const failures = Object.entries(THRESHOLDS)
    .filter(([metric, threshold]) => summary[metric] < threshold)
    .map(([metric, threshold]) => `${metric} ${summary[metric]}% < ${threshold}%`);

  return failures.length > 0 ? failures.join(', ') : null;
}

function main() {
  run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

  const coverageOutput = run('node', [
    '--test',
    '--experimental-test-coverage',
    'dist-electron/electron/tests/*.test.js',
  ]);

  let summary;

  try {
    summary = parseCoverageSummary(coverageOutput);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const failureMessage = evaluateCoverage(summary);

  if (failureMessage) {
    console.error(`Electron coverage gate failed: ${failureMessage}`);
    process.exit(1);
  }

  console.log(
    `Electron coverage gate passed (lines >= ${THRESHOLDS.lines}%, branches >= ${THRESHOLDS.branches}%, functions >= ${THRESHOLDS.functions}%).`
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
