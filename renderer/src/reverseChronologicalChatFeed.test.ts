import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const componentPaths = [
  'src/components/NativelyInterface.tsx',
  'src/components/GlobalChatOverlay.tsx',
  'src/components/MeetingChatOverlay.tsx',
];

test('chat surfaces render newest messages first in a standard top-down stack', () => {
  for (const componentPath of componentPaths) {
    const source = readSource(componentPath);

    expect(source).not.toContain('messages.slice().reverse().map');
    expect(source).not.toContain('flex-col-reverse');
  }
});

test('chat surfaces do not rely on reverse scans or tail updates for the newest message', () => {
  for (const componentPath of componentPaths) {
    const source = readSource(componentPath);

    expect(source).not.toContain('[...messages].reverse().find');
    expect(source).not.toContain('prev[prev.length - 1]');
    expect(source).not.toContain('updated[prev.length - 1]');
  }
});
