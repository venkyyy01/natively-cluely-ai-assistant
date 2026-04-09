type WindowLike = {
  isDestroyed: () => boolean;
  webContents: {
    id: number;
  };
};

export interface WindowFacadeDeps {
  getSettingsWindow: () => WindowLike | null;
  setSettingsWindowDimensions: (window: WindowLike, width: number, height: number) => void;
  getOverlayWindow: () => WindowLike | null;
  getLauncherContentWindow: () => WindowLike | null;
  setOverlayDimensions: (width: number, height: number) => void;
  setWindowMode: (mode: 'launcher' | 'overlay') => void;
  setOverlayClickthrough: (enabled: boolean) => void;
  toggleMainWindow: () => void;
  showMainWindow: () => void;
  hideMainWindow: () => void;
  moveWindowLeft: () => void;
  moveWindowRight: () => void;
  moveWindowUp: () => void;
  moveWindowDown: () => void;
  centerAndShowWindow: () => void;
  toggleSettingsWindow: (x?: number, y?: number) => void;
  closeSettingsWindow: () => void;
}

export class WindowFacade {
  constructor(private readonly deps: WindowFacadeDeps) {}

  updateContentDimensions(senderWebContentsId: number, width: number, height: number): void {
    const settingsWin = this.deps.getSettingsWindow();
    const overlayWin = this.deps.getOverlayWindow();
    const launcherWin = this.deps.getLauncherContentWindow();

    if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === senderWebContentsId) {
      this.deps.setSettingsWindowDimensions(settingsWin, width, height);
      return;
    }

    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.id === senderWebContentsId) {
      this.deps.setOverlayDimensions(width, height);
      return;
    }

    if (launcherWin && !launcherWin.isDestroyed() && launcherWin.webContents.id === senderWebContentsId) {
      return;
    }
  }

  setWindowMode(mode: 'launcher' | 'overlay'): void {
    this.deps.setWindowMode(mode);
  }

  setOverlayClickthrough(enabled: boolean): void {
    this.deps.setOverlayClickthrough(enabled);
  }

  toggleMainWindow(): void {
    this.deps.toggleMainWindow();
  }

  showMainWindow(): void {
    this.deps.showMainWindow();
  }

  hideMainWindow(): void {
    this.deps.hideMainWindow();
  }

  moveWindowLeft(): void {
    this.deps.moveWindowLeft();
  }

  moveWindowRight(): void {
    this.deps.moveWindowRight();
  }

  moveWindowUp(): void {
    this.deps.moveWindowUp();
  }

  moveWindowDown(): void {
    this.deps.moveWindowDown();
  }

  centerAndShowWindow(): void {
    this.deps.centerAndShowWindow();
  }

  toggleSettingsWindow(x?: number, y?: number): void {
    this.deps.toggleSettingsWindow(x, y);
  }

  closeSettingsWindow(): void {
    this.deps.closeSettingsWindow();
  }
}
