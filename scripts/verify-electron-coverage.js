const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const THRESHOLDS = {
  lines: 50,
  branches: 75,
  functions: 30,
};

const COVERAGE_EXCLUDES = [
  'native-module/**',
  'postcss.config.js',
  'tailwind.config.js',
];

function parseCoverageSummary(output) {
  const allFilesLine = output
    .split('\n')
    .find((line) => line.toLowerCase().includes('all files'));

  if (!allFilesLine) {
    throw new Error('Coverage summary not found in test output.');
  }

  const percentages = [...allFilesLine.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));

  if (percentages.length < 3) {
    throw new Error(`Coverage gate failed: could not parse metrics from ${allFilesLine.trim()}`);
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

function run(command, args, options = {}) {
  const { timeoutMs = 180000 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

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

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!timedOut) reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
        return;
      }

      resolve(output);
    });
  });
}

function getTestFiles() {
  const testDir = path.resolve('dist-electron/electron/tests');
  if (!fs.existsSync(testDir)) {
    throw new Error(`Test directory not found: ${testDir}`);
  }

  return fs.readdirSync(testDir)
    .filter((fileName) => fileName.endsWith('.test.js'))
    .map((fileName) => path.join(testDir, fileName));
}

async function runAllTestsWithCoverage(files, options = {}) {
  const args = ['--test', '--experimental-test-coverage'];
  for (const pattern of COVERAGE_EXCLUDES) {
    args.push(`--test-coverage-exclude=${pattern}`);
  }
  args.push(...files);
  return run('node', args, options);
}

async function main() {
  console.log('[verify-electron-coverage] Compiling Electron tests...');
  await run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

  const testFiles = getTestFiles();
  console.log(`[verify-electron-coverage] Running ${testFiles.length} Electron test files with coverage...`);

  const output = await runAllTestsWithCoverage(testFiles);

  let summary;
  try {
    summary = parseCoverageSummary(output);
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
  COVERAGE_EXCLUDES,
  parseCoverageSummary,
  evaluateCoverage,
  getTestFiles,
  runAllTestsWithCoverage,
};
