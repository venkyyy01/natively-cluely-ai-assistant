const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_BENCHMARK_METRICS = [
  'meeting.activation',
  'meeting.deactivation',
  'answer.firstVisible',
  'stealth.toggle',
];

function runNpmScript(scriptName, extraEnv = {}) {
  const result = spawnSync('npm', ['run', scriptName], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.status !== 0) {
    throw new Error(`release gate failed while running ${scriptName}`);
  }
}

function readFiniteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

function isTruthyFlag(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /^(1|true|yes|on)$/i.test(value.trim());
}

function readBaselineMetrics(cwd = process.cwd()) {
  const baselinePath = path.join(cwd, 'docs', 'superpowers', 'plans', 'baseline-metrics.json');
  return JSON.parse(readFileSync(baselinePath, 'utf-8'));
}

function assertMetricsShape(metrics, label) {
  const missing = REQUIRED_BENCHMARK_METRICS.filter((metric) => typeof metrics?.[metric] !== 'number');
  if (missing.length > 0) {
    throw new Error(`${label} missing required metric keys: ${missing.join(', ')}`);
  }
}

function buildSloThresholds(env = process.env) {
  return {
    'meeting.activation': readFiniteNumber(
      env.NATIVELY_RELEASE_GATE_MEETING_ACTIVATION_SLO_MS ?? '300',
      'NATIVELY_RELEASE_GATE_MEETING_ACTIVATION_SLO_MS',
    ),
    'meeting.deactivation': readFiniteNumber(
      env.NATIVELY_RELEASE_GATE_MEETING_DEACTIVATION_SLO_MS ?? '2000',
      'NATIVELY_RELEASE_GATE_MEETING_DEACTIVATION_SLO_MS',
    ),
    'answer.firstVisible': readFiniteNumber(
      env.NATIVELY_RELEASE_GATE_FIRST_VISIBLE_SLO_MS ?? '400',
      'NATIVELY_RELEASE_GATE_FIRST_VISIBLE_SLO_MS',
    ),
    'stealth.toggle': readFiniteNumber(
      env.NATIVELY_RELEASE_GATE_STEALTH_TOGGLE_SLO_MS ?? '200',
      'NATIVELY_RELEASE_GATE_STEALTH_TOGGLE_SLO_MS',
    ),
  };
}

function assertMetricsWithinGate(currentMetrics, baselineMetrics, env = process.env) {
  assertMetricsShape(currentMetrics, 'current benchmark');
  assertMetricsShape(baselineMetrics, 'baseline benchmark');

  const thresholds = buildSloThresholds(env);
  const regressionPct = readFiniteNumber(
    env.NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_PCT ?? '20',
    'NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_PCT',
  );
  const regressionSlackMs = readFiniteNumber(
    env.NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_MS ?? '25',
    'NATIVELY_RELEASE_GATE_MAX_BASELINE_REGRESSION_MS',
  );

  for (const metric of REQUIRED_BENCHMARK_METRICS) {
    const currentValue = currentMetrics[metric];
    const threshold = thresholds[metric];
    if (currentValue > threshold) {
      throw new Error(
        `current ${metric} (${currentValue}ms) exceeds SLO threshold (${threshold}ms)`,
      );
    }

    const baselineValue = baselineMetrics[metric];
    if (baselineValue > 0) {
      const allowedRegression = baselineValue * (1 + (regressionPct / 100)) + regressionSlackMs;
      if (currentValue > allowedRegression) {
        throw new Error(
          `current ${metric} (${currentValue}ms) regressed beyond baseline ${baselineValue}ms (max allowed ${allowedRegression.toFixed(1)}ms)`,
        );
      }
    }
  }
}

function runBenchmarksForReleaseGate(options = {}) {
  const env = options.env ?? process.env;
  const runScript = options.runNpmScript ?? runNpmScript;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'natively-release-gate-'));
  const summaryFile = path.join(tempDir, 'baseline-summary.json');

  try {
    runScript('bench:baseline', {
      ...env,
      NATIVELY_BENCHMARK_SUMMARY_FILE: summaryFile,
    });

    const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
    assertMetricsShape(summary.metrics, 'current benchmark');
    return summary.metrics;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function findLatestPackagedAppBundle(cwd = process.cwd(), env = process.env, options = {}) {
  const fileExists = options.existsSync ?? existsSync;
  const readDirectory = options.readdirSync ?? readdirSync;
  const readStats = options.statSync ?? statSync;
  const releaseDir = env.NATIVELY_RELEASE_GATE_RELEASE_DIR?.trim() || path.join(cwd, 'release');
  if (!fileExists(releaseDir)) {
    return null;
  }

  const appBundles = [];
  const pendingDirs = [releaseDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    const entries = readDirectory(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) {
          appBundles.push(fullPath);
          continue;
        }

        pendingDirs.push(fullPath);
      }
    }
  }

  if (appBundles.length === 0) {
    return null;
  }

  appBundles.sort((left, right) => readStats(right).mtimeMs - readStats(left).mtimeMs);
  return appBundles[0];
}

