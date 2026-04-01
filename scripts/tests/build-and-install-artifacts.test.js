const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'build-and-install.sh');

function runShell(script, env = {}) {
  return execFileSync('bash', ['-lc', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BUILD_AND_INSTALL_LIB: '1',
      ...env,
    },
  }).trim();
}

function touch(filePath, timeMs) {
  if (filePath.endsWith('.app')) {
    fs.mkdirSync(filePath, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, path.basename(filePath));
  }
  const time = new Date(timeMs);
  fs.utimesSync(filePath, time, time);
}

test('artifact helpers prefer the arm64 packaged app over a newer generic mac app', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-install-artifacts-'));
  const releaseDir = path.join(tempDir, 'release');

  touch(path.join(releaseDir, 'mac', 'Natively.app'), 2_000);
  touch(path.join(releaseDir, 'mac-arm64', 'Natively.app'), 1_000);
  touch(path.join(releaseDir, 'Natively-old.dmg'), 1_500);
  touch(path.join(releaseDir, 'Natively-new.dmg'), 3_000);
  touch(path.join(releaseDir, 'Natively-old.zip'), 1_600);
  touch(path.join(releaseDir, 'Natively-new.zip'), 4_000);

  const output = runShell(
    `source "${scriptPath}" && collect_packaged_artifacts "${releaseDir}"`,
    { APP_NAME: 'Natively', BUILD_ARCH: 'arm64' }
  );

  const lines = output.split('\n');
  assert.equal(lines[0], path.join(releaseDir, 'mac-arm64', 'Natively.app'));
  assert.equal(lines[1], path.join(releaseDir, 'Natively-new.dmg'));
  assert.equal(lines[2], path.join(releaseDir, 'Natively-new.zip'));
});

test('artifact helpers fall back to newest packaged app when no arch-specific app exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-install-artifacts-fallback-'));
  const releaseDir = path.join(tempDir, 'release');

  touch(path.join(releaseDir, 'mac-old', 'Natively.app'), 1_000);
  touch(path.join(releaseDir, 'mac-new', 'Natively.app'), 2_000);

  const output = runShell(
    `source "${scriptPath}" && collect_packaged_artifacts "${releaseDir}"`,
    { APP_NAME: 'Natively', BUILD_ARCH: 'arm64' }
  );

  const lines = output.split('\n');
  assert.equal(lines[0], path.join(releaseDir, 'mac-new', 'Natively.app'));
});

test('cleanup removes stale packaged app directories and archive files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-install-clean-'));
  const releaseDir = path.join(tempDir, 'release');
  const cacheDir = path.join(tempDir, 'cache');

  touch(path.join(releaseDir, 'mac', 'Natively.app'), 1_000);
  touch(path.join(releaseDir, 'mac-arm64', 'Natively.app'), 1_000);
  touch(path.join(releaseDir, 'Natively.dmg'), 1_000);
  touch(path.join(releaseDir, 'Natively.zip'), 1_000);
  touch(path.join(tempDir, 'Natively.dmg'), 1_000);
  touch(path.join(tempDir, 'Natively.zip'), 1_000);

  runShell(
    `source "${scriptPath}" && SCRIPT_DIR="${tempDir}" RELEASE_DIR="${releaseDir}" HOME="${cacheDir}" clean_build_artifacts`
  );

  assert.equal(fs.existsSync(path.join(releaseDir, 'mac', 'Natively.app')), false);
  assert.equal(fs.existsSync(path.join(releaseDir, 'mac-arm64', 'Natively.app')), false);
  assert.equal(fs.existsSync(path.join(releaseDir, 'Natively.dmg')), false);
  assert.equal(fs.existsSync(path.join(releaseDir, 'Natively.zip')), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'Natively.dmg')), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'Natively.zip')), false);
});

test('cleanup preserves the tracked macOS virtual display helper source path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-install-helper-'));
  const releaseDir = path.join(tempDir, 'release');
  const helperPath = path.join(tempDir, 'assets', 'bin', 'macos', 'stealth-virtual-display-helper');

  touch(helperPath, 1_000);

  runShell(
    `source "${scriptPath}" && SCRIPT_DIR="${tempDir}" RELEASE_DIR="${releaseDir}" HOME="${tempDir}" clean_build_artifacts`
  );

  assert.equal(fs.existsSync(helperPath), true);
});

test('artifact helpers fail clearly when packaged app is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-install-missing-app-'));
  const releaseDir = path.join(tempDir, 'release');
  touch(path.join(releaseDir, 'Natively.zip'), 1_000);

  try {
    runShell(`source "${scriptPath}" && collect_packaged_artifacts "${releaseDir}"`);
    assert.fail('expected collect_packaged_artifacts to fail when no app is present');
  } catch (error) {
    assert.match(error.stdout || '', /Missing packaged app/);
  }
});
