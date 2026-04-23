import fs from 'fs';
import path from 'path';

const helperPath = path.resolve(__dirname, '../../src/lib/electronApi.ts');
const mainPath = path.resolve(__dirname, '../../src/main.tsx');
const appPath = path.resolve(__dirname, '../../src/App.tsx');

test('renderer bootstrap installs the guarded Electron API bridge before first use', () => {
  const helperSource = fs.readFileSync(helperPath, 'utf8');
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const appSource = fs.readFileSync(appPath, 'utf8');

  expect(helperSource).toContain('export function installElectronApiGuard()');
  expect(mainSource).toContain("installElectronApiGuard()");
  expect(mainSource.indexOf('installElectronApiGuard()')).toBeLessThan(mainSource.indexOf("getThemeMode"));
  expect(mainSource).toContain('resolveWindowContext(window.location.search).kind');
  expect(mainSource).toContain('setAttribute("data-window-kind", kind)');
  expect(mainSource).toContain('await import("./App")');
  expect(mainSource).toContain('Renderer bootstrap failed');
  expect(mainSource).toContain('ErrorBoundary');
  expect(mainSource).toContain('context="AppBootstrap"');
  expect(appSource).toContain('Renderer startup failed');
  expect(appSource).toContain('if (!electronAPI)');
});
