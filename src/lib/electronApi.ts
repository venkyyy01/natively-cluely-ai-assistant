import type { ElectronAPI } from '../types/electron';

export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API bridge is unavailable');
  }

  return window.electronAPI;
}
