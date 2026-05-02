import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
//
// `better-sqlite3` is a native module that is rebuilt against the *Electron*
// ABI by `npm run postinstall`. When we run this file under plain
// `node --test` (e.g. on CI hosts whose Node version or arch doesn't match
// the Electron build), the `require()` will throw with an
// `incompatible architecture` / `was compiled against a different Node.js
// version` error before any test body runs.
//
// In that environment we skip the whole suite cleanly instead of failing the
// developer's verification run for a pure tooling reason. The Electron build
// (`npm run app:test`) — which is the canonical home for this test — uses
// the matching prebuilt and exercises the real path.

type DatabaseModule = typeof import("better-sqlite3");
type DatabaseManagerModule = typeof import("../db/DatabaseManager");

let Database: DatabaseModule | null = null;
let DatabaseManager: DatabaseManagerModule["DatabaseManager"] | null = null;
let nativeLoadError: Error | null = null;

try {
	Database = require("better-sqlite3") as DatabaseModule;
	DatabaseManager = (require("../db/DatabaseManager") as DatabaseManagerModule)
		.DatabaseManager;
	// The JS wrapper loads fine, but `bindings()` only resolves the .node
	// file lazily on the first `new Database(...)` call. Probe with an
	// in-memory DB so an arch / ABI mismatch is caught here, before any
	// test body runs.
	const probe = new Database(":memory:");
	probe.close();
} catch (err) {
	nativeLoadError = err as Error;
}

const skipReason = nativeLoadError
	? `better-sqlite3 native module unavailable in this runtime (${nativeLoadError.message.split("\n")[0]})`
	: null;

function makeTmpDb(): { dbPath: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natively-db-close-"));
	const dbPath = path.join(dir, "natively.db");
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

// `DatabaseManager` has a private constructor, which TS won't expand via
// `InstanceType`. We only need the surface this test exercises (close,
// closeIfOpen, getDb), so we keep the typing minimal and intentional.
interface DatabaseManagerInstance {
	close(): void;
	getDb(): unknown;
}

function attachManager(dbPath: string): DatabaseManagerInstance {
	const RealDatabase = Database!;
	const RealDatabaseManager = DatabaseManager!;
	const realDb = new RealDatabase(dbPath);
	realDb.pragma("journal_mode = WAL");
	realDb.pragma("synchronous = NORMAL");
	realDb.exec(
		"CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, v TEXT)",
	);
	realDb.prepare("INSERT INTO smoke (v) VALUES (?)").run("nat-018");

	// Force a WAL write so the *.db-wal file is non-trivially populated and
	// the test asserts on the truncate/delete behavior, not just close().
	const walFile = `${dbPath}-wal`;
	assert.ok(
		fs.existsSync(walFile),
		"precondition: WAL file should exist before close()",
	);

	const manager = Object.create(
		RealDatabaseManager.prototype,
	) as DatabaseManagerInstance;
	Object.assign(manager, {
		db: realDb,
		dbPath,
		migrationBackupPath: `${dbPath}.backup`,
		resolvedExtPath: "",
		ensuredDims: new Set<number>(),
	});
	return manager;
}

test("DatabaseManager.close() releases the handle and removes WAL/SHM sidecars", {
	skip: skipReason ?? false,
}, () => {
	const { dbPath, cleanup } = makeTmpDb();
	try {
		const manager = attachManager(dbPath);

		manager.close();

		assert.equal(manager.getDb(), null, "getDb() returns null after close()");
		assert.equal(
			fs.existsSync(`${dbPath}-wal`),
			false,
			"WAL sidecar should be deleted after graceful close",
		);
		assert.equal(
			fs.existsSync(`${dbPath}-shm`),
			false,
			"SHM sidecar should be deleted after graceful close",
		);
		assert.ok(fs.existsSync(dbPath), "main DB file should still exist");
	} finally {
		cleanup();
	}
});

test("DatabaseManager.close() is idempotent — second call is a safe no-op", {
	skip: skipReason ?? false,
}, () => {
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

test("DatabaseManager.close() flushes WAL so re-opening the same path succeeds and preserves data", {
	skip: skipReason ?? false,
}, () => {
	const { dbPath, cleanup } = makeTmpDb();
	try {
		const manager = attachManager(dbPath);
		manager.close();

		// Simulate the next launch: open the same path, run a trivial query.
		// The original row must be visible — proving the WAL was checkpointed
		// into the main DB before the sidecars were unlinked.
		const RealDatabase = Database!;
		const reopened = new RealDatabase(dbPath);
		try {
			const rows = reopened.prepare("SELECT v FROM smoke").all() as Array<{
				v: string;
			}>;
			assert.deepEqual(rows, [{ v: "nat-018" }]);
		} finally {
			reopened.close();
		}
	} finally {
		cleanup();
	}
});

test("DatabaseManager.closeIfOpen() is a no-op when the singleton was never instantiated", {
	skip: skipReason ?? false,
}, () => {
	const RealDatabaseManager = DatabaseManager!;
	// Force the singleton slot to be empty regardless of test ordering.
	(
		RealDatabaseManager as unknown as { instance?: DatabaseManagerInstance }
	).instance = undefined;
	// Must not call the constructor (which would touch electron's app.getPath).
	assert.doesNotThrow(() => RealDatabaseManager.closeIfOpen());
	assert.equal(
		(RealDatabaseManager as unknown as { instance?: DatabaseManagerInstance })
			.instance,
		undefined,
		"closeIfOpen must not lazily create a fresh DB",
	);
});
