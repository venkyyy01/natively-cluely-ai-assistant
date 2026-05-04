const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const arch = os.arch();
const platform = os.platform();

// Each binary's name, output path, module directory, and rebuild strategy.
// `prebuiltOnly` modules rely on prebuild-install (better-sqlite3 has
// Electron-targeted prebuilts on npm). Everything else compiles from source
// via node-gyp with Electron headers.
const binaries = [
	{
		name: "better-sqlite3",
		path: path.join(rootDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
		moduleDir: path.join(rootDir, "node_modules", "better-sqlite3"),
		prebuiltOnly: true,
		skipModuleVersionCheck: true,
	},
	{
		name: "sqlite3",
		path: path.join(rootDir, "node_modules", "sqlite3", "build", "Release", "node_sqlite3.node"),
		moduleDir: path.join(rootDir, "node_modules", "sqlite3"),
		skipModuleVersionCheck: true,
	},
	{
		name: "keytar",
		path: path.join(rootDir, "node_modules", "keytar", "build", "Release", "keytar.node"),
		moduleDir: path.join(rootDir, "node_modules", "keytar"),
		skipModuleVersionCheck: true,
	},
	{
		name: "sharp",
		path: path.join(rootDir, "node_modules", "sharp", "build", "Release", `sharp-${platform}-${arch}v8.node`),
		moduleDir: path.join(rootDir, "node_modules", "sharp"),
		optional: true,
	},
];

function run(command) {
	console.log(`[ensure-electron-native-deps] > ${command}`);
	execSync(command, { cwd: rootDir, stdio: "inherit" });
}

function getBinaryInfo(binaryPath) {
	try {
		return execSync(`file "${binaryPath}"`, { cwd: rootDir, encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function matchesCurrentArch(info) {
	if (!info) return false;
	if (arch === "arm64") return info.includes("arm64");
	if (arch === "x64") return info.includes("x86_64");
	return true;
}

// ── NODE_MODULE_VERSION ───────────────────────────────────────────────

function getCompiledModuleVersion(binaryPath) {
	try {
		require(binaryPath);
		return parseInt(process.versions.modules, 10);
	} catch (e) {
		const match = (e.message || "").match(/NODE_MODULE_VERSION (\d+)\./);
		return match ? parseInt(match[1], 10) : null;
	}
}

function getElectronModuleVersion() {
	const electronPkgPath = path.join(rootDir, "node_modules", "electron", "package.json");
	if (!fs.existsSync(electronPkgPath)) {
		console.log("[ensure-electron-native-deps] Electron not installed; skipping MODULE_VERSION check.");
		return null;
	}
	const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, "utf8")).version;
	const home = os.homedir();

	// Check node-gyp headers cache first (populated by electron-builder install-app-deps).
	const cacheDirs = platform === "darwin"
		? [path.join(home, "Library", "Caches", "node-gyp", electronVersion)]
		: [path.join(home, ".cache", "node-gyp", electronVersion)];

	for (const cacheDir of cacheDirs) {
		if (!fs.existsSync(cacheDir)) continue;
		const findHeader = (dir, depth) => {
			if (depth > 5) return null;
			try {
				for (const entry of fs.readdirSync(dir)) {
					const full = path.join(dir, entry);
					if (entry === "node_version.h") return full;
					try { if (fs.statSync(full).isDirectory()) { const f = findHeader(full, depth + 1); if (f) return f; } } catch {}
				}
			} catch {}
			return null;
		};
		const headerPath = findHeader(cacheDir, 0);
		if (headerPath) {
			const header = fs.readFileSync(headerPath, "utf8");
			const match = header.match(/NODE_MODULE_VERSION\s+(\d+)/);
			if (match) {
				const v = parseInt(match[1], 10);
				console.log(`[ensure-electron-native-deps] Electron ${electronVersion} → NODE_MODULE_VERSION=${v} (headers)`);
				return v;
			}
		}
	}

	// Fallback built-in mapping.
	const known = { "41": 145, "40": 131, "39": 127, "38": 127, "37": 127, "36": 127, "35": 131 };
	const major = electronVersion.split(".")[0];
	if (known[major] !== undefined) {
		console.log(`[ensure-electron-native-deps] Electron ${electronVersion} → NODE_MODULE_VERSION=${known[major]} (mapping)`);
		return known[major];
	}
	console.log(`[ensure-electron-native-deps] Unknown Electron ${electronVersion}; update knownModules in this script.`);
	return null;
}

function versionMismatch(binaryPath, expected) {
	if (expected === null) return false;
	const compiled = getCompiledModuleVersion(binaryPath);
	return compiled !== null && compiled !== expected;
}

// ── Rebuild helpers ────────────────────────────────────────────────────

function getElectronVersion() {
	return JSON.parse(
		fs.readFileSync(path.join(rootDir, "node_modules", "electron", "package.json"), "utf8")
	).version;
}

function rebuildPrebuiltOnly(moduleDir) {
	const ev = getElectronVersion();
	console.log(`[ensure-electron-native-deps]   prebuild-install for ${path.basename(moduleDir)} (electron ${ev})...`);
	// Use the locally-installed prebuild-install binary to avoid npx resolution
	// issues when running from a child process.
	const prebuildBin = path.join(rootDir, "node_modules", ".bin", "prebuild-install");
	execSync(
		`"${prebuildBin}" --runtime electron --target ${ev} --arch ${arch} --platform ${platform}`,
		{ cwd: moduleDir, stdio: "inherit" },
	);
}

function rebuildFromSource(moduleDir) {
	const ev = getElectronVersion();
	console.log(`[ensure-electron-native-deps]   node-gyp source rebuild for ${path.basename(moduleDir)} (electron ${ev})...`);
	execSync(
		[
			`npm_config_target=${ev}`,
			`npm_config_arch=${arch}`,
			`npm_config_target_arch=${arch}`,
			`npm_config_disturl=https://electronjs.org/headers`,
			`npm_config_runtime=electron`,
			`npm_config_build_from_source=true`,
			`npm rebuild`,
		].join(" "),
		{ cwd: moduleDir, stdio: "inherit" },
	);
}

// ── Main ───────────────────────────────────────────────────────────────

function needsRebuild() {
	if (platform !== "darwin") return true;
	const expected = getElectronModuleVersion();

	for (const binary of binaries) {
		if (!fs.existsSync(binary.path)) {
			if (!binary.optional) {
				console.log(`[ensure-electron-native-deps] Missing ${binary.name} binary.`);
				return true;
			}
			continue;
		}
		const info = getBinaryInfo(binary.path);
		if (!matchesCurrentArch(info)) {
			console.log(`[ensure-electron-native-deps] ${binary.name} arch mismatch: ${info}`);
			return true;
		}
		if (!binary.skipModuleVersionCheck && versionMismatch(binary.path, expected)) {
			console.log(`[ensure-electron-native-deps] ${binary.name} MODULE_VERSION mismatch: compiled=${getCompiledModuleVersion(binary.path)} expected=${expected}`);
			return true;
		}
	}
	return false;
}

if (!needsRebuild()) {
	console.log(`[ensure-electron-native-deps] Native dependencies verified for ${platform}-${arch}.`);
	process.exit(0);
}

// Pass 1 - Bulk rebuild via electron-builder (downloads headers, rebuilds most modules).
run(`npx electron-builder install-app-deps --arch=${arch}`);

const expectedModuleVersion = getElectronModuleVersion();

// Pass 2 - Per-module targeted fixes.
for (const binary of binaries) {
	const missing = !fs.existsSync(binary.path);
	const mismatch = !missing && versionMismatch(binary.path, expectedModuleVersion);

	if (!missing && !mismatch) continue; // already good
	if (binary.optional && missing) continue;

	console.log(`[ensure-electron-native-deps] Fixing ${binary.name} (${missing ? "missing" : `MODULE_VERSION=${getCompiledModuleVersion(binary.path)}`})...`);

	if (binary.prebuiltOnly) {
		rebuildPrebuiltOnly(binary.moduleDir);
	} else {
		// prebuilt-install first (often gets the right binary if available),
		// fall back to source rebuild.
		try {
			const ev = getElectronVersion();
			const prebuildBin = path.join(rootDir, "node_modules", ".bin", "prebuild-install");
			execSync(
				`"${prebuildBin}" --runtime electron --target ${ev} --arch ${arch} --platform ${platform}`,
				{ cwd: binary.moduleDir, stdio: "pipe" },
			);
		} catch { /* no prebuilt available – expected */ }
		// Always try source rebuild to ensure correct MODULE_VERSION.
		rebuildFromSource(binary.moduleDir);
	}
}

// Final verification
console.log("[ensure-electron-native-deps] Verification pass...");
for (const binary of binaries) {
	if (!fs.existsSync(binary.path)) {
		if (binary.optional) continue;
		console.error(`[ensure-electron-native-deps] ERROR: ${binary.name} binary missing after all rebuild attempts.`);
		process.exit(1);
	}
	const info = getBinaryInfo(binary.path);
	if (!matchesCurrentArch(info)) {
		console.error(`[ensure-electron-native-deps] ERROR: ${binary.name} wrong arch: ${info}`);
		process.exit(1);
	}
	if (!binary.skipModuleVersionCheck && versionMismatch(binary.path, expectedModuleVersion)) {
		console.error(
			`[ensure-electron-native-deps] ERROR: ${binary.name} MODULE_VERSION=${getCompiledModuleVersion(binary.path)} (expected ${expectedModuleVersion}).`,
		);
		console.error(`[ensure-electron-native-deps] Manual fix: cd ${binary.moduleDir} && npx prebuild-install --runtime electron --target ${getElectronVersion()} --arch ${arch} --platform ${platform}`);
		process.exit(1);
	}
	const archOk = matchesCurrentArch(info) ? "✓" : `⚠ ${arch}`;
	console.log(`[ensure-electron-native-deps] ${archOk} ${binary.name}`);
}
console.log(`[ensure-electron-native-deps] All native dependencies verified for ${platform}-${arch}.`);
