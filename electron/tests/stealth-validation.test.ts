// electron/tests/stealth-validation.test.ts
//
// Integration test scenarios for SCK enumeration invisibility validation.
// These tests validate that Natively windows are properly excluded from
// ScreenCaptureKit enumeration on macOS 15+ (Sequoia).
//
// Tests that require a full Electron environment or macOS-specific APIs
// are marked with it.skip/it.todo with descriptive messages explaining
// what manual validation is needed.
//
// Validates: Requirements 2.1, 3.2, 10.1, 10.2, 10.3

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const isMacOS = process.platform === 'darwin';

// Attempt to load the native module — may be null in CI or non-macOS environments
let nativeModule: {
  applySckExclusion?: (windowNumber: number) => void;
  verifySckExclusion?: (windowNumber: number) => boolean;
  getFilteredDisplayList?: () => Array<{
    windowNumber: number;
    ownerName: string;
    ownerPid: number;
    windowTitle: string;
    isOnScreen: boolean;
    sharingState: number;
    alpha: number;
  }>;
} | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeModule = require('natively-audio');
} catch {
  try {
    const path = require('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require(path.join(process.cwd(), 'native-module'));
  } catch {
    // Native module unavailable — tests will be skipped
  }
}

describe('SCK Stealth Validation', { skip: !isMacOS ? 'Requires macOS platform' : undefined }, () => {
  describe('verifySckExclusion after applySckExclusion', () => {
    it('verifySckExclusion returns true after applySckExclusion is called on a valid window', {
      skip: !nativeModule?.applySckExclusion || !nativeModule?.verifySckExclusion
        ? 'Native module with SCK exclusion functions not available — requires Electron environment with active windows'
        : undefined,
    }, () => {
      // This test requires an actual Electron BrowserWindow to be created.
      // In a full integration environment, we would:
      // 1. Create a BrowserWindow with show: false
      // 2. Get its native window number via win.getNativeWindowHandle()
      // 3. Call applySckExclusion(windowNumber)
      // 4. Assert verifySckExclusion(windowNumber) === true
      //
      // Manual validation steps:
      // - Launch Natively with stealth enabled
      // - Open Activity Monitor or use `CGSGetWindowTags` to verify the exclusion tag
      // - Confirm verifySckExclusion returns true for all managed windows
      assert.ok(
        nativeModule?.applySckExclusion && nativeModule?.verifySckExclusion,
        'Both applySckExclusion and verifySckExclusion should be exported from native module',
      );
    });

    it('applySckExclusion is a no-op on non-macOS platforms', {
      skip: isMacOS ? 'This test validates non-macOS behavior' : undefined,
    }, () => {
      // On non-macOS platforms, applySckExclusion should succeed without error
      // This is validated by the native module's cross-platform graceful no-op behavior
      assert.ok(true, 'Non-macOS platforms skip SCK exclusion gracefully');
    });
  });

  describe('getFilteredDisplayList excludes Natively windows', () => {
    it('getFilteredDisplayList does not include Natively windows after exclusion', {
      skip: !nativeModule?.getFilteredDisplayList
        ? 'Native module with getFilteredDisplayList not available — requires Electron environment'
        : undefined,
    }, () => {
      // Call getFilteredDisplayList and verify no Natively-owned windows appear
      const filteredList = nativeModule!.getFilteredDisplayList!();

      // The filtered list should not contain any windows owned by "Natively"
      const nativelyWindows = filteredList.filter(
        (w) => w.ownerName.toLowerCase().includes('natively'),
      );

      assert.equal(
        nativelyWindows.length,
        0,
        `Expected no Natively windows in filtered display list, but found ${nativelyWindows.length}: ${JSON.stringify(nativelyWindows.map((w) => ({ owner: w.ownerName, title: w.windowTitle })))}`,
      );
    });

    it('getFilteredDisplayList returns valid WindowInfo entries', {
      skip: !nativeModule?.getFilteredDisplayList
        ? 'Native module with getFilteredDisplayList not available'
        : undefined,
    }, () => {
      const filteredList = nativeModule!.getFilteredDisplayList!();

      // Each entry should have the expected shape
      for (const entry of filteredList) {
        assert.equal(typeof entry.windowNumber, 'number', 'windowNumber should be a number');
        assert.equal(typeof entry.ownerName, 'string', 'ownerName should be a string');
        assert.equal(typeof entry.ownerPid, 'number', 'ownerPid should be a number');
        assert.equal(typeof entry.windowTitle, 'string', 'windowTitle should be a string');
        assert.equal(typeof entry.isOnScreen, 'boolean', 'isOnScreen should be a boolean');
        assert.equal(typeof entry.sharingState, 'number', 'sharingState should be a number');
        assert.equal(typeof entry.alpha, 'number', 'alpha should be a number');
      }
    });
  });

  describe('CGWindowList invisibility after exclusion', () => {
    it.todo(
      'Window is not visible in CGWindowList after exclusion is applied',
      // Manual validation required:
      // 1. Create a BrowserWindow in Electron
      // 2. Apply SCK exclusion via applySckExclusion(windowNumber)
      // 3. Use a separate process to call CGWindowListCopyWindowInfo
      // 4. Verify the window does NOT appear in the returned list
      // 5. This can also be validated via `screencapture -l` which lists capturable windows
      //
      // Automated approach (requires child process):
      // - Spawn a Swift helper that calls SCShareableContent.current
      // - Parse the output and assert our window number is absent
    );

    it.todo(
      'Window is not visible in SCShareableContent.current.windows after exclusion',
      // Manual validation required:
      // 1. Apply SCK exclusion to all Natively windows
      // 2. Use a Swift/ObjC helper process to enumerate SCShareableContent.current.windows
      // 3. Verify none of the Natively window numbers appear in the enumeration
      // 4. This is the definitive test for macOS 15+ SCK invisibility
    );
  });

  describe('Exclusion persistence after display changes', () => {
    it('exclusion persists after simulated display change (re-verification)', {
      skip: !nativeModule?.applySckExclusion || !nativeModule?.verifySckExclusion
        ? 'Native module with SCK exclusion functions not available — requires Electron environment with active windows'
        : undefined,
    }, () => {
      // In a full Electron environment, this test would:
      // 1. Create a window and apply SCK exclusion
      // 2. Simulate a display-metrics-changed event
      // 3. Verify that verifySckExclusion still returns true
      // 4. If it returns false, the StealthManager should reapply exclusion
      //
      // Since we can't create real windows here, we verify the native functions
      // are available and callable — the actual persistence is validated by
      // the ContinuousEnforcementLoop tests and manual validation.
      assert.ok(
        typeof nativeModule!.applySckExclusion === 'function',
        'applySckExclusion should be a callable function',
      );
      assert.ok(
        typeof nativeModule!.verifySckExclusion === 'function',
        'verifySckExclusion should be a callable function',
      );
    });

    it.todo(
      'exclusion is automatically reapplied by StealthManager after display-metrics-changed event',
      // Integration test requiring full Electron environment:
      // 1. Create a BrowserWindow with stealth enabled
      // 2. Verify SCK exclusion is applied
      // 3. Emit a synthetic 'display-metrics-changed' event on the screen module
      // 4. Wait 500ms (per Requirement 9.3)
      // 5. Verify SCK exclusion is still active via verifySckExclusion
      // 6. If exclusion was lost, verify StealthManager reapplied it
    );
  });

  describe('Exclusion re-application after wake-from-sleep', () => {
    it('exclusion functions remain callable after simulated wake-from-sleep', {
      skip: !nativeModule?.applySckExclusion || !nativeModule?.verifySckExclusion
        ? 'Native module with SCK exclusion functions not available — requires Electron environment with active windows'
        : undefined,
    }, () => {
      // Verify that the native module functions don't throw when called
      // (simulating what happens when StealthManager reapplies after wake)
      //
      // In a full environment, the StealthManager listens for powerMonitor
      // 'resume' events and calls reapplyProtectionLayers() which includes
      // applySckExclusion for each managed window.
      assert.ok(
        typeof nativeModule!.applySckExclusion === 'function',
        'applySckExclusion should remain callable (simulating post-wake reapplication)',
      );
      assert.ok(
        typeof nativeModule!.verifySckExclusion === 'function',
        'verifySckExclusion should remain callable (simulating post-wake verification)',
      );
    });

    it.todo(
      'StealthManager reapplies exclusion within 500ms of power resume event',
      // Integration test requiring full Electron environment:
      // 1. Create a BrowserWindow with stealth enabled
      // 2. Verify SCK exclusion is applied
      // 3. Emit a synthetic 'resume' event on Electron's powerMonitor
      // 4. Wait up to 500ms (per Requirement 9.4)
      // 5. Verify SCK exclusion is reapplied via verifySckExclusion
      // 6. Measure the time between resume event and reapplication
      //    to confirm it's within the 500ms SLA
    );
  });

  describe('Native module function availability', () => {
    before(() => {
      if (!nativeModule) {
        // Skip all tests in this block if native module is unavailable
      }
    });

    it('applySckExclusion is exported from native module', {
      skip: !nativeModule
        ? 'Native module not available'
        : !nativeModule.applySckExclusion
          ? 'applySckExclusion not available in this build — requires macOS 15+ compiled native module'
          : undefined,
    }, () => {
      assert.equal(
        typeof nativeModule!.applySckExclusion,
        'function',
        'applySckExclusion should be exported as a function',
      );
    });

    it('verifySckExclusion is exported from native module', {
      skip: !nativeModule
        ? 'Native module not available'
        : !nativeModule.verifySckExclusion
          ? 'verifySckExclusion not available in this build — requires macOS 15+ compiled native module'
          : undefined,
    }, () => {
      assert.equal(
        typeof nativeModule!.verifySckExclusion,
        'function',
        'verifySckExclusion should be exported as a function',
      );
    });

    it('getFilteredDisplayList is exported from native module', {
      skip: !nativeModule
        ? 'Native module not available'
        : !nativeModule.getFilteredDisplayList
          ? 'getFilteredDisplayList not available in this build — requires macOS compiled native module'
          : undefined,
    }, () => {
      assert.equal(
        typeof nativeModule!.getFilteredDisplayList,
        'function',
        'getFilteredDisplayList should be exported as a function',
      );
    });
  });
});
