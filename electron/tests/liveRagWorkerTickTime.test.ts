import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Worker } from 'worker_threads';

/**
 * NAT-053: chunk inserts run in `liveRagIndexerWorker` (worker_threads), not on the main thread.
 * Skips when better-sqlite3 native bindings are missing or wrong architecture (e.g. CI vs local).
 */
test('NAT-053: liveRagIndexerWorker inserts rows and returns chunk ids', async (t) => {
  // Dynamic import so wrong-arch native builds skip cleanly instead of failing module load at file scope.
  let Database: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): { all(): unknown[] };
  };
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    t.skip('better-sqlite3 module not loadable');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rag-worker-'));
  const dbPath = path.join(dir, 'test.db');
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip(`better-sqlite3 native open failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      speaker TEXT,
      start_timestamp_ms INTEGER,
      end_timestamp_ms INTEGER,
      cleaned_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      embedding BLOB
    );
  `);
  db.close();

  const workerPath = path.join(__dirname, '../rag/liveRagIndexerWorker.js');
  const chunkIds: number[] = await new Promise((resolve, reject) => {
    const w = new Worker(workerPath);
    w.once('message', (msg: { ok: true; chunkIds: number[] } | { ok: false; error: string }) => {
      void w.terminate().catch(() => {});
      if (msg.ok && 'chunkIds' in msg) {
        resolve(msg.chunkIds);
      } else {
        reject(new Error('error' in msg ? msg.error : 'worker failed'));
      }
    });
    w.once('error', (err) => {
      void w.terminate().catch(() => {});
      reject(err);
    });
    w.postMessage({
      type: 'saveChunks',
      dbPath,
      chunks: [
        {
          meetingId: 'm1',
          chunkIndex: 0,
          speaker: 'user',
          startMs: 0,
          endMs: 100,
          text: 'hello',
          tokenCount: 1,
        },
        {
          meetingId: 'm1',
          chunkIndex: 1,
          speaker: 'user',
          startMs: 100,
          endMs: 200,
          text: 'world',
          tokenCount: 1,
        },
      ],
    });
  });

  assert.equal(chunkIds.length, 2);
  assert.ok(chunkIds[0] !== undefined && chunkIds[1] !== undefined);

  const verify = new Database(dbPath);
  const rows = verify.prepare('SELECT id, meeting_id, chunk_index, cleaned_text FROM chunks ORDER BY id').all() as Array<{
    id: number;
    meeting_id: string;
    chunk_index: number;
    cleaned_text: string;
  }>;
  verify.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.cleaned_text, 'hello');
  assert.equal(rows[1]?.cleaned_text, 'world');
});
