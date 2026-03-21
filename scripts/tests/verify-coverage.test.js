const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCoverageHelpers(scriptRelativePath, spawnResult) {
  const scriptPath = path.resolve(__dirname, '..', scriptRelativePath);
  const source = fs.readFileSync(scriptPath, 'utf8');
  const wrappedSource = `${source}\nmodule.exports = { THRESHOLDS, parseCoverageSummary, evaluateCoverage };`;

  const stdout = [];
  const stderr = [];

  const context = {
    module: { exports: {} },
    exports: {},
    require(request) {
      if (request === 'node:child_process') {
        return { spawnSync: () => spawnResult };
      }

      return require(request);
    },
    console: {
      log: () => {},
      error: () => {},
    },
    process: {
      platform: 'darwin',
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      exit(code) {
        throw new Error(`process.exit:${code}`);
      },
    },
    __dirname: path.dirname(scriptPath),
    __filename: scriptPath,
  };

  vm.runInNewContext(wrappedSource, context, { filename: scriptPath });
  return context.module.exports;
}

test('electron helpers report summary-not-found errors', () => {
  const { parseCoverageSummary } = loadCoverageHelpers('verify-electron-coverage.js', {
    status: 0,
    stdout: 'all files | 100.00 | 100.00 | 100.00\n',
    stderr: '',
  });

  assert.throws(
    () => parseCoverageSummary('TAP version 13\nno summary here\n'),
    /Coverage summary not found/
  );
});

test('electron helpers parse summary lines and pass thresholds', () => {
  const { THRESHOLDS, parseCoverageSummary, evaluateCoverage } = loadCoverageHelpers('verify-electron-coverage.js', {
    status: 0,
    stdout: 'all files | 100.00 | 100.00 | 100.00\n',
    stderr: '',
  });

  const summary = parseCoverageSummary('all files | 58.10 | 81.25 | 44.40\n');
  assert.deepEqual({ ...summary }, { lines: 58.1, branches: 81.25, functions: 44.4 });
  assert.equal(evaluateCoverage(summary), null);
  assert.deepEqual({ ...THRESHOLDS }, { lines: 50, branches: 75, functions: 30 });
});

test('electron helpers report threshold failures clearly', () => {
  const { evaluateCoverage } = loadCoverageHelpers('verify-electron-coverage.js', {
    status: 0,
    stdout: 'all files | 100.00 | 100.00 | 100.00\n',
    stderr: '',
  });

  assert.match(
    evaluateCoverage({ lines: 49.9, branches: 74.5, functions: 29.9 }),
    /lines 49.9% < 50%, branches 74.5% < 75%, functions 29.9% < 30%/
  );
});

test('renderer helpers report summary-not-found errors', () => {
  const { parseCoverageSummary } = loadCoverageHelpers('verify-renderer-coverage.js', {
    status: 0,
    stdout: 'All files | 100 | 100 | 100 | 100\n',
    stderr: '',
  });

  assert.throws(
    () => parseCoverageSummary('TAP version 13\nmissing renderer summary\n'),
    /Renderer coverage summary not found/
  );
});

test('renderer helpers parse summary lines and pass thresholds', () => {
  const { THRESHOLDS, parseCoverageSummary, evaluateCoverage } = loadCoverageHelpers('verify-renderer-coverage.js', {
    status: 0,
    stdout: 'All files | 100 | 100 | 100 | 100\n',
    stderr: '',
  });

  const summary = parseCoverageSummary('All files | 95.5 | 100 | 82.25 | 93.1\n');
  assert.deepEqual({ ...summary }, {
    statements: 95.5,
    branches: 100,
    functions: 82.25,
    lines: 93.1,
  });
  assert.equal(evaluateCoverage(summary), null);
  assert.deepEqual({ ...THRESHOLDS }, { statements: 90, branches: 100, functions: 75, lines: 90 });
});

test('renderer helpers report threshold failures clearly', () => {
  const { evaluateCoverage } = loadCoverageHelpers('verify-renderer-coverage.js', {
    status: 0,
    stdout: 'All files | 100 | 100 | 100 | 100\n',
    stderr: '',
  });

  assert.match(
    evaluateCoverage({ statements: 89.9, branches: 99.9, functions: 74.9, lines: 88.8 }),
    /statements 89.9% < 90%, branches 99.9% < 100%, functions 74.9% < 75%, lines 88.8% < 90%/
  );
});