function resolvePackagedHelperLaunchTarget(env = process.env, options = {}) {
  const explicitValidationRequested = isTruthyFlag(env.NATIVELY_RELEASE_GATE_VALIDATE_PACKAGED_HELPER ?? '');
  const allowAutoDiscovery = !isTruthyFlag(env.NATIVELY_RELEASE_GATE_SKIP_PACKAGED_HELPER_VALIDATION ?? '');
  const platform = options.platform ?? process.platform;
  const discoverPackagedAppBundle = options.discoverPackagedAppBundle ?? findLatestPackagedAppBundle;
  const cwd = options.cwd ?? process.cwd();

  let appBundle = env.NATIVELY_RELEASE_GATE_APP_BUNDLE?.trim() || '';
  if (!appBundle && allowAutoDiscovery && platform === 'darwin') {
    appBundle = discoverPackagedAppBundle(cwd, env) ?? '';
  }

  if (!explicitValidationRequested && !appBundle) {
    return null;
  }

  if (!appBundle) {
    throw new Error(
      'NATIVELY_RELEASE_GATE_APP_BUNDLE is required when packaged helper validation is explicitly enabled',
    );
  }

  const appName = path.basename(appBundle, path.extname(appBundle));
  const appBinary = env.NATIVELY_RELEASE_GATE_APP_BINARY?.trim()
    || path.join(appBundle, 'Contents', 'MacOS', appName);

  return {
    appBundle,
    appBinary,
  };
}

function validatePackagedHelperLaunch(target, options = {}) {
  const env = options.env ?? process.env;
  const scriptPath = options.scriptPath ?? path.join(process.cwd(), 'build-and-install.sh');
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const quotedScriptPath = JSON.stringify(scriptPath);
  const quotedAppBundle = JSON.stringify(target.appBundle);
  const quotedAppBinary = JSON.stringify(target.appBinary);

  execFileSyncImpl(
    'bash',
    [
      '-lc',
      `source ${quotedScriptPath} && validate_packaged_helper_launch_modes ${quotedAppBundle} ${quotedAppBinary}`,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
        BUILD_AND_INSTALL_LIB: '1',
      },
    },
  );
}

function runReleaseGate(options = {}) {
  const env = options.env ?? process.env;
  const runScript = options.runNpmScript ?? runNpmScript;
  const baselineMetricsReader = options.readBaselineMetrics ?? readBaselineMetrics;
  const benchmarkRunner = options.runBenchmarksForReleaseGate ?? runBenchmarksForReleaseGate;
  const helperValidator = options.validatePackagedHelperLaunch ?? validatePackagedHelperLaunch;
  const soakProfile = env.NATIVELY_RELEASE_GATE_PROFILE === 'prerelease' ? 'prerelease' : 'ci';

  console.log(`[release-gate] profile=${soakProfile}`);

  runScript('test:soak', {
    ...env,
    NATIVELY_SOAK_PROFILE: soakProfile,
  });
  runScript('test:fault-injection', env);
  runScript('test:active-renderer-lifecycle', env);

  const currentMetrics = benchmarkRunner({ env, runNpmScript: runScript });
  const baselineMetrics = baselineMetricsReader(options.cwd ?? process.cwd());
  assertMetricsWithinGate(currentMetrics, baselineMetrics, env);

  const packagedHelperLaunchTarget = resolvePackagedHelperLaunchTarget(env, {
    cwd: options.cwd,
  });
  if (packagedHelperLaunchTarget) {
    helperValidator(packagedHelperLaunchTarget, {
      env,
      scriptPath: options.buildAndInstallScriptPath,
    });
  }

  console.log('[release-gate] all gates passed');
}

if (require.main === module) {
  try {
    runReleaseGate();
  } catch (error) {
    console.error('[release-gate] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_BENCHMARK_METRICS,
  assertMetricsShape,
  assertMetricsWithinGate,
  buildSloThresholds,
  findLatestPackagedAppBundle,
  readBaselineMetrics,
  resolvePackagedHelperLaunchTarget,
  runBenchmarksForReleaseGate,
  runNpmScript,
  runReleaseGate,
  validatePackagedHelperLaunch,
};
