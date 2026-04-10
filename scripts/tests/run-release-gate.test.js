const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertMetricsWithinGate,
  resolvePackagedHelperLaunchTarget,
  runReleaseGate,
  validatePackagedHelperLaunch,
} = require('../run-release-gate.js');

const baselineMetrics = {
  'meeting.activation': 25,
  'meeting.deactivation': 10,
  'answer.firstVisible': 37,
  'stealth.toggle': 5,
};

test('assertMetricsWithinGate accepts metrics within SLOs and regression budget', () => {
  const currentMetrics = {
    'meeting.activation': 28,
    'meeting.deactivation': 11,
    'answer.firstVisible': 40,
    'stealth.toggle': 6,
  };

  assert.doesNotThrow(() => {
    assertMetricsWithinGate(currentMetrics, baselineMetrics, {
      NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_PCT: '20',
      NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_MS: '10',
    });
  });
});

test('assertMetricsWithinGate rejects missing benchmark metrics', () => {
  assert.throws(
    () => assertMetricsWithinGate(
      { ...baselineMetrics, 'stealth.toggle': undefined },
      baselineMetrics,
      {},
    ),
    /missing required metric keys: stealth.toggle/,
  );
});

test('assertMetricsWithinGate rejects metrics that exceed configured SLO thresholds', () => {
  assert.throws(
    () => assertMetricsWithinGate(
      { ...baselineMetrics, 'answer.firstVisible': 450 },
      baselineMetrics,
      {},
    ),
    /answer\.firstVisible .* exceeds SLO threshold \(400ms\)/,
  );
});

test('assertMetricsWithinGate rejects metrics that regress too far beyond baseline', () => {
  assert.throws(
    () => assertMetricsWithinGate(
      { ...baselineMetrics, 'meeting.activation': 80 },
      baselineMetrics,
      {
        NATIVELY_RELEASE_GATE_MEETING_ACTIVATION_SLO_MS: '300',
        NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_PCT: '10',
        NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_MS: '5',
      },
    ),
    /meeting\.activation .* regressed beyond baseline 25ms/,
  );
});

test('resolvePackagedHelperLaunchTarget infers the packaged app binary path', () => {
  const target = resolvePackagedHelperLaunchTarget({
    NATIVELY_RELEASE_GATE_VALIDATE_PACKAGED_HELPER: '1',
    NATIVELY_RELEASE_GATE_APP_BUNDLE: '/Applications/Natively.app',
  });

  assert.deepEqual(target, {
    appBundle: '/Applications/Natively.app',
    appBinary: '/Applications/Natively.app/Contents/MacOS/Natively',
  });
});

test('validatePackagedHelperLaunch sources build-and-install.sh in library mode', () => {
  const calls = [];

  validatePackagedHelperLaunch(
    {
      appBundle: '/Applications/Natively.app',
      appBinary: '/Applications/Natively.app/Contents/MacOS/Natively',
    },
    {
      scriptPath: '/tmp/build-and-install.sh',
      execFileSyncImpl(command, args, options) {
        calls.push({ command, args, options });
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'bash');
  assert.match(calls[0].args[1], /source "\/tmp\/build-and-install\.sh"/);
  assert.match(calls[0].args[1], /validate_packaged_helper_launch_modes "\/Applications\/Natively\.app" "\/Applications\/Natively\.app\/Contents\/MacOS\/Natively"/);
  assert.equal(calls[0].options.env.BUILD_AND_INSTALL_LIB, '1');
});

test('runReleaseGate executes benchmark enforcement and optional packaged-helper validation', () => {
  const executedScripts = [];
  const validatedTargets = [];

  runReleaseGate({
    env: {
      NATIVELY_RELEASE_GATE_PROFILE: 'prerelease',
      NATIVELY_RELEASE_GATE_VALIDATE_PACKAGED_HELPER: '1',
      NATIVELY_RELEASE_GATE_APP_BUNDLE: '/Applications/Natively.app',
    },
    runNpmScript(scriptName, extraEnv = {}) {
      executedScripts.push({ scriptName, extraEnv });
    },
    readBaselineMetrics() {
      return baselineMetrics;
    },
    runBenchmarksForReleaseGate() {
      return baselineMetrics;
    },
    validatePackagedHelperLaunch(target) {
      validatedTargets.push(target);
    },
  });

  assert.deepEqual(
    executedScripts.map(({ scriptName }) => scriptName),
    ['test:soak', 'test:fault-injection', 'test:active-renderer-lifecycle'],
  );
  assert.equal(executedScripts[0].extraEnv.NATIVELY_SOAK_PROFILE, 'prerelease');
  assert.deepEqual(validatedTargets, [
    {
      appBundle: '/Applications/Natively.app',
      appBinary: '/Applications/Natively.app/Contents/MacOS/Natively',
    },
  ]);
});
