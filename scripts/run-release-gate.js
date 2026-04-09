const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

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

function readBaselineMetrics() {
  const baselinePath = path.join(process.cwd(), 'docs', 'superpowers', 'plans', 'baseline-metrics.json');
  return JSON.parse(readFileSync(baselinePath, 'utf-8'));
}

function assertBaselineShape(baseline) {
  const requiredMetrics = [
    'meeting.activation',
    'meeting.deactivation',
    'answer.firstVisible',
    'stealth.toggle',
  ];

  const missing = requiredMetrics.filter((metric) => typeof baseline[metric] !== 'number');
  if (missing.length > 0) {
    throw new Error(`baseline metrics missing required keys: ${missing.join(', ')}`);
  }
}

function runReleaseGate() {
  const profile = process.env.NATIVELY_RELEASE_GATE_PROFILE || 'ci';
  const soakProfile = profile === 'prerelease' ? 'prerelease' : 'ci';

  console.log(`[release-gate] profile=${profile}`);

  runNpmScript('test:soak', {
    NATIVELY_SOAK_PROFILE: soakProfile,
  });
  runNpmScript('test:fault-injection');
  runNpmScript('test:active-renderer-lifecycle');

  const baseline = readBaselineMetrics();
  assertBaselineShape(baseline);

  // Keep threshold checks explicit and deterministic for CI/pre-release gating.
  const latencySloThresholdMs = Number(process.env.NATIVELY_RELEASE_GATE_LATENCY_SLO_MS || '400');
  if (baseline['answer.firstVisible'] > latencySloThresholdMs) {
    throw new Error(
      `baseline answer.firstVisible (${baseline['answer.firstVisible']}ms) exceeds gate threshold (${latencySloThresholdMs}ms)`,
    );
  }

  console.log('[release-gate] all gates passed');
}

try {
  runReleaseGate();
} catch (error) {
  console.error('[release-gate] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
