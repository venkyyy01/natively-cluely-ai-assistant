export interface IntelligenceEventWindowLike {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload?: unknown): void;
  };
}

export interface IntelligenceEventWindowSource {
  getOverlayContentWindow(): IntelligenceEventWindowLike | null;
  getMainWindow(): IntelligenceEventWindowLike | null;
}

export function getIntelligenceEventWindow(source: IntelligenceEventWindowSource): IntelligenceEventWindowLike | null {
  const overlayContentWindow = source.getOverlayContentWindow();
  if (overlayContentWindow && !overlayContentWindow.isDestroyed()) {
    return overlayContentWindow;
  }

  const mainWindow = source.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  return null;
}
