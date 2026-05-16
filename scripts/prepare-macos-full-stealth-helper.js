const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const defaultPackageDir = path.join(root, 'stealth-projects', 'macos-full-stealth-helper');
const defaultOutputBundleDir = path.join(root, 'assets', 'xpcservices', 'macos-full-stealth-helper.xpc');
const defaultEntitlementsPath = path.join(root, 'assets', 'entitlements.mac.plist');

function log(message) {
  process.stdout.write(`[prepare-macos-full-stealth-helper] ${message}\n`);
}

function pathExists(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isTruthyFlag(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /^(1|true|yes|on)$/i.test(value.trim());
}

function commandExists(command, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(command, ['--version'], { stdio: 'ignore' });
  return !result.error;
}

function findBuiltBinary(packageDir, configuration) {
  const candidates = [
    path.join(packageDir, '.build', configuration, 'macos-full-stealth-helper'),
    path.join(packageDir, '.build', 'arm64-apple-macosx', configuration, 'macos-full-stealth-helper'),
    path.join(packageDir, '.build', 'x86_64-apple-macosx', configuration, 'macos-full-stealth-helper'),
  ];
  return candidates.find(pathExists) ?? null;
}

function createInfoPlistContent(bundleIdentifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>macos-full-stealth-helper</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>macos-full-stealth-helper</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>XPCService</key>
  <dict>
    <key>ServiceType</key>
    <string>Application</string>
  </dict>
</dict>
</plist>
`;
}

function stageBundle({
  builtBinary,
  outputBundleDir = defaultOutputBundleDir,
  bundleIdentifier = 'com.electron.meeting-notes.macos-full-stealth-helper',
  logFn = log,
}) {
  const contentsDir = path.join(outputBundleDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const stagedBinary = path.join(macosDir, 'macos-full-stealth-helper');
  const infoPlistPath = path.join(contentsDir, 'Info.plist');

  fs.rmSync(outputBundleDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.copyFileSync(builtBinary, stagedBinary);
  fs.chmodSync(stagedBinary, 0o755);
  fs.writeFileSync(infoPlistPath, createInfoPlistContent(bundleIdentifier));
  logFn(`Staged helper bundle at ${outputBundleDir}`);

  return {
    outputBundleDir,
    stagedBinary,
    infoPlistPath,
  };
}

function signBundle({
  bundlePath,
  entitlementsPath = defaultEntitlementsPath,
  identity = process.env.CODESIGN_IDENTITY || '-',
  execFile = execFileSync,
  logFn = log,
}) {
  if (!pathExists(entitlementsPath)) {
    logFn('Warning: entitlements file not found, skipping signing');
    return false;
  }

  try {
    execFile('codesign', [
      '--sign', identity,
      '--force',
      '--options', 'runtime',
      '--entitlements', entitlementsPath,
      bundlePath,
    ], { stdio: 'inherit' });
    logFn(`Signed ${bundlePath}`);
    return true;
  } catch (error) {
    logFn(`Warning: codesign failed: ${error.message}`);
    return false;
  }
}

function prepareMacosFullStealthHelper(options = {}) {
  const platform = options.platform ?? process.platform;
  const packageDir = options.packageDir ?? defaultPackageDir;
  const configuration = options.configuration ?? process.env.MACOS_FULL_STEALTH_HELPER_CONFIGURATION ?? 'release';
  const outputBundleDir = options.outputBundleDir ?? defaultOutputBundleDir;
  const bundleIdentifier = options.bundleIdentifier ?? process.env.MACOS_FULL_STEALTH_HELPER_BUNDLE_ID ?? 'com.electron.meeting-notes.macos-full-stealth-helper';
  const execFile = options.execFile ?? execFileSync;
  const logFn = options.logFn ?? log;
  const shouldBuild = options.shouldBuild ?? true;
  const shouldCodesign = options.shouldCodesign ?? process.env.SKIP_CODESIGN !== '1';
  const entitlementsPath = options.entitlementsPath ?? defaultEntitlementsPath;
  const requireHelper = options.requireHelper ?? isTruthyFlag(process.env.NATIVELY_REQUIRE_FULL_STEALTH_HELPER ?? '');
  const commandExistsFn = options.commandExists ?? commandExists;

  const skipWithoutHelper = (reason) => {
    if (requireHelper) {
      throw new Error(reason);
    }

    logFn(`Warning: ${reason}. Continuing without the full stealth helper bundle.`);
    return {
      skipped: true,
      reason,
    };
  };

  if (platform !== 'darwin') {
    logFn('Skipping helper build on non-macOS host');
    return { skipped: true };
  }

  let builtBinary = options.builtBinary ?? findBuiltBinary(packageDir, configuration);

  if (shouldBuild) {
    if (!commandExistsFn('swift')) {
      if (!builtBinary) {
        return skipWithoutHelper('Swift toolchain unavailable; unable to build the macOS full stealth helper');
      }

      logFn('Swift toolchain unavailable; using existing macOS full stealth helper build output');
    } else {
      try {
        logFn(`Building macOS full stealth helper (${configuration})`);
        execFile('swift', ['build', '-c', configuration, '--package-path', packageDir], {
          cwd: root,
          stdio: 'inherit',
        });
      } catch (error) {
        if (!builtBinary) {
          return skipWithoutHelper(`Swift build failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        logFn(`Warning: swift build failed, using existing helper binary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  builtBinary = options.builtBinary ?? findBuiltBinary(packageDir, configuration) ?? builtBinary;
  if (!builtBinary) {
    return skipWithoutHelper(`Unable to locate built full stealth helper for configuration '${configuration}'`);
  }

  const staged = stageBundle({
    builtBinary,
    outputBundleDir,
    bundleIdentifier,
    logFn,
  });

  if (shouldCodesign) {
    signBundle({
      bundlePath: staged.outputBundleDir,
      entitlementsPath,
      execFile,
      logFn,
    });
  }

  return staged;
}

if (require.main === module) {
  try {
    prepareMacosFullStealthHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  commandExists,
  createInfoPlistContent,
  findBuiltBinary,
  isTruthyFlag,
  stageBundle,
  signBundle,
  prepareMacosFullStealthHelper,
};
