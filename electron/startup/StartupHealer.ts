import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * NAT-SELF-HEAL: Startup resilience layer.
 * Detects and repairs common startup failure modes:
 *   1. Stale Electron GPU/Code caches from crashes
 *   2. Zombie Natively processes holding ports/files
 *   3. ONNX/CoreML corruption from previous segfaults
 *   4. Renderer bridge that never settles
 */

const HEALTH_MARKER_FILE = "last_session_healthy";
const CRASH_COUNT_FILE = "startup_crash_count.json";
const ONNX_FAILURE_FILE = "onnx_failure_count.json";
const MAX_CACHE_CLEAR_CRASH_THRESHOLD = 2;
const MAX_ONNX_FAILURES_BEFORE_DISABLE = 3;

export type StartupHealth = {
	clearedCaches: boolean;
	killedZombies: boolean;
	onnxDisabled: boolean;
	crashCount: number;
};

function getUserDataPath(): string {
	return app.getPath("userData");
}

function getHealthMarkerPath(): string {
	return path.join(getUserDataPath(), HEALTH_MARKER_FILE);
}

function getCrashCountPath(): string {
	return path.join(getUserDataPath(), CRASH_COUNT_FILE);
}

function getOnnxFailurePath(): string {
	return path.join(getUserDataPath(), ONNX_FAILURE_FILE);
}

function readCrashCount(): number {
	try {
		const data = JSON.parse(fs.readFileSync(getCrashCountPath(), "utf-8"));
		return typeof data.count === "number" ? data.count : 0;
	} catch {
		return 0;
	}
}

function writeCrashCount(count: number): void {
	try {
		fs.writeFileSync(
			getCrashCountPath(),
			JSON.stringify({ count, last: Date.now() }),
		);
	} catch {
		// Best effort
	}
}

function readOnnxFailureCount(): number {
	try {
		const data = JSON.parse(fs.readFileSync(getOnnxFailurePath(), "utf-8"));
		return typeof data.count === "number" ? data.count : 0;
	} catch {
		return 0;
	}
}

export function writeOnnxFailureCount(count: number): void {
	try {
		fs.writeFileSync(
			getOnnxFailurePath(),
			JSON.stringify({ count, last: Date.now() }),
		);
	} catch {
		// Best effort
	}
}

export function incrementOnnxFailureCount(): number {
	const count = readOnnxFailureCount() + 1;
	writeOnnxFailureCount(count);
	return count;
}

export function resetOnnxFailureCount(): void {
	writeOnnxFailureCount(0);
}

export function shouldDisableOnnx(): boolean {
	return readOnnxFailureCount() >= MAX_ONNX_FAILURES_BEFORE_DISABLE;
}

/**
 * Clear Electron caches known to cause black-screen / renderer compositor issues.
 */
function clearElectronCaches(): boolean {
	const userData = getUserDataPath();
	const targets = [
		"GPUCache",
		"Code Cache",
		"DawnGraphiteCache",
		"DawnWebGPUCache",
		"blob_storage",
	];
	let clearedAny = false;
	for (const target of targets) {
		const targetPath = path.join(userData, target);
		try {
			if (fs.existsSync(targetPath)) {
				fs.rmSync(targetPath, { recursive: true, force: true });
				console.log(`[StartupHealer] Cleared stale cache: ${target}`);
				clearedAny = true;
			}
		} catch (err) {
			console.warn(`[StartupHealer] Failed to clear ${target}:`, err);
		}
	}
	return clearedAny;
}

/**
 * Kill any zombie Natively processes that aren't our own PID.
 */
function killZombieProcesses(): boolean {
	const myPid = process.pid;
	let killed = false;
	try {
		const stdout = execSync(
			'pgrep -f "Natively.app/Contents/MacOS/Natively" || true',
			{
				encoding: "utf-8",
				timeout: 3000,
			},
		);
		const pids = stdout
			.split("\n")
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n) && n !== myPid);
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM");
				console.log(
					`[StartupHealer] Sent SIGTERM to zombie Natively pid=${pid}`,
				);
				killed = true;
			} catch {
				// Already gone or permission denied
			}
		}
	} catch {
		// pgrep not available or no matches
	}
	return killed;
}

/**
 * Called BEFORE app.whenReady() — performs any synchronous cleanup.
 */
export function runPreReadyHealing(): StartupHealth {
	const crashCount = readCrashCount();
	const shouldClearCaches = crashCount >= MAX_CACHE_CLEAR_CRASH_THRESHOLD;
	const clearedCaches = shouldClearCaches ? clearElectronCaches() : false;
	const killedZombies = killZombieProcesses();

	if (shouldDisableOnnx()) {
		console.warn(
			`[StartupHealer] ONNX/CoreML has crashed ${readOnnxFailureCount()} times. Disabling ANE embeddings for this session.`,
		);
		// Patch the feature flag in-memory so downstream code sees it off
		const envKey = "NATIVELY_DISABLE_ANE_EMBEDDINGS";
		if (!process.env[envKey]) {
			process.env[envKey] = "1";
		}
	}

	return {
		clearedCaches,
		killedZombies,
		onnxDisabled: shouldDisableOnnx(),
		crashCount,
	};
}

/**
 * Called AFTER the main window is created and renderer bridge settles.
 * Marks the session as healthy so the next startup doesn't clear caches.
 */
export function markSessionHealthy(): void {
	try {
		fs.writeFileSync(getHealthMarkerPath(), Date.now().toString());
		writeCrashCount(0);
	} catch {
		// Best effort
	}
}

/**
 * Called on graceful quit. Removes the health marker so crashes are detectable.
 */
export function markSessionEnding(): void {
	try {
		fs.unlinkSync(getHealthMarkerPath());
	} catch {
		// Best effort
	}
}

/**
 * Detect if the previous session exited uncleanly (no health marker).
 */
export function wasPreviousSessionUnclean(): boolean {
	try {
		// If the marker exists, the previous session called markSessionHealthy
		// If not, it either crashed or is first launch
		fs.accessSync(getHealthMarkerPath());
		return false;
	} catch {
		return true;
	}
}

/**
 * Bump the crash counter. Call this when you detect a startup failure
 * (e.g., renderer bridge never settles, window stays black).
 */
export function recordStartupFailure(): void {
	const count = readCrashCount() + 1;
	writeCrashCount(count);
	console.warn(
		`[StartupHealer] Recorded startup failure. Crash count = ${count}`,
	);
}
