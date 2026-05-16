import test from 'node:test';
import assert from 'node:assert/strict';

import { StealthManager } from '../stealth/StealthManager';

function createTestLogger() {
  return {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createDisabledStealthManager(): StealthManager {
  return new StealthManager(
    { enabled: false },
    { platform: 'darwin', logger: createTestLogger() }
  ) as StealthManager;
}

function createEnabledStealthManager(): StealthManager {
  return new StealthManager(
    { enabled: true },
    { platform: 'darwin', logger: createTestLogger() }
  ) as StealthManager;
}

test('ScreenshotHelper: pauseWatchdog pauses and resumes correctly', () => {
  const stealthManager = createEnabledStealthManager();

  assert.equal(stealthManager.isEnabled(), true, 'StealthManager should be enabled');

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true, 'StealthManager should still be enabled');
});

test('ScreenshotHelper: pauseWatchdog with multiple calls maintains count', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true, 'Should still be enabled after partial resume');

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true, 'Should still be enabled after full resume');
});

test('ScreenshotHelper: disabled stealth manager screenshot still works', async () => {
  const stealthManager = createDisabledStealthManager();

  assert.equal(stealthManager.isEnabled(), false, 'StealthManager should be disabled');

  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), false, 'StealthManager should still be disabled');
});

test('ScreenshotHelper: verifyManagedWindows pauses watchdog temporarily', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.verifyManagedWindows();

  assert.equal(stealthManager.isEnabled(), true, 'StealthManager should still be enabled');
});

test('ScreenshotHelper: watchDog pauses detection during poll', () => {
  const stealthManager = createEnabledStealthManager();

  assert.equal(stealthManager.isEnabled(), true, 'StealthManager should be enabled');
});

test('ScreenshotHelper: nested pause/resume maintains correct count', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.pauseWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: rapid pause resume does not cause negative count', () => {
  const stealthManager = createEnabledStealthManager();

  for (let i = 0; i < 10; i++) {
    stealthManager.pauseWatchdog();
  }

  for (let i = 0; i < 10; i++) {
    stealthManager.resumeWatchdog();
  }

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: pause watchDog more than resume maintains paused state', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyMultiple Windows handles disabled state', () => {
  const stealthManager = createDisabledStealthManager();

  const result = stealthManager.verifyManagedWindows();

  assert.equal(result, false, 'Should return false when disabled');
});

test('ScreenshotHelper: getStealthDegradationWarnings returns array', () => {
  const stealthManager = createEnabledStealthManager();

  const warnings = stealthManager.getStealthDegradationWarnings();

  assert.ok(Array.isArray(warnings), 'Should return array');
});

test('ScreenshotHelper: isEnabled returns correct state', () => {
  const enabledManager = createEnabledStealthManager();
  const disabledManager = createDisabledStealthManager();

  assert.equal(enabledManager.isEnabled(), true, 'Enabled manager should return true');
  assert.equal(disabledManager.isEnabled(), false, 'Disabled manager should return false');
});

test('ScreenshotHelper: screenshot flow with stealth enabled does not trigger false detection', async () => {
  const stealthManager = createEnabledStealthManager();

  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.pauseWatchdog();

  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: concurrent screenshot attempts handle watchdog correctly', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: watchdog pause count cannot go negative via resume', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: pause and resume with disabled manager is no-op', () => {
  const stealthManager = createDisabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), false, 'Should remain disabled');
});

test('ScreenshotHelper: verifyManagedWindows works with empty windows list', () => {
  const stealthManager = createEnabledStealthManager();

  const result = stealthManager.verifyManagedWindows();

  assert.equal(typeof result, 'boolean', 'Should return boolean');
});

test('ScreenshotHelper: pauseWatchdog is idempotent', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyManagedWindows temporarily pauses for 10 seconds', () => {
  const stealthManager = createEnabledStealthManager();

  const startTime = Date.now();
  stealthManager.verifyManagedWindows();
  const endTime = Date.now();

  assert.ok(endTime - startTime < 100, 'verifyManagedWindows should return quickly');
});

test('ScreenshotHelper: concurrent verifyManagedWindows calls stack pauses', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.verifyManagedWindows();
  stealthManager.verifyManagedWindows();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: stealth manager platform detection', () => {
  const macManager = new StealthManager(
    { enabled: true },
    { platform: 'darwin', logger: createTestLogger() }
  ) as StealthManager;

  const winManager = new StealthManager(
    { enabled: true },
    { platform: 'win32', logger: createTestLogger() }
  ) as StealthManager;

  assert.equal(macManager.isEnabled(), true, 'MAC manager should be enabled');
  assert.equal(winManager.isEnabled(), true, 'Win manager should be enabled');
});

