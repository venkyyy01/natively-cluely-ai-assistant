const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(command, args, options = {}) {
  const { timeoutMs = 120000 } = options;
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
      if (timeout) clearTimeout(timeout);
      if (!timedOut) reject(err);
    });

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
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
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(testDir, f));
}

async function runTestsInBatches(files, options = {}) {
  const { timeoutMs = 120000 } = options;
  const args = ['--test', ...files];

  return run('node', args, { timeoutMs });
}

async function main() {
  console.log('[verify-electron-coverage] Compiling Electron tests...');
  await run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

  const testFiles = getTestFiles();
  console.log(`[verify-electron-coverage] Found ${testFiles.length} test files`);

  // Run tests in batches of 10 to avoid Node.js test runner hangs
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < testFiles.length; i += batchSize) {
    batches.push(testFiles.slice(i, i + batchSize));
  }

  console.log(`[verify-electron-coverage] Running ${batches.length} batches of tests...`);

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[verify-electron-coverage] Running batch ${i + 1}/${batches.length} (${batch.length} files)...`);

    try {
      const output = await runTestsInBatches(batch, {
        timeoutMs: 120000,
      });

      // Parse summary from this batch
      const testsMatch = output.match(/ℹ tests\s+(\d+)/);
      const passMatch = output.match(/ℹ pass\s+(\d+)/);
      const failMatch = output.match(/ℹ fail\s+(\d+)/);

      if (testsMatch) totalTests += parseInt(testsMatch[1], 10);
      if (passMatch) totalPassed += parseInt(passMatch[1], 10);
      if (failMatch) totalFailed += parseInt(failMatch[1], 10);
    } catch (error) {
      console.error(`[verify-electron-coverage] Batch ${i + 1} failed: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(`\n[verify-electron-coverage] Test summary: ${totalTests} tests, ${totalPassed} passed, ${totalFailed} failed`);

  if (totalFailed > 0) {
    console.error(`Electron tests failed: ${totalFailed} failures`);
    process.exit(1);
  }

  console.log('Electron tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  getTestFiles,
  runTestsInBatches,
};
