import type { EventEmitter } from 'node:events';

import type { DirtyRect, StealthFramePayload } from './types';

interface NativeImageLike {
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
}

interface PaintEventEmitter extends Pick<EventEmitter, 'on' | 'removeListener'> {
  setFrameRate?: (fps: number) => void;
}

interface ShellFrameTarget {
  send(channel: string, payload: StealthFramePayload): void;
}

interface FrameBridgeOptions {
  target: ShellFrameTarget;
  frameRate?: number;
  logger?: Pick<Console, 'warn'>;
  onFrameSent?: (payload: StealthFramePayload) => void;
}

const normalizeDirtyRects = (dirtyRects: Array<Partial<DirtyRect>>): DirtyRect[] =>
  dirtyRects.map((rect) => ({
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
  }));

export class FrameBridge {
  private readonly target: ShellFrameTarget;
  private readonly frameRate: number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly onFrameSent?: (payload: StealthFramePayload) => void;
  private paintSource: PaintEventEmitter | null = null;
  private nextFrameId = 1;
  private awaitingAck = false;
  private pendingFrame: StealthFramePayload | null = null;
  private readonly paintListener = (_event: unknown, dirtyRect: Partial<DirtyRect>, image: NativeImageLike) => {
    try {
      const size = image.getSize();
      const payload: StealthFramePayload = {
        dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`,
        width: size.width,
        height: size.height,
        scaleFactor: 1,
        dirtyRects: normalizeDirtyRects([dirtyRect]),
        frameId: this.nextFrameId++,
      };

      if (this.awaitingAck) {
        this.pendingFrame = payload;
        return;
      }

      this.sendFrame(payload);
    } catch (error) {
      this.logger.warn('[FrameBridge] Failed to forward frame:', error);
    }
  };

  constructor(options: FrameBridgeOptions) {
    this.target = options.target;
    this.frameRate = options.frameRate ?? 30;
    this.logger = options.logger ?? console;
    this.onFrameSent = options.onFrameSent;
  }

  attach(source: PaintEventEmitter): void {
    this.detach();
    this.paintSource = source;
    source.setFrameRate?.(this.frameRate);
    source.on('paint', this.paintListener);
  }

  detach(): void {
    if (!this.paintSource) {
      return;
    }

    this.paintSource.removeListener('paint', this.paintListener);
    this.paintSource = null;
    this.awaitingAck = false;
    this.pendingFrame = null;
  }

  notifyPresented(frameId: number): void {
    if (!this.awaitingAck) {
      return;
    }

    this.awaitingAck = false;
    if (!this.pendingFrame) {
      return;
    }

    const nextFrame = this.pendingFrame;
    this.pendingFrame = null;
    if (nextFrame.frameId <= frameId) {
      return;
    }
    this.sendFrame(nextFrame);
  }

  private sendFrame(payload: StealthFramePayload): void {
    this.awaitingAck = true;
    this.target.send('stealth-shell:frame', payload);
    this.onFrameSent?.(payload);
  }
}
