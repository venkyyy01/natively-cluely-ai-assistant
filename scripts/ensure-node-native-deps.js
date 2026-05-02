const { execSync } = require("node:child_process");

function canOpenBetterSqlite3() {
	try {
		const Database = require("better-sqlite3");
		const db = new Database(":memory:");
		db.prepare("SELECT 1").get();
		db.close();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[ensure-node-native-deps] better-sqlite3 is not usable in Node ${process.version} (ABI ${process.versions.modules}): ${message}`,
		);
		return false;
	}
}

if (!canOpenBetterSqlite3()) {
	console.log(
		"[ensure-node-native-deps] Rebuilding better-sqlite3 for the Node test runtime...",
	);
	execSync("npm rebuild better-sqlite3", { stdio: "inherit" });

	if (!canOpenBetterSqlite3()) {
		console.error(
			"[ensure-node-native-deps] ERROR: better-sqlite3 still cannot open after rebuild.",
		);
		process.exit(1);
	}
}

console.log(
	`[ensure-node-native-deps] better-sqlite3 verified for Node ${process.version} (ABI ${process.versions.modules}).`,
);
