import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  setOptimizationFlags,
  isOptimizationActive,
  DEFAULT_OPTIMIZATION_FLAGS,
  isSupervisorRuntimeEnabled,
} from '../config/optimizations';

describe('Acceleration Mode Integration', () => {
  beforeEach(() => {
    setOptimizationFlags({ accelerationEnabled: false });
  });

  it('should disable all optimizations when master toggle is off', () => {
    setOptimizationFlags({ accelerationEnabled: false });

    assert.strictEqual(isOptimizationActive('usePromptCompiler'), false);
    assert.strictEqual(isOptimizationActive('useStreamManager'), false);
    assert.strictEqual(isOptimizationActive('useEnhancedCache'), false);
    assert.strictEqual(isOptimizationActive('useStealthMode'), false);
  });

  it('should enable optimizations when master toggle is on', () => {
    setOptimizationFlags({
      accelerationEnabled: true,
      usePromptCompiler: true,
      useStreamManager: true,
      useEnhancedCache: true,
    });

    assert.strictEqual(isOptimizationActive('usePromptCompiler'), true);
    assert.strictEqual(isOptimizationActive('useStreamManager'), true);
    assert.strictEqual(isOptimizationActive('useEnhancedCache'), true);
  });

  it('should respect individual feature flags', () => {
    setOptimizationFlags({
      accelerationEnabled: true,
      usePromptCompiler: true,
      useStreamManager: false,
      useEnhancedCache: true,
    });

    assert.strictEqual(isOptimizationActive('usePromptCompiler'), true);
    assert.strictEqual(isOptimizationActive('useStreamManager'), false);
    assert.strictEqual(isOptimizationActive('useEnhancedCache'), true);
  });

  it('should keep supervisor runtime disabled by default until explicitly enabled', () => {
    setOptimizationFlags(DEFAULT_OPTIMIZATION_FLAGS);
    assert.strictEqual(isSupervisorRuntimeEnabled(), false);

    setOptimizationFlags({ enableSupervisorRuntime: true });
    assert.strictEqual(isSupervisorRuntimeEnabled(), true);
  });
});
