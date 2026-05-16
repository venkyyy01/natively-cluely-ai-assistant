/**
 * Unit tests for ScreenRAG sandbox (NAT-700).
 *
 * Validates:
 * - Requirement 7.1: tmpDir is created under os.tmpdir() (not userData)
 * - Requirement 7.5: ENOENT/EPERM handling on unlink (no throw)
 * - Requirement 7.3: File cleanup on dispose
 * - Requirement 7.4: before-quit handler performs synchronous cleanup
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

// --- Electron app mock ---

class MockApp extends EventEmitter {
  getPath(name: string): string {
    return `/mock/userData/${name}`;
  }
}

let mockApp: MockApp;

function installElectronMock(): () => void {
  mockApp = new MockApp();
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return { app: mockApp };
    }
    // Block screenshot-desktop and tesseract.js from loading (not needed for unit tests)
    if (request === 'screenshot-desktop') {
      return () => Promise.reject(new Error('mock: screenshot not available'));
    }
    if (request === 'tesseract.js') {
      return { recognize: () => Promise.resolve({ data: { text: '' } }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

// --- Helpers ---

function requireFresh(): typeof import('../rag/ScreenRAGManager') {
  // Clear module cache to get a fresh instance with our mocks
  const modulePath = require.resolve('../rag/ScreenRAGManager');
  delete require.cache[modulePath];
  return require('../rag/ScreenRAGManager');
}

describe('ScreenRAGSandbox', () => {
  let restoreElectron: () => void;
  let manager: InstanceType<(typeof import('../rag/ScreenRAGManager'))['ScreenRAGManager']> | null = null;

  beforeEach(() => {
    restoreElectron = installElectronMock();
  });

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = null;
    }
    restoreElectron();
  });

  describe('tmpdir usage (Requirement 7.1)', () => {
    it('creates tmpDir under os.tmpdir(), not userData', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const systemTmpDir = os.tmpdir();

      // tmpDir must be under os.tmpdir()
      assert.ok(
        tmpDir.startsWith(systemTmpDir),
        `Expected tmpDir "${tmpDir}" to start with os.tmpdir() "${systemTmpDir}"`
      );

      // tmpDir must NOT be under userData
      assert.ok(
        !tmpDir.includes('/mock/userData'),
        `Expected tmpDir "${tmpDir}" to NOT contain userData path`
      );
    });

    it('tmpDir contains the natively-srag prefix', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const dirName = path.basename(tmpDir);

      assert.ok(
        dirName.startsWith('natively-srag-'),
        `Expected tmpDir basename "${dirName}" to start with "natively-srag-"`
      );
    });

    it('tmpDir is actually created on disk', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      assert.ok(fs.existsSync(tmpDir), `Expected tmpDir "${tmpDir}" to exist on disk`);
    });

    it('each instance gets a unique tmpDir (random prefix)', () => {
      const { ScreenRAGManager } = requireFresh();
      const m1 = new ScreenRAGManager();
      const m2 = new ScreenRAGManager();

      const dir1 = (m1 as any).tmpDir as string;
      const dir2 = (m2 as any).tmpDir as string;

      assert.notEqual(dir1, dir2, 'Each instance should have a unique tmpDir');

      // Cleanup both
      m1.dispose();
      m2.dispose();
      manager = null; // prevent double-dispose in afterEach
    });
  });

  describe('file cleanup on dispose (Requirement 7.3)', () => {
    it('dispose() removes all tracked files', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;

      // Simulate files being tracked
      const file1 = path.join(tmpDir, 'test1.png');
      const file2 = path.join(tmpDir, 'test2.png');
      fs.writeFileSync(file1, 'data1');
      fs.writeFileSync(file2, 'data2');

      // Add to allFiles tracking (simulating what poll() does)
      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(file1);
      allFiles.add(file2);

      assert.ok(fs.existsSync(file1));
      assert.ok(fs.existsSync(file2));

      await manager.dispose();
      manager = null;

      assert.ok(!fs.existsSync(file1), 'file1 should be deleted after dispose');
      assert.ok(!fs.existsSync(file2), 'file2 should be deleted after dispose');
    });

    it('dispose() removes the tmpDir itself', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      assert.ok(fs.existsSync(tmpDir));

      await manager.dispose();
      manager = null;

      assert.ok(!fs.existsSync(tmpDir), 'tmpDir should be removed after dispose');
    });

    it('dispose() is idempotent — second call is a no-op', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      await manager.dispose();
      // Second dispose should not throw
      await manager.dispose();
      manager = null;
    });

    it('dispose() does not unlink files still in activeFiles set (waits for them)', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const file1 = path.join(tmpDir, 'active.png');
      fs.writeFileSync(file1, 'active-data');

      const allFiles = (manager as any).allFiles as Set<string>;
      const activeFiles = (manager as any).activeFiles as Set<string>;
      allFiles.add(file1);
      activeFiles.add(file1);

      // Start dispose — it will wait for activeFiles to clear
      const disposePromise = manager.dispose();

      // Simulate the active file completing after a short delay
      setTimeout(() => {
        activeFiles.delete(file1);
      }, 100);

      await disposePromise;
      manager = null;

      // File should be cleaned up after active write completed
      assert.ok(!fs.existsSync(file1), 'file should be deleted after active write completes');
    });
  });

  describe('ENOENT handling on unlink (Requirement 7.5)', () => {
    it('safeUnlink handles ENOENT silently (file already deleted)', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const nonExistentFile = path.join(tmpDir, 'does-not-exist.png');

      // Add to allFiles to simulate tracking
      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(nonExistentFile);

      // safeUnlink should not throw for ENOENT
      await assert.doesNotReject(
        async () => (manager as any).safeUnlink(nonExistentFile),
        'safeUnlink should not throw on ENOENT'
      );

      // File should be removed from tracking
      assert.ok(!allFiles.has(nonExistentFile), 'File should be removed from allFiles after ENOENT');
    });

    it('dispose() handles ENOENT gracefully when tracked files are already gone', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const ghostFile = path.join(tmpDir, 'ghost.png');

      // Track a file that doesn't exist on disk
      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(ghostFile);

      // dispose should not throw
      await assert.doesNotReject(
        async () => manager!.dispose(),
        'dispose should not throw when tracked files are already deleted'
      );
      manager = null;
    });
  });

  describe('EPERM handling on unlink (Requirement 7.5)', () => {
    it('safeUnlink logs warning on EPERM but does not throw', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;

      // Create a directory (unlinking a directory gives EPERM on some systems)
      // Instead, we'll mock fs.promises.unlink to simulate EPERM
      const originalUnlink = fs.promises.unlink;
      const permFile = path.join(tmpDir, 'perm-denied.png');

      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(permFile);

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };

      // Temporarily override unlink to simulate EPERM
      fs.promises.unlink = async (filePath: fs.PathLike) => {
        if (filePath === permFile) {
          const err = new Error('EPERM') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return originalUnlink(filePath);
      };

      try {
        await assert.doesNotReject(
          async () => (manager as any).safeUnlink(permFile),
          'safeUnlink should not throw on EPERM'
        );

        // Should have logged a warning
        assert.ok(
          warnings.some((w) => w.includes('EPERM')),
          'Expected a warning about EPERM to be logged'
        );

        // File should be removed from tracking
        assert.ok(!allFiles.has(permFile), 'File should be removed from allFiles after EPERM');
      } finally {
        console.warn = originalWarn;
        fs.promises.unlink = originalUnlink;
      }
    });
  });

  describe('before-quit handler (Requirement 7.4)', () => {
    it('registers a before-quit handler on the app', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      // Check that the mock app has a listener for 'before-quit'
      const listeners = mockApp.listeners('before-quit');
      assert.ok(listeners.length > 0, 'Expected at least one before-quit listener');
    });

    it('before-quit handler performs synchronous cleanup of tracked files', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;

      // Create files and track them
      const file1 = path.join(tmpDir, 'quit1.png');
      const file2 = path.join(tmpDir, 'quit2.png');
      fs.writeFileSync(file1, 'quit-data-1');
      fs.writeFileSync(file2, 'quit-data-2');

      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(file1);
      allFiles.add(file2);

      assert.ok(fs.existsSync(file1));
      assert.ok(fs.existsSync(file2));

      // Emit before-quit to trigger synchronous cleanup
      mockApp.emit('before-quit');

      assert.ok(!fs.existsSync(file1), 'file1 should be deleted on before-quit');
      assert.ok(!fs.existsSync(file2), 'file2 should be deleted on before-quit');
    });

    it('before-quit handler handles ENOENT silently during sync cleanup', () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const tmpDir = (manager as any).tmpDir as string;
      const ghostFile = path.join(tmpDir, 'ghost-quit.png');

      const allFiles = (manager as any).allFiles as Set<string>;
      allFiles.add(ghostFile);

      // Should not throw even though file doesn't exist
      assert.doesNotThrow(
        () => mockApp.emit('before-quit'),
        'before-quit handler should not throw on ENOENT'
      );
    });

    it('dispose() unregisters the before-quit handler', async () => {
      const { ScreenRAGManager } = requireFresh();
      manager = new ScreenRAGManager();

      const listenersBefore = mockApp.listeners('before-quit').length;
      assert.ok(listenersBefore > 0);

      await manager.dispose();
      manager = null;

      const listenersAfter = mockApp.listeners('before-quit').length;
      assert.ok(
        listenersAfter < listenersBefore,
        'before-quit listener should be removed after dispose'
      );
    });
  });
});