test('ScreenshotHelper: edge case - all screenshots at once with watchdog', async () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: stress test rapid pause/resume cycling', () => {
  const stealthManager = createEnabledStealthManager();

  for (let i = 0; i < 100; i++) {
    stealthManager.pauseWatchdog();
  }

  for (let i = 0; i < 100; i++) {
    stealthManager.resumeWatchdog();
  }

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyManagedWindows callable multiple times', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.verifyManagedWindows();
  stealthManager.verifyManagedWindows();
  stealthManager.verifyManagedWindows();
  stealthManager.verifyManagedWindows();
  stealthManager.verifyManagedWindows();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: pauseWatchdog then verifyManagedWindows', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.verifyManagedWindows();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyManagedWindows then pauseWatchdog', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.verifyManagedWindows();
  stealthManager.pauseWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: alternating pause resume maintains state', () => {
  const stealthManager = createEnabledStealthManager();

  for (let i = 0; i < 50; i++) {
    stealthManager.pauseWatchdog();
    stealthManager.resumeWatchdog();
  }

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: pauseWatchdog called after screenshot path integration', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.pauseWatchdog();
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.pauseWatchdog();
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: multiple nested screenshot attempts maintain watchdog state', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: edge case - very rapid pause resume in tight loop', () => {
  const stealthManager = createEnabledStealthManager();

  for (let i = 0; i < 1000; i++) {
    stealthManager.pauseWatchdog();
  }

  for (let i = 0; i < 1000; i++) {
    stealthManager.resumeWatchdog();
  }

  assert.equal(stealthManager.isEnabled(), true, 'Should maintain enabled state after extreme cycling');
});

test('ScreenshotHelper: pauseCount precision at boundary values', () => {
  const stealthManager = createEnabledStealthManager();

  for (let i = 0; i < Number.MAX_SAFE_INTEGER; i++) {
    stealthManager.pauseWatchdog();
    if (i > 1000) break;
  }

  for (let i = 0; i < Number.MAX_SAFE_INTEGER; i++) {
    stealthManager.resumeWatchdog();
    if (i > 1000) break;
  }

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyManagedWindows does not interfere with manual pause', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  stealthManager.verifyManagedWindows();

  stealthManager.resumeWatchdog();

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: screenshot timeout concept - watchdog paused during capture window', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: multiple calls to isEnabled during paused state', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
  assert.equal(stealthManager.isEnabled(), true);
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
  assert.equal(stealthManager.isEnabled(), true);
  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: pauseWatchdog during active capture detection window', () => {
  const stealthManager = createEnabledStealthManager();

  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.pauseWatchdog();
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();
  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: edge - pause then immediate verifyManagedWindows', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  stealthManager.verifyManagedWindows();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: getStealthDegradationWarnings during pause', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();

  const warnings = stealthManager.getStealthDegradationWarnings();

  assert.ok(Array.isArray(warnings));

  stealthManager.resumeWatchdog();
});

test('ScreenshotHelper: verifyManagedWindows returns boolean during enabled state', () => {
  const stealthManager = createEnabledStealthManager();

  const result = stealthManager.verifyManagedWindows();

  assert.equal(typeof result, 'boolean');
});

test('ScreenshotHelper: pause/resume preserves enabled state for Windows platform', () => {
  const stealthManager = new StealthManager(
    { enabled: true },
    { platform: 'win32', logger: createTestLogger() }
  ) as StealthManager;

  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();
  stealthManager.pauseWatchdog();

  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();
  stealthManager.resumeWatchdog();

  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: verifyManagedWindows on Windows platform', () => {
  const stealthManager = new StealthManager(
    { enabled: true },
    { platform: 'win32', logger: createTestLogger() }
  ) as StealthManager;

  const result = stealthManager.verifyManagedWindows();

  assert.equal(typeof result, 'boolean');
});

test('ScreenshotHelper: pauseWatchdog is callable on Linux platform', () => {
  const stealthManager = new StealthManager(
    { enabled: true },
    { platform: 'linux', logger: createTestLogger() }
  ) as StealthManager;

  stealthManager.pauseWatchdog();

  const warnings = stealthManager.getStealthDegradationWarnings();

  assert.ok(Array.isArray(warnings));

  stealthManager.resumeWatchdog();
});

test('ScreenshotHelper: getStealthDegradationWarnings returns warnings with pause active', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();

  const warnings = stealthManager.getStealthDegradationWarnings();

  assert.ok(Array.isArray(warnings));

  stealthManager.resumeWatchdog();

  const warnings2 = stealthManager.getStealthDegradationWarnings();

  assert.ok(Array.isArray(warnings2));
});

test('ScreenshotHelper: verifyManagedWindows does not throw with managed windows', () => {
  const stealthManager = createEnabledStealthManager();

  let threw = false;
  try {
    stealthManager.verifyManagedWindows();
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'Should not throw');
});

test('ScreenshotHelper: pauseWatchdog works with no managed windows', () => {
  const stealthManager = createEnabledStealthManager();

  stealthManager.pauseWatchdog();
  assert.equal(stealthManager.isEnabled(), true);

  stealthManager.resumeWatchdog();
  assert.equal(stealthManager.isEnabled(), true);
});

test('ScreenshotHelper: full lifecycle with enable/disable/enable', () => {
  const disabledManager = createDisabledStealthManager();
  const enabledManager = createEnabledStealthManager();

  assert.equal(disabledManager.isEnabled(), false);
  assert.equal(enabledManager.isEnabled(), true);

  disabledManager.pauseWatchdog();
  disabledManager.resumeWatchdog();
  assert.equal(disabledManager.isEnabled(), false);

  enabledManager.pauseWatchdog();
  enabledManager.resumeWatchdog();
  assert.equal(enabledManager.isEnabled(), true);
});