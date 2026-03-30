import fs from 'fs';
import path from 'path';

const hookPath = path.resolve(__dirname, '../../src/hooks/useHumanSpeedAutoScroll.ts');

test('uses the updated human reading speed default', () => {
  const source = fs.readFileSync(hookPath, 'utf8');

  expect(source).toContain('const HUMAN_WORDS_PER_MINUTE = 196;');
});
