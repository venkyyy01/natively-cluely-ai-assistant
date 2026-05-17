import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTier,
  computeWorkerCount,
  computeHeapSize,
  computeCacheMemory,
  detectHardware,
  applyAdaptiveAcceleration,
  getOptimizationFlags,
  setOptimizationFlagsForTesting,
  type HardwareTier,
} from '../config/optimizations';

// ─────────────────────────────────────────────────────────────────────────────
// classifyTier
// ─────────────────────────────────────────────────────────────────────────────

test('classifyTier: ≤8 GB → constrained', () => {
  assert.equal(classifyTier(1), 'constrained');
  assert.equal(classifyTier(4), 'constrained');
  assert.equal(classifyTier(8), 'constrained');
});

test('classifyTier: 9–16 GB → standard', () => {
  assert.equal(classifyTier(9), 'standard');
  assert.equal(classifyTier(12), 'standard');
  assert.equal(classifyTier(16), 'standard');
});

test('classifyTier: ≥17 GB → high-capacity', () => {
  assert.equal(classifyTier(17), 'high-capacity');
  assert.equal(classifyTier(32), 'high-capacity');
  assert.equal(classifyTier(64), 'high-capacity');
});

// ─────────────────────────────────────────────────────────────────────────────
// computeWorkerCount
// ─────────────────────────────────────────────────────────────────────────────

test('computeWorkerCount: constrained tier caps at 2', () => {
  assert.equal(computeWorkerCount('constrained', 1), 1);
  assert.equal(computeWorkerCount('constrained', 2), 2);
  assert.equal(computeWorkerCount('constrained', 8), 2);
  assert.equal(computeWorkerCount('constrained', 16), 2);
});

test('computeWorkerCount: standard tier uses cores-2 clamped to [2, 6]', () => {
  assert.equal(computeWorkerCount('standard', 2), 2); // cores-2=0, max(2,0)=2
  assert.equal(computeWorkerCount('standard', 4), 2); // cores-2=2, max(2,2)=2
  assert.equal(computeWorkerCount('standard', 6), 4); // cores-2=4, max(2,min(4,6))=4
  assert.equal(computeWorkerCount('standard', 8), 6); // cores-2=6, max(2,min(6,6))=6
  assert.equal(computeWorkerCount('standard', 10), 6); // cores-2=8, max(2,min(8,6))=6
});

test('computeWorkerCount: high-capacity tier uses cores-2 clamped to [2, 12]', () => {
  assert.equal(computeWorkerCount('high-capacity', 2), 2); // cores-2=0, max(2,0)=2
  assert.equal(computeWorkerCount('high-capacity', 4), 2); // cores-2=2, max(2,2)=2
  assert.equal(computeWorkerCount('high-capacity', 8), 6); // cores-2=6, max(2,min(6,12))=6
  assert.equal(computeWorkerCount('high-capacity', 12), 10); // cores-2=10, max(2,min(10,12))=10
  assert.equal(computeWorkerCount('high-capacity', 14), 12); // cores-2=12, max(2,min(12,12))=12
  assert.equal(computeWorkerCount('high-capacity', 20), 12); // cores-2=18, max(2,min(18,12))=12
});

// ─────────────────────────────────────────────────────────────────────────────
// computeHeapSize
// ─────────────────────────────────────────────────────────────────────────────

test('computeHeapSize: returns correct values per tier', () => {
  assert.equal(computeHeapSize('constrained'), 512);
  assert.equal(computeHeapSize('standard'), 1024);
  assert.equal(computeHeapSize('high-capacity'), 2048);
});

// ─────────────────────────────────────────────────────────────────────────────
// computeCacheMemory
// ─────────────────────────────────────────────────────────────────────────────

test('computeCacheMemory: returns correct values per tier', () => {
  assert.equal(computeCacheMemory('constrained'), 50);
  assert.equal(computeCacheMemory('standard'), 100);
  assert.equal(computeCacheMemory('high-capacity'), 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// detectHardware
// ─────────────────────────────────────────────────────────────────────────────

test('detectHardware: returns a valid HardwareProfile', () => {
  const profile = detectHardware();
  assert.ok(profile.cpuCores >= 1, 'cpuCores should be at least 1');
  assert.ok(profile.ramGB >= 1, 'ramGB should be at least 1');
  assert.ok(
    ['constrained', 'standard', 'high-capacity'].includes(profile.tier),
    `tier should be valid, got: ${profile.tier}`
  );
  assert.ok(profile.arch.length > 0, 'arch should be non-empty');
});

test('detectHardware: tier matches classifyTier(ramGB)', () => {
  const profile = detectHardware();
  assert.equal(profile.tier, classifyTier(profile.ramGB));
});

// ─────────────────────────────────────────────────────────────────────────────
// applyAdaptiveAcceleration
// ─────────────────────────────────────────────────────────────────────────────

test('applyAdaptiveAcceleration: applies computed values to optimization flags', () => {
  // Reset flags to defaults before test
  setOptimizationFlagsForTesting({});

  const profile = applyAdaptiveAcceleration();
  const flags = getOptimizationFlags();

  const expectedWorkers = computeWorkerCount(profile.tier, profile.cpuCores);
  const expectedCache = computeCacheMemory(profile.tier);

  assert.equal(flags.workerThreadCount, expectedWorkers);
  assert.equal(flags.maxCacheMemoryMB, expectedCache);
});

test('applyAdaptiveAcceleration: respects user override for workerThreadCount', () => {
  setOptimizationFlagsForTesting({});

  const profile = applyAdaptiveAcceleration({ workerThreadCount: 3 });
  const flags = getOptimizationFlags();

  assert.equal(flags.workerThreadCount, 3);
  // Cache should still be auto-detected
  const expectedCache = computeCacheMemory(profile.tier);
  assert.equal(flags.maxCacheMemoryMB, expectedCache);
});

test('applyAdaptiveAcceleration: respects user override for maxCacheMemoryMB', () => {
  setOptimizationFlagsForTesting({});

  const profile = applyAdaptiveAcceleration({ maxCacheMemoryMB: 75 });
  const flags = getOptimizationFlags();

  assert.equal(flags.maxCacheMemoryMB, 75);
  // Workers should still be auto-detected
  const expectedWorkers = computeWorkerCount(profile.tier, profile.cpuCores);
  assert.equal(flags.workerThreadCount, expectedWorkers);
});

test('applyAdaptiveAcceleration: respects both user overrides', () => {
  setOptimizationFlagsForTesting({});

  applyAdaptiveAcceleration({ workerThreadCount: 5, maxCacheMemoryMB: 150 });
  const flags = getOptimizationFlags();

  assert.equal(flags.workerThreadCount, 5);
  assert.equal(flags.maxCacheMemoryMB, 150);
});

test('applyAdaptiveAcceleration: returns a valid HardwareProfile', () => {
  const profile = applyAdaptiveAcceleration();
  assert.ok(profile.cpuCores >= 1);
  assert.ok(profile.ramGB >= 1);
  assert.ok(['constrained', 'standard', 'high-capacity'].includes(profile.tier));
  assert.ok(profile.arch.length > 0);
});
