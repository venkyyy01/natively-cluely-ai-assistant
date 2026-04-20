import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';

import { DatabaseManager } from '../db/DatabaseManager';

// NAT-018 — DatabaseManager.close() contract.
//
// We deliberately bypass the singleton constructor here because it calls
// `app.getPath('userData')` from electron, which is not available under
// `node --test`. Instead we pin a real better-sqlite3 connection to a
// `DatabaseManager.prototype` instance via Object.assign, then exercise the
// real `close()` method to validate:
//
//   1. close() releases the underlying handle (idempotent on second call).
//   2. close() truncates and removes the WAL/SHM sidecars (acceptance
//      criterion: "no `*.db-wal` / `*.db-shm` files remain after a graceful
//      shutdown").
//   3. The DB file can be re-opened immediately after close() with no error
//      and contains the previously written data — i.e. the checkpoint
//      flushed the WAL into the main DB before the sidecars were deleted.
//   4. closeIfOpen() is a no-op when the singleton hasn't been instantiated.

function makeTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-db-close-'));
  const dbPath = path.join(dir, 'natively.db');
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors so the test result isn't masked
      }
    },
  };
}

function attachManager(dbPath: string): DatabaseManager {
  const realDb = new Database(dbPath);
  realDb.pragma('journal_mode = WAL');
  realDb.pragma('synchronous = NORMAL');
  realDb.exec('CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, v TEXT)');
  realDb.prepare('INSERT INTO smoke (v) VALUES (?)').run('nat-018');

  // Force a WAL write so the *.db-wal file is non-trivially populated and
  // the test asserts on the truncate/delete behavior, not just close().
  const walFile = `${dbPath}-wal`;
  assert.ok(fs.existsSync(walFile), 'precondition: WAL file should exist before close()');

  const manager = Object.create(DatabaseManager.prototype) as DatabaseManager;
  Object.assign(manager, {
    db: realDb,
    dbPath,
    migrationBackupPath: `${dbPath}.backup`,
    resolvedExtPath: '',
    ensuredDims: new Set<number>(),
  });
  return manager;
}

test('DatabaseManager.close() releases the handle and removes WAL/SHM sidecars', () => {
  const { dbPath, cleanup } = makeTmpDb();
  try {
    const manager = attachManager(dbPath);

    manager.close();

    assert.equal(manager.getDb(), null, 'getDb() returns null after close()');
    assert.equal(
      fs.existsSync(`${dbPath}-wal`),
      false,
      'WAL sidecar should be deleted after graceful close',
    );
    assert.equal(
      fs.existsSync(`${dbPath}-shm`),
      false,
      'SHM sidecar should be deleted after graceful close',
    );
    assert.ok(fs.existsSync(dbPath), 'main DB file should still exist');
  } finally {
    cleanup();
  }
});

test('DatabaseManager.close() is idempotent — second call is a safe no-op', () => {
  const { dbPath, cleanup } = makeTmpDb();
  try {
    const manager = attachManager(dbPath);
    manager.close();
    // Second call must not throw, must not double-close the underlying handle.
    assert.doesNotThrow(() => manager.close());
    assert.equal(manager.getDb(), null);
  } finally {
    cleanup();
  }
});

test('DatabaseManager.close() flushes WAL so re-opening the same path succeeds and preserves data', () => {
  const { dbPath, cleanup } = makeTmpDb();
  try {
    const manager = attachManager(dbPath);
    manager.close();

    // Simulate the next launch: open the same path, run a trivial query.
    // The original row must be visible — proving the WAL was checkpointed
    // into the main DB before the sidecars were unlinked.
    const reopened = new Database(dbPath);
    try {
      const rows = reopened.prepare('SELECT v FROM smoke').all() as Array<{ v: string }>;
      assert.deepEqual(rows, [{ v: 'nat-018' }]);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test('DatabaseManager.closeIfOpen() is a no-op when the singleton was never instantiated', () => {
  // Force the singleton slot to be empty regardless of test ordering.
  (DatabaseManager as unknown as { instance?: DatabaseManager }).instance = undefined;
  // Must not call the constructor (which would touch electron's app.getPath).
  assert.doesNotThrow(() => DatabaseManager.closeIfOpen());
  assert.equal(
    (DatabaseManager as unknown as { instance?: DatabaseManager }).instance,
    undefined,
    'closeIfOpen must not lazily create a fresh DB',
  );
});
