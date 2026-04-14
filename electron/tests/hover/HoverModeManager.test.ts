import * as assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HoverModeManager } from '../../hover/HoverModeManager';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

class MockScreen {
  private displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }> = [
    { id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];

  getDisplayNearestPoint(point: { x: number; y: number }) {
    return {
      id: 0,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      bounds: this.displays[0].bounds,
    };
  }
}

describe('HoverModeManager', () => {
  let manager: HoverModeManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `hover-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    manager = new HoverModeManager({ hoverDebounceMs: 100 });
  });

  afterEach(() => {
    manager.cleanup();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should initialize with disabled state', () => {
    assert.strictEqual(manager.isEnabled(), false);
  });

  it('should emit enabled-changed event when toggled', () => {
    let eventFired = false;
    let enabledValue = false;

    manager.on('enabled-changed', (enabled: boolean) => {
      eventFired = true;
      enabledValue = enabled;
    });

    manager.setEnabled(true);
    assert.strictEqual(eventFired, true);
    assert.strictEqual(enabledValue, true);
    assert.strictEqual(manager.isEnabled(), true);
  });

  it('should not emit event if state unchanged', () => {
    let eventCount = 0;

    manager.on('enabled-changed', () => {
      eventCount++;
    });

    manager.setEnabled(false);
    assert.strictEqual(eventCount, 0);
  });

  it('should handle position updates when enabled', async () => {
    manager.setEnabled(true);

    const capturePromise = new Promise<void>((resolve) => {
      manager.on('capture', () => {
        resolve();
      });
    });

    manager.updateMousePosition(100, 100, 0);

    setTimeout(() => {
      manager.updateMousePosition(150, 150, 0);
    }, 150);

    await capturePromise;
  });

  it('should ignore position updates when disabled', () => {
    let captureCount = 0;

    manager.on('capture', () => {
      captureCount++;
    });

    manager.updateMousePosition(100, 100, 0);
    manager.updateMousePosition(200, 200, 0);

    assert.strictEqual(captureCount, 0);
  });

  it('should cancel pending capture when disabled', () => {
    manager.setEnabled(true);

    let captureCount = 0;
    manager.on('capture', () => {
      captureCount++;
    });

    manager.updateMousePosition(100, 100, 0);
    manager.setEnabled(false);

    assert.strictEqual(captureCount, 0);
  });

  it('should calculate capture bounds centered on cursor', () => {
    const bounds = (manager as any).calculateCaptureBounds({ x: 960, y: 540, screenId: 0 });

    assert.ok(bounds.width >= 200);
    assert.ok(bounds.height >= 150);
    assert.ok(bounds.x < 960);
    assert.ok(bounds.y < 540);
  });

  it('should clamp capture bounds to screen edges', () => {
    const bounds = (manager as any).calculateCaptureBounds({ x: 10, y: 10, screenId: 0 });

    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 0);
  });

  it('should expand capture zone by configured factor', () => {
    const managerWithConfig = new HoverModeManager({ captureExpansionFactor: 5 });
    const bounds = (managerWithConfig as any).calculateCaptureBounds({ x: 960, y: 540, screenId: 0 });

    const expectedMinWidth = 200 * 5;
    const expectedMinHeight = 150 * 5;

    assert.ok(bounds.width >= expectedMinWidth);
    assert.ok(bounds.height >= expectedMinHeight);

    managerWithConfig.cleanup();
  });
});
