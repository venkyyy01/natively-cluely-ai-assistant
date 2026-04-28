import { getElectronAPI, getOptionalElectronMethod, installElectronApiGuard, requireElectronMethod } from '../../src/lib/electronApi';

const originalElectronAPI = window.electronAPI;

afterEach(() => {
  if (originalElectronAPI) {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: originalElectronAPI,
    });
  } else {
    delete (window as Partial<Window>).electronAPI;
  }
});

test('installElectronApiGuard preserves missing preload methods as absent without replacing the live preload bridge', async () => {
  const rawBridge = Object.freeze({
    getThemeMode: jest.fn().mockResolvedValue({ mode: 'dark', resolved: 'dark' }),
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: false,
    value: rawBridge,
  });

  installElectronApiGuard();

  expect(window.electronAPI).toBe(rawBridge);

  const guardedBridge = getElectronAPI();

  expect(guardedBridge).not.toBe(rawBridge);
  await expect(guardedBridge.getThemeMode()).resolves.toEqual({ mode: 'dark', resolved: 'dark' });

  expect((window.electronAPI as any).startMeeting).toBeUndefined();
  expect(() => requireElectronMethod('startMeeting')).toThrow(
    "Electron API method 'startMeeting' is unavailable. Restart the app or Electron dev process to reload the preload bridge."
  );
});

test('getOptionalElectronMethod returns null for methods that are not present on the live preload bridge', () => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      getThemeMode: jest.fn(),
    },
  });

  expect(getOptionalElectronMethod('startMeeting')).toBeNull();
});
