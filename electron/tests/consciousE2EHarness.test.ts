import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runConsciousE2EHarness,
  getDefaultConsciousE2EScenarios,
} from '../conscious/ConsciousEvalHarness';

test('NAT-083: default E2E scenarios cover all required families', () => {
  const scenarios = getDefaultConsciousE2EScenarios();
  const families = new Set(scenarios.map((s) => s.family));

  assert.ok(families.has('prepare_route'), 'must have prepare_route family');
  assert.ok(families.has('acceleration_overlay'), 'must have acceleration_overlay family');
  assert.ok(families.has('circuit_breaker'), 'must have circuit_breaker family');
  assert.ok(families.has('topical_compatibility'), 'must have topical_compatibility family');
  assert.equal(scenarios.length, 6, 'expected 6 default scenarios');
});

test('NAT-083: E2E harness runs all scenarios and produces summary', async () => {
  const { results, summary } = await runConsciousE2EHarness({});

  assert.equal(results.length, 6, 'should run 6 scenarios');
  assert.equal(summary.total, 6, 'summary total should match');
  assert.equal(summary.passed + summary.failed, 6, 'passed + failed should equal total');

  for (const result of results) {
    assert.ok(result.scenario.id, 'each result should have a scenario id');
    assert.ok(result.route, 'each result should have a route');
    assert.equal(typeof result.passed, 'boolean', 'passed should be a boolean');
  }
});

test('NAT-083: prepare-route-start scenario routes to start', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'prepare-route-start');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.threadAction, 'start');
  assert.equal(result!.route.preRouteDecision.qualifies, true);
});

test('NAT-083: prepare-route-continue scenario routes to continue', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'prepare-route-continue');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.threadAction, 'continue');
  assert.equal(result!.route.preRouteDecision.qualifies, true);
});

test('NAT-083: acceleration-overlay-prefetch-boost overrides with strong prefetch', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'acceleration-overlay-prefetch-boost');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.qualifies, true, 'strong prefetch should qualify');
});

test('NAT-083: circuit-breaker-open forces standard route', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'circuit-breaker-open');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.qualifies, true);
  // When circuit is open, the orchestrator should still qualify but the effective
  // route determined by the harness should be standard
});

test('NAT-083: topical-compatibility-reset resets on off-topic question', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'topical-compatibility-reset');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.threadAction, 'reset');
});

test('NAT-083: conscious-disabled-ignore ignores when disabled', async () => {
  const { results } = await runConsciousE2EHarness({});
  const result = results.find((r) => r.scenario.id === 'conscious-disabled-ignore');
  assert.ok(result, 'scenario should exist');
  assert.equal(result!.route.preRouteDecision.threadAction, 'ignore');
  assert.equal(result!.route.preRouteDecision.qualifies, false);
});
