import { EventEmitter } from 'events';
import { screen, nativeImage, Rectangle } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';

const execAsync = promisify(exec);

export interface HoverPosition {
  x: number;
  y: number;
  screenId: number;
  timestamp: number;
}

export interface HoverCapture {
  id: string;
  path: string;
  bounds: Rectangle;
  cursorPosition: HoverPosition;
  timestamp: number;
}

export interface HoverModeConfig {
  hoverDebounceMs: number;
  captureExpansionFactor: number;
  minCaptureWidth: number;
  minCaptureHeight: number;
  maxCaptureWidth: number;
  maxCaptureHeight: number;
}

const DEFAULT_CONFIG: HoverModeConfig = {
  hoverDebounceMs: 500,
  captureExpansionFactor: 10,
  minCaptureWidth: 200,
  minCaptureHeight: 150,
  maxCaptureWidth: 2000,
  maxCaptureHeight: 1500,
};

export class HoverModeManager extends EventEmitter {
  private enabled: boolean = false;
  private config: HoverModeConfig;
  private lastPosition: HoverPosition | null = null;
  private hoverTimer: NodeJS.Timeout | null = null;
  private captureId: number = 0;
  private readonly screenshotDir: string;
  private isCapturing: boolean = false;

  constructor(config: Partial<HoverModeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.screenshotDir = path.join(app.getPath('userData'), 'hover_captures');
    this.ensureScreenshotDir();
  }

  private ensureScreenshotDir(): void {
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    
    this.enabled = enabled;
    
    if (!enabled) {
      this.cancelPendingCapture();
    }
    
    this.emit('enabled-changed', enabled);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public updateMousePosition(x: number, y: number, screenId: number = 0): void {
    if (!this.enabled || this.isCapturing) return;

    const newPosition: HoverPosition = {
      x,
      y,
      screenId,
      timestamp: Date.now(),
    };

    if (this.shouldTriggerCapture(newPosition)) {
      this.scheduleCapture(newPosition);
    }

    this.lastPosition = newPosition;
  }

  private shouldTriggerCapture(newPosition: HoverPosition): boolean {
    if (!this.lastPosition) return true;

    const distance = Math.sqrt(
      Math.pow(newPosition.x - this.lastPosition.x, 2) +
      Math.pow(newPosition.y - this.lastPosition.y, 2)
    );

    return distance > 10;
  }

  private scheduleCapture(position: HoverPosition): void {
    this.cancelPendingCapture();

    this.hoverTimer = setTimeout(() => {
      if (this.enabled && !this.isCapturing) {
        this.performCapture(position).catch(err => {
          this.emit('capture-error', err);
        });
      }
    }, this.config.hoverDebounceMs);
  }

  private cancelPendingCapture(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private async performCapture(position: HoverPosition): Promise<HoverCapture> {
    this.isCapturing = true;

    try {
      const bounds = this.calculateCaptureBounds(position);
      const capturePath = await this.captureRegion(bounds);
      
      const capture: HoverCapture = {
        id: uuidv4(),
        path: capturePath,
        bounds,
        cursorPosition: position,
        timestamp: Date.now(),
      };

      this.emit('capture', capture);
      return capture;
    } finally {
      this.isCapturing = false;
    }
  }

  private calculateCaptureBounds(position: HoverPosition): Rectangle {
    const display = screen.getDisplayNearestPoint({ x: position.x, y: position.y });
    const { workArea } = display;

    const baseWidth = Math.max(this.config.minCaptureWidth, workArea.width * 0.1);
    const baseHeight = Math.max(this.config.minCaptureHeight, workArea.height * 0.1);

    const expandedWidth = Math.min(
      baseWidth * this.config.captureExpansionFactor,
      this.config.maxCaptureWidth
    );
    const expandedHeight = Math.min(
      baseHeight * this.config.captureExpansionFactor,
      this.config.maxCaptureHeight
    );

    const halfWidth = Math.floor(expandedWidth / 2);
    const halfHeight = Math.floor(expandedHeight / 2);

    let x = position.x - halfWidth;
    let y = position.y - halfHeight;

    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - expandedWidth));
    y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - expandedHeight));

    return {
      x,
      y,
      width: Math.floor(expandedWidth),
      height: Math.floor(expandedHeight),
    };
  }

  private async captureRegion(bounds: Rectangle): Promise<string> {
    const outputPath = path.join(this.screenshotDir, `hover-${uuidv4()}.png`);

    if (process.platform === 'darwin') {
      const safePath = outputPath.replace(/"/g, '\\"');
      const cmd = `screencapture -x -R ${bounds.x},${bounds.y},${bounds.width},${bounds.height} "${safePath}"`;
      await execAsync(cmd);
    } else if (process.platform === 'win32') {
      const safePath = outputPath.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Drawing.Bitmap]::new(${bounds.width}, ${bounds.height}) | ForEach-Object { $g = [System.Drawing.Graphics]::FromImage($_); $g.CopyFromScreen(${bounds.x}, ${bounds.y}, 0, 0, [System.Drawing.Size]::new(${bounds.width}, ${bounds.height})); $_.Save('${safePath}'); $g.Dispose() }`;
      await execAsync(`powershell -NoProfile -Command "${psScript}"`);
    } else {
      const safePath = outputPath.replace(/"/g, '\\"');
      await execAsync(`import -window root -crop ${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y} "${safePath}"`);
    }

    await this.waitForFile(outputPath);
    return outputPath;
  }

  private async waitForFile(filePath: string, maxRetries: number = 10): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Capture file not ready: ${filePath}`);
  }

  public cleanup(): void {
    this.cancelPendingCapture();
    this.removeAllListeners();
  }
}

export default HoverModeManager;
