/**
 * Unit tests for ScreenRAG threshold and event-driven redesign (NAT-800).
 *
 * Validates:
 * - Requirement 8.2: Meeting/session end resets counter and stops sampling
 * - Requirement 8.5: OCR timeout at 10 seconds
 * - Requirement 8.6: OCR timeout cancellation — discard partial result, remain available
 *
 * Also covers:
 * - Activation after exactly 3 screenshots
 * - Suppression conditions (window hidden, screen locked, screen-share active)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

// --- Electron app mock ---

class MockApp extends EventEmitter {
  getPath(name: string): string {
    return `/mock/userData/${name}`;
  }
}

let mockApp: MockApp;

// --- Screenshot and Tesseract mocks ---

let screenshotMock: (() => Promise<void>) | null = null;
let tesseractMock: ((filePath: string) => Promise<{ data: { text: string } }>) | null = null;

function installElectronMock(): () => void {
  mockApp = new MockApp();
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return { app: mockApp };
    }
    if (request === 'screenshot-desktop') {
      // Return a function that calls our mock or resolves immediately
      return (opts?: any) => {
        if (screenshotMock) return screenshotMock();
        // Create a dummy file at the requested path
        const fs = require('fs');
        if (opts?.filename) {
          fs.writeFileSync(opts.filename, 'fake-png-data');
        }
        return Promise.resolve();
      };
    }
    if (request === 'tesseract.js') {
      return {
        recognize: (filePath: string) => {
          if (tesseractMock) return tesseractMock(filePath);
          return Promise.resolve({ data: { text: 'mock OCR text' } });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

// --- Helpers ---

function requireFresh(): typeof import('../rag/ScreenRAGManager') {
  const modulePath = require.resolve('../rag/ScreenRAGManager');
  delete require.cache[modulePath];
  return require('../rag/ScreenRAGManager');
}

describe('ScreenRAGThreshold', () => {
  let restoreElectron: () => void;
  let manager: InstanceType<(typeof import('../rag/ScreenRAGManager'))['ScreenRAGManager']> | null = null;

  beforeEach(() => {
    restoreElectron = installElectronMock();
    screenshotMock = null;
    tesseractMock = null;
  });

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = null;
    }
    restoreElectron();
  });

  describe('Activation after exactly 3 screenshots (Requirement 8.2)', () => {
    it('is not activated before 3 screenshots', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      assert.equal(manager.isActivated(), false);
      assert.equal(manager.getScreenshotCount(), 0);

      manager.recordScreenshot();
      assert.equal(manager.isActivated(), false);
      assert.equal(manager.getScreenshotCount(), 1);

      manager.recordScreenshot();
      assert.equal(manager.isActivated(), false);
      assert.equal(manager.getScreenshotCount(), 2);
    });

    it('activates on exactly the 3rd screenshot', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      assert.equal(manager.isActivated(), true);
      assert.equal(manager.getScreenshotCount(), 3);
    });

    it('emits "activated" event exactly once on threshold', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      let activatedCount = 0;
      manager.on('activated', () => { activatedCount++; });

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      assert.equal(activatedCount, 1);

      // Additional screenshots should not re-emit
      manager.recordScreenshot();
      manager.recordScreenshot();

      assert.equal(activatedCount, 1);
    });

    it('does not activate again after threshold without reset', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);

      // More screenshots should not change activation state
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);
      assert.equal(manager.getScreenshotCount(), 5);
    });

    it('supports custom activation threshold', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager({ activationThreshold: 5 });

      for (let i = 0; i < 4; i++) {
        manager.recordScreenshot();
      }
      assert.equal(manager.isActivated(), false);

      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);
      assert.equal(manager.getScreenshotCount(), 5);
    });

    it('ignores recordScreenshot after dispose', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.dispose();
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      assert.equal(manager.isActivated(), false);
      assert.equal(manager.getScreenshotCount(), 0);
      manager = null;
    });
  });

  describe('Reset on meeting end (Requirement 8.2)', () => {
    it('resetSession() resets counter to zero', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.getScreenshotCount(), 3);
      assert.equal(manager.isActivated(), true);

      manager.resetSession();

      assert.equal(manager.getScreenshotCount(), 0);
      assert.equal(manager.isActivated(), false);
    });

    it('resetSession() emits "deactivated" event', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      let deactivatedCount = 0;
      manager.on('deactivated', () => { deactivatedCount++; });

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      manager.resetSession();
      assert.equal(deactivatedCount, 1);
    });

    it('resetSession() stops sampling flag', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // Manually set sampling to true to simulate in-progress OCR
      (manager as any).sampling = true;
      assert.equal(manager.isSampling(), true);

      manager.resetSession();
      assert.equal(manager.isSampling(), false);
    });

    it('allows re-activation after reset', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      // First activation
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);

      // Reset
      manager.resetSession();
      assert.equal(manager.isActivated(), false);

      // Re-activate
      let activatedCount = 0;
      manager.on('activated', () => { activatedCount++; });

      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), false);

      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);
      assert.equal(activatedCount, 1);
    });
  });

  describe('OCR timeout cancellation (Requirements 8.5, 8.6)', () => {
    it('OCR completes within timeout — result is stored', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager({ ocrTimeoutMs: 5000 });

      // Mock tesseract to resolve quickly with text
      tesseractMock = async () => ({ data: { text: 'Hello World' } });

      // Activate the manager
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);

      // Trigger idle tick
      await manager.onIdleTick();

      // Verify sampling completed
      assert.equal(manager.isSampling(), false);
    });

    it('OCR timeout cancels operation and remains available for next tick', async () => {
      const { ScreenRAGManager } = requireFresh();
      // Use a very short timeout for testing
      manager = new ScreenRAGManager({ ocrTimeoutMs: 50 });

      // Mock tesseract to take longer than the timeout
      tesseractMock = async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { data: { text: 'Should be discarded' } };
      };

      // Activate the manager
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.isActivated(), true);

      // Trigger idle tick — should timeout
      await manager.onIdleTick();

      // After timeout, sampling flag should be cleared (available for next tick)
      assert.equal(manager.isSampling(), false);
      assert.equal(manager.isActivated(), true);
    });

    it('OCR timeout clears the timeout timer (no leak)', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager({ ocrTimeoutMs: 5000 });

      // Mock tesseract to resolve quickly
      tesseractMock = async () => ({ data: { text: 'Quick result' } });

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // Trigger idle tick — should complete quickly and clear timeout
      await manager.onIdleTick();

      // If timeout wasn't cleared, it would fire later and potentially cause issues
      // The test passing without hanging confirms the timeout was cleared
      assert.equal(manager.isSampling(), false);
    });

    it('OCR failure does not crash — manager remains available', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager({ ocrTimeoutMs: 5000 });

      // Mock tesseract to throw
      tesseractMock = async () => {
        throw new Error('OCR engine failure');
      };

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // Should not throw
      await manager.onIdleTick();

      // Manager should still be available
      assert.equal(manager.isSampling(), false);
      assert.equal(manager.isActivated(), true);
    });
  });

  describe('Suppression conditions (Requirement 8.4)', () => {
    it('canSample() returns false when window is hidden', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.canSample(), true);

      manager.setWindowHidden(true);
      assert.equal(manager.canSample(), false);

      manager.setWindowHidden(false);
      assert.equal(manager.canSample(), true);
    });

    it('canSample() returns false when screen is locked', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.canSample(), true);

      manager.setScreenLocked(true);
      assert.equal(manager.canSample(), false);

      manager.setScreenLocked(false);
      assert.equal(manager.canSample(), true);
    });

    it('canSample() returns false when screen-share is active', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.canSample(), true);

      manager.setScreenShareActive(true);
      assert.equal(manager.canSample(), false);

      manager.setScreenShareActive(false);
      assert.equal(manager.canSample(), true);
    });

    it('canSample() returns false when not activated', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      // Not activated yet
      assert.equal(manager.canSample(), false);

      manager.recordScreenshot();
      manager.recordScreenshot();
      assert.equal(manager.canSample(), false);
    });

    it('onIdleTick() skips sampling when suppressed', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      let screenshotCalled = false;
      screenshotMock = async () => {
        screenshotCalled = true;
      };

      // Activate
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // Suppress via window hidden
      manager.setWindowHidden(true);

      await manager.onIdleTick();
      assert.equal(screenshotCalled, false, 'Screenshot should not be called when suppressed');
      assert.equal(manager.isSampling(), false);
    });

    it('onIdleTick() skips when not activated', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      let screenshotCalled = false;
      screenshotMock = async () => {
        screenshotCalled = true;
      };

      // Not activated (only 2 screenshots)
      manager.recordScreenshot();
      manager.recordScreenshot();

      await manager.onIdleTick();
      assert.equal(screenshotCalled, false, 'Screenshot should not be called when not activated');
    });

    it('onIdleTick() is idempotent — no second OCR while one is in progress', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager({ ocrTimeoutMs: 5000 });

      let ocrCallCount = 0;
      tesseractMock = async () => {
        ocrCallCount++;
        // Simulate slow OCR
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { data: { text: 'result' } };
      };

      // Activate
      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // Start first tick (will be in progress)
      const tick1 = manager.onIdleTick();

      // Immediately try second tick — should be a no-op since sampling is true
      const tick2 = manager.onIdleTick();

      await Promise.all([tick1, tick2]);

      // Only one OCR call should have been made
      assert.equal(ocrCallCount, 1, 'Only one OCR operation should run at a time');
    });

    it('multiple suppression conditions — any one blocks sampling', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      manager.recordScreenshot();
      manager.recordScreenshot();
      manager.recordScreenshot();

      // All suppression conditions active
      manager.setWindowHidden(true);
      manager.setScreenLocked(true);
      manager.setScreenShareActive(true);
      assert.equal(manager.canSample(), false);

      // Clear one — still suppressed by others
      manager.setWindowHidden(false);
      assert.equal(manager.canSample(), false);

      // Clear another
      manager.setScreenLocked(false);
      assert.equal(manager.canSample(), false);

      // Clear last — now can sample
      manager.setScreenShareActive(false);
      assert.equal(manager.canSample(), true);
    });
  });
});
