const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeModulePath = path.join(__dirname, '..', 'native-module');
const localNapiCli = path.join(nativeModulePath, 'node_modules', '@napi-rs', 'cli', 'scripts', 'index.js');
const args = new Set(process.argv.slice(2));
const buildCurrentOnly = args.has('--current');

function runCommand(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit', cwd: nativeModulePath });
}

function runNapiBuild(buildArgs) {
  if (fs.existsSync(localNapiCli)) {
    const resolvedArgs = [localNapiCli, 'build', ...buildArgs];
    console.log(`> ${process.execPath} ${resolvedArgs.join(' ')}`);
    execFileSync(process.execPath, resolvedArgs, {
      stdio: 'inherit',
      cwd: nativeModulePath,
    });
    return;
  }

  runCommand(`npx napi build ${buildArgs.join(' ')}`);
}

function writeAbiMetadata() {
  const abiVersion = process.versions.modules;
  const artifacts = fs
    .readdirSync(nativeModulePath)
    .filter((file) => file.endsWith('.node'));

  artifacts.forEach((artifact) => {
    const abiPath = path.join(nativeModulePath, `${artifact}.abi`);
    fs.writeFileSync(abiPath, `${abiVersion}\n`, 'utf8');
    console.log(`Wrote ABI metadata: ${path.relative(nativeModulePath, abiPath)} -> ${abiVersion}`);
  });
}

if (os.platform() === 'darwin') {
  if (buildCurrentOnly) {
    const target = os.arch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    console.log(`Building native audio for current macOS architecture: ${target}`);

    try {
      runCommand(`rustup target add ${target}`);
    } catch (err) {
      console.warn(`Warning: Could not configure rust target ${target} via rustup. Continuing anyway.`);
    }

    runNapiBuild(['--platform', '--target', target, '--release']);
  } else {
    console.log('Building native audio for macOS dual architectures...');

    try {
      runCommand('rustup target add x86_64-apple-darwin');
      runCommand('rustup target add aarch64-apple-darwin');
    } catch (err) {
      console.warn('Warning: Could not configure rust targets via rustup. Continuing anyway.');
    }

    console.log('\n--- Building for x64 ---');
    runNapiBuild(['--platform', '--target', 'x86_64-apple-darwin', '--release']);

    console.log('\n--- Building for arm64 ---');
    runNapiBuild(['--platform', '--target', 'aarch64-apple-darwin', '--release']);
  }
  
} else {
  console.log(`Building for current platform: ${os.platform()}`);
  runNapiBuild(['--platform', '--release']);
}

writeAbiMetadata();
