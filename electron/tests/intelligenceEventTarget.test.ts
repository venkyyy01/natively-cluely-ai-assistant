import test from 'node:test';
import assert from 'node:assert/strict';
import { getIntelligenceEventWindow } from '../intelligenceEventTarget';

function createWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: () => {},
    },
  };
}

test('getIntelligenceEventWindow prefers the overlay content renderer', () => {
  const overlayWindow = createWindow(false);
  const mainWindow = createWindow(false);

  const result = getIntelligenceEventWindow({
    getOverlayContentWindow: () => overlayWindow,
    getMainWindow: () => mainWindow,
  });

  assert.equal(result, overlayWindow);
});

test('getIntelligenceEventWindow falls back to the main window when overlay content is unavailable', () => {
  const mainWindow = createWindow(false);

  const result = getIntelligenceEventWindow({
    getOverlayContentWindow: () => null,
    getMainWindow: () => mainWindow,
  });

  assert.equal(result, mainWindow);
});

test('getIntelligenceEventWindow ignores destroyed windows', () => {
  const result = getIntelligenceEventWindow({
    getOverlayContentWindow: () => createWindow(true),
    getMainWindow: () => createWindow(true),
  });

  assert.equal(result, null);
});
