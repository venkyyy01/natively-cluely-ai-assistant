const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

const coverageOutput = run('node', [
  '--test',
  '--experimental-test-coverage',
  'dist-electron/electron/tests/*.test.js',
]);

const allFilesLine = coverageOutput
  .split('\n')
  .find((line) => line.includes('all files'));

if (!allFilesLine) {
  console.error('Coverage summary not found in test output.');
  process.exit(1);
}

const percentages = [...allFilesLine.matchAll(/(\d+\.\d+)/g)].map((match) => Number(match[1]));

if (percentages.length < 3 || percentages.slice(0, 3).some((value) => value < 100)) {
  console.error(`Electron coverage gate failed: ${allFilesLine.trim()}`);
  process.exit(1);
}

console.log('Electron coverage gate passed at 100%.');
