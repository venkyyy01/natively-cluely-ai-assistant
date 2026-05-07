const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const arch = os.arch();
const platform = os.platform();

// Electron's expected NODE_MODULE_VERSION — read from the installed electron's abi_version file
let expectedNodeModuleVersion = null;
const abiVersionPath = path.join(rootDir, 'node_modules', 'electron', 'abi_version');
try {
  const versionStr = fs.readFileSync(abiVersionPath, 'utf8').trim();
  expectedNodeModuleVersion = parseInt(versionStr, 10);
  if (isNaN(expectedNodeModuleVersion)) {
    expectedNodeModuleVersion = null;
    console.warn(`[ensure-electron-native-deps] Invalid abi_version content: "${versionStr}"`);
  } else {
    console.log(`[ensure-electron-native-deps] Electron expects NODE_MODULE_VERSION=${expectedNodeModuleVersion}`);
  }
} catch (e) {
  console.warn(`[ensure-electron-native-deps] Could not read Electron ABI version from ${abiVersionPath}:`, e.message);
}

const binaries = [
  {
    name: 'better-sqlite3',
    path: path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  },
  {
    name: 'sqlite3',
    path: path.join(rootDir, 'node_modules', 'sqlite3', 'build', 'Release', 'node_sqlite3.node'),
  },
  {
    name: 'keytar',
    path: path.join(rootDir, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node'),
  },
  {
    name: 'sharp',
    path: path.join(rootDir, 'node_modules', 'sharp', 'build', 'Release', 'sharp-darwin-arm64v8.node'),
    optional: true,
  },
];

function run(command) {
  console.log(`[ensure-electron-native-deps] > ${command}`);
  execSync(command, { cwd: rootDir, stdio: 'inherit' });
}

function getBinaryInfo(binaryPath) {
  try {
    return execSync(`file "${binaryPath}"`, { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function matchesCurrentArch(info) {
  if (!info) return false;
  if (arch === 'arm64') {
    return info.includes('arm64');
  }
  if (arch === 'x64') {
    return info.includes('x86_64');
  }
  return true;
}

/**
 * Read the NODE_MODULE_VERSION from .forge-meta (written by @electron/rebuild)
 * Format: "{arch}--{node_module_version}" e.g. "arm64--145"
 */
function getBinaryNodeModuleVersion(binaryPath) {
  const metaPath = path.join(path.dirname(binaryPath), '.forge-meta');
  try {
    const content = fs.readFileSync(metaPath, 'utf8').trim();
    const parts = content.split('--');
    if (parts.length >= 2) {
      return parseInt(parts[parts.length - 1], 10);
    }
  } catch {
    // no .forge-meta — binary wasn't rebuilt by @electron/rebuild, needs rebuild
    return null;
  }
  return null;
}

function cleanStaleBuilds() {
  // Remove stale build artifacts to force a clean rebuild
  for (const binary of binaries) {
    const buildDir = path.dirname(binary.path);
    if (fs.existsSync(buildDir)) {
      console.log(`[ensure-electron-native-deps] Cleaning stale build: ${buildDir}`);
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }
}

function needsRebuild() {
  if (platform !== 'darwin') {
    return true;
  }

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

    // Check NODE_MODULE_VERSION compatibility if we know what Electron expects.
    // Missing .forge-meta also triggers a rebuild (fresh install scenario).
    if (expectedNodeModuleVersion) {
      const binaryVersion = getBinaryNodeModuleVersion(binary.path);
      if (binaryVersion === null) {
        console.log(`[ensure-electron-native-deps] ${binary.name} has no .forge-meta — assuming stale, forcing rebuild`);
        return true;
      }
      if (binaryVersion !== expectedNodeModuleVersion) {
        console.log(
          `[ensure-electron-native-deps] ${binary.name} NODE_MODULE_VERSION mismatch: ` +
          `binary=${binaryVersion}, electron=${expectedNodeModuleVersion}`
        );
        return true;
      }
    }
  }

  return false;
}

if (!needsRebuild()) {
  console.log(`[ensure-electron-native-deps] Native Electron dependencies already match ${platform}-${arch}.`);
  process.exit(0);
}

// Clean stale builds before rebuilding to prevent cached wrong-ABI binaries
console.log('[ensure-electron-native-deps] Stale binaries detected — cleaning build artifacts...');
cleanStaleBuilds();

run(`npx electron-builder install-app-deps --arch=${arch}`);

// Verify rebuild succeeded and binaries match target architecture and ABI
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
    console.error(`[ensure-electron-native-deps] Expected ${arch} but binary is not compatible`);
    process.exit(1);
  }
  // Verify NODE_MODULE_VERSION. Missing .forge-meta is treated as failure.
  if (expectedNodeModuleVersion) {
    const binaryVersion = getBinaryNodeModuleVersion(binary.path);
    if (binaryVersion === null) {
      console.error(
        `[ensure-electron-native-deps] ERROR: ${binary.name} has no .forge-meta after rebuild. ` +
        `Try: rm -rf node_modules/${binary.name}/build && npx electron-builder install-app-deps`
      );
      process.exit(1);
    }
    if (binaryVersion !== expectedNodeModuleVersion) {
      console.error(
        `[ensure-electron-native-deps] ERROR: ${binary.name} still has wrong NODE_MODULE_VERSION after rebuild: ` +
        `binary=${binaryVersion}, electron=${expectedNodeModuleVersion}`
      );
      console.error(`[ensure-electron-native-deps] Try: rm -rf node_modules/${binary.name}/build && npx electron-builder install-app-deps`);
      process.exit(1);
    }
  }
  console.log(`[ensure-electron-native-deps] ✓ ${binary.name}: ${info}`);
}
console.log(`[ensure-electron-native-deps] All native dependencies verified for ${platform}-${arch}.`);
