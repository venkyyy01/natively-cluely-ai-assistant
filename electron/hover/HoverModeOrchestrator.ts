import { EventEmitter } from 'events';
import type { LLMHelper } from '../LLMHelper';
import { HoverModeManager, type HoverCapture } from './HoverModeManager';
import { HoverQuestionClassifier, type HoverAnalysisResult } from './HoverQuestionClassifier';
import { HoverLLMResponder, type HoverResponse } from './HoverLLMResponder';
import { screen } from 'electron';
import sharp from 'sharp';

const CHANGE_DETECTION_THRESHOLD = 0.45;
const CHANGE_DETECTION_SIZE = { width: 160, height: 90 };
const PIXEL_DIFF_THRESHOLD = 24;

export interface HoverModeState {
  enabled: boolean;
  lastCapture: HoverCapture | null;
  lastAnalysis: HoverAnalysisResult | null;
  lastResponse: HoverResponse | null;
  isProcessing: boolean;
  lastChangeRatio: number;
}

export class HoverModeOrchestrator extends EventEmitter {
  private hoverManager: HoverModeManager;
  private classifier: HoverQuestionClassifier;
  private responder: HoverLLMResponder;
  private state: HoverModeState;
  private mouseTrackingInterval: NodeJS.Timeout | null = null;
  private lastProcessedImagePath: string | null = null;

  constructor(llmHelper: LLMHelper) {
    super();
    this.hoverManager = new HoverModeManager({ captureScope: 'display' });
    this.classifier = new HoverQuestionClassifier(llmHelper);
    this.responder = new HoverLLMResponder(llmHelper);

    this.state = {
      enabled: false,
      lastCapture: null,
      lastAnalysis: null,
      lastResponse: null,
      isProcessing: false,
      lastChangeRatio: 1,
    };

    this.setupHoverManagerEvents();
  }

  private setupHoverManagerEvents(): void {
    this.hoverManager.on('enabled-changed', (enabled: boolean) => {
      this.state.enabled = enabled;

      if (!enabled) {
        this.lastProcessedImagePath = null;
        this.state.lastChangeRatio = 1;
      }

      this.emit('state-changed', this.getState());

      if (enabled) {
        this.startMouseTracking();
      } else {
        this.stopMouseTracking();
      }
    });

    this.hoverManager.on('capture', async (capture: HoverCapture) => {
      this.state.lastCapture = capture;
      this.emit('capture', capture);

      const changeRatio = await this.computeContentChangeRatio(capture.path);
      this.state.lastChangeRatio = changeRatio;

      if (this.lastProcessedImagePath && changeRatio <= CHANGE_DETECTION_THRESHOLD) {
        this.emit('state-changed', this.getState());
        return;
      }

      this.state.isProcessing = true;
      this.emit('state-changed', this.getState());

      try {
        const analysis = await this.classifier.classify(capture);
        this.state.lastAnalysis = analysis;
        this.emit('analysis', analysis);

        const response = await this.responder.generateResponse(capture, analysis);
        this.state.lastResponse = response;
        this.lastProcessedImagePath = capture.path;
        this.state.isProcessing = false;

        this.emit('response', {
          ...response,
          cursorPosition: capture.cursorPosition,
        });
        this.emit('state-changed', this.getState());
      } catch (error) {
        this.state.isProcessing = false;
        console.error('[HoverModeOrchestrator] Processing error:', error);
        this.emit('error', error);
        this.emit('state-changed', this.getState());
      }
    });

    this.hoverManager.on('capture-error', (error: Error) => {
      this.emit('error', error);
    });
  }

  public setEnabled(enabled: boolean): void {
    this.hoverManager.setEnabled(enabled);
  }

  public isEnabled(): boolean {
    return this.hoverManager.isEnabled();
  }

  public getState(): HoverModeState {
    return { ...this.state };
  }

  private startMouseTracking(): void {
    if (this.mouseTrackingInterval) return;

    this.mouseTrackingInterval = setInterval(() => {
      if (!this.state.enabled || this.state.isProcessing) return;

      try {
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        this.hoverManager.updateMousePosition(point.x, point.y, display.id);
      } catch (error) {
        console.error('[HoverModeOrchestrator] Mouse tracking error:', error);
      }
    }, 100);
  }

  private stopMouseTracking(): void {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  public cleanup(): void {
    this.stopMouseTracking();
    this.lastProcessedImagePath = null;
    this.hoverManager.cleanup();
    this.removeAllListeners();
  }

  private async computeContentChangeRatio(currentPath: string): Promise<number> {
    if (!this.lastProcessedImagePath) {
      return 1;
    }

    try {
      const [current, previous] = await Promise.all([
        sharp(currentPath)
          .resize(CHANGE_DETECTION_SIZE.width, CHANGE_DETECTION_SIZE.height, { fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer(),
        sharp(this.lastProcessedImagePath)
          .resize(CHANGE_DETECTION_SIZE.width, CHANGE_DETECTION_SIZE.height, { fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer(),
      ]);

      if (current.length !== previous.length || current.length === 0) {
        return 1;
      }

      let changedPixels = 0;
      for (let i = 0; i < current.length; i++) {
        if (Math.abs(current[i] - previous[i]) >= PIXEL_DIFF_THRESHOLD) {
          changedPixels += 1;
        }
      }

      return changedPixels / current.length;
    } catch (error) {
      console.warn('[HoverModeOrchestrator] Change detection failed, forcing refresh:', error);
      return 1;
    }
  }
}

export default HoverModeOrchestrator;
