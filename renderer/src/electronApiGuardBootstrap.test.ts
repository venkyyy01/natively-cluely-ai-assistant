import fs from 'fs';
import path from 'path';

const helperPath = path.resolve(__dirname, '../../src/lib/electronApi.ts');
const mainPath = path.resolve(__dirname, '../../src/main.tsx');

test('renderer bootstrap installs the guarded Electron API bridge before first use', () => {
  const helperSource = fs.readFileSync(helperPath, 'utf8');
  const mainSource = fs.readFileSync(mainPath, 'utf8');

  expect(helperSource).toContain('export function installElectronApiGuard()');
  expect(mainSource).toContain("installElectronApiGuard()");
  expect(mainSource.indexOf('installElectronApiGuard()')).toBeLessThan(mainSource.indexOf("getThemeMode"));
});
