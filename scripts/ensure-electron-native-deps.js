const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const arch = os.arch();
const platform = os.platform();

const binaries = [
	{
		name: "better-sqlite3",
		path: path.join(
			rootDir,
			"node_modules",
			"better-sqlite3",
			"build",
			"Release",
			"better_sqlite3.node",
		),
	},
	{
		name: "sqlite3",
		path: path.join(
			rootDir,
			"node_modules",
			"sqlite3",
			"build",
			"Release",
			"node_sqlite3.node",
		),
	},
	{
		name: "keytar",
		path: path.join(
			rootDir,
			"node_modules",
			"keytar",
			"build",
			"Release",
			"keytar.node",
		),
	},
	{
		name: "sharp",
		path: path.join(
			rootDir,
			"node_modules",
			"sharp",
			"build",
			"Release",
			"sharp-darwin-arm64v8.node",
		),
		optional: true,
	},
];

function run(command) {
	console.log(`[ensure-electron-native-deps] > ${command}`);
	execSync(command, { cwd: rootDir, stdio: "inherit" });
}

function getBinaryInfo(binaryPath) {
	try {
		return execSync(`file "${binaryPath}"`, {
			cwd: rootDir,
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
}

function matchesCurrentArch(info) {
	if (!info) return false;
	if (arch === "arm64") {
		return info.includes("arm64");
	}
	if (arch === "x64") {
		return info.includes("x86_64");
	}
	return true;
}

function readForgeMeta(binaryPath) {
  const forgeMetaPath = path.join(path.dirname(binaryPath), '.forge-meta');
  if (fs.existsSync(forgeMetaPath)) {
    return fs.readFileSync(forgeMetaPath, 'utf8').trim();
  }
  return null;
}

function getExpectedForgeMeta() {
  const osArch = arch === 'arm64' ? 'arm64' : 'x64';
  try {
    const electronPkg = require(path.join(rootDir, 'node_modules', 'electron', 'package.json'));
    const version = electronPkg.version || '';
    const nodeAbi = require('node-abi');
    const abi = nodeAbi.getAbi(version, 'electron');

    return `${osArch}--${abi}`;
  } catch {
    return null;
  }
}

function needsRebuild() {
	if (platform !== "darwin") {
		return true;
	}

  const expectedMeta = getExpectedForgeMeta();

  for (const binary of binaries) {
    if (!fs.existsSync(binary.path)) {
      if (!binary.optional) {
        console.log(`[ensure-electron-native-deps] Missing ${binary.name} binary: ${binary.path}`);
        return true;
      }
      continue;
    }

    const info = getBinaryInfo(binary.path);
    if (!matchesCurrentArch(info)) {
      console.log(`[ensure-electron-native-deps] ${binary.name} arch mismatch: ${info}`);
      return true;
    }

    const actualMeta = readForgeMeta(binary.path);
    if (!actualMeta) {
      if (!binary.optional) {
        console.log(`[ensure-electron-native-deps] ${binary.name} missing .forge-meta, rebuild needed`);
        return true;
      }
      continue;
    }

    if (expectedMeta && actualMeta !== expectedMeta) {
      console.log(`[ensure-electron-native-deps] ${binary.name} .forge-meta mismatch:`);
      console.log(`  expected: ${expectedMeta}`);
      console.log(`  actual:   ${actualMeta}`);
      return true;
    }
  }

	return false;
}

if (!needsRebuild()) {
	console.log(
		`[ensure-electron-native-deps] Native Electron dependencies already match ${platform}-${arch}.`,
	);
	process.exit(0);
}

run(`npx electron-builder install-app-deps --arch=${arch}`);

console.log('[ensure-electron-native-deps] Verifying rebuilt binaries...');
for (const binary of binaries) {
  if (!fs.existsSync(binary.path)) {
    if (binary.optional) continue;
    console.error(`[ensure-electron-native-deps] ERROR: ${binary.name} binary missing after rebuild: ${binary.path}`);
    process.exit(1);
  }
  const info = getBinaryInfo(binary.path);
  if (!matchesCurrentArch(info)) {
    console.error(`[ensure-electron-native-deps] ERROR: ${binary.name} still has wrong architecture after rebuild: ${info}`);
    process.exit(1);
  }
  console.log(`[ensure-electron-native-deps] ${binary.name}: ${info}`);
}

const expectedMeta = getExpectedForgeMeta();
if (expectedMeta) {
  for (const binary of binaries) {
    if (binary.optional && !fs.existsSync(binary.path)) continue;
    if (!fs.existsSync(binary.path)) continue;
    const actualMeta = readForgeMeta(binary.path);
    if (actualMeta !== expectedMeta) {
      console.error(`[ensure-electron-native-deps] ERROR: ${binary.name} .forge-meta mismatch after rebuild:`);
      console.error(`  expected: ${expectedMeta}`);
      console.error(`  actual:   ${actualMeta}`);
      process.exit(1);
    }
    console.log(`[ensure-electron-native-deps] ${binary.name} .forge-meta: ${actualMeta}`);
  }
}

console.log(`[ensure-electron-native-deps] All native dependencies verified for ${platform}-${arch}.`);
