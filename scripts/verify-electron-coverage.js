const { spawn } = require('node:child_process');

const THRESHOLDS = {
  lines: 50,
  branches: 74,
  functions: 30,
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
        return;
      }

      resolve(output);
    });
  });
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

async function main() {
  console.log('[verify-electron-coverage] Compiling Electron tests...');
  await run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

  console.log('[verify-electron-coverage] Running Electron tests with coverage...');
  const coverageOutput = await run('node', [
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
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  THRESHOLDS,
  parseCoverageSummary,
  evaluateCoverage,
};
