const { spawnSync } = require('node:child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const result = spawnSync(
  npmCommand,
  ['--prefix', 'renderer', 'run', 'test:coverage', '--', '--runInBand'],
  {
    encoding: 'utf8',
  },
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const allFilesLine = output
  .split('\n')
  .find((line) => line.includes('All files'));

if (!allFilesLine) {
  console.error('Renderer coverage summary not found in test output.');
  process.exit(1);
}

const percentages = [...allFilesLine.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));

if (percentages.length < 4 || percentages.slice(0, 4).some((value) => value < 100)) {
  console.error(`Renderer coverage gate failed: ${allFilesLine.trim()}`);
  process.exit(1);
}

console.log('Renderer coverage gate passed at 100%.');
