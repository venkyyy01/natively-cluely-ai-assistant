import { EventEmitter } from 'events';
import type { LLMHelper } from '../LLMHelper';
import { HoverModeManager, type HoverCapture } from './HoverModeManager';
import { HoverQuestionClassifier, type HoverAnalysisResult } from './HoverQuestionClassifier';
import { HoverLLMResponder, type HoverResponse } from './HoverLLMResponder';
import { screen } from 'electron';

export interface HoverModeState {
  enabled: boolean;
  lastCapture: HoverCapture | null;
  lastAnalysis: HoverAnalysisResult | null;
  lastResponse: HoverResponse | null;
  isProcessing: boolean;
}

export class HoverModeOrchestrator extends EventEmitter {
  private hoverManager: HoverModeManager;
  private classifier: HoverQuestionClassifier;
  private responder: HoverLLMResponder;
  private state: HoverModeState;
  private mouseTrackingInterval: NodeJS.Timeout | null = null;

  constructor(llmHelper: LLMHelper) {
    super();
    this.hoverManager = new HoverModeManager();
    this.classifier = new HoverQuestionClassifier(llmHelper);
    this.responder = new HoverLLMResponder(llmHelper);

    this.state = {
      enabled: false,
      lastCapture: null,
      lastAnalysis: null,
      lastResponse: null,
      isProcessing: false,
    };

    this.setupHoverManagerEvents();
  }

  private setupHoverManagerEvents(): void {
    this.hoverManager.on('enabled-changed', (enabled: boolean) => {
      this.state.enabled = enabled;
      this.emit('state-changed', this.getState());

      if (enabled) {
        this.startMouseTracking();
      } else {
        this.stopMouseTracking();
      }
    });

    this.hoverManager.on('capture', async (capture: HoverCapture) => {
      this.state.lastCapture = capture;
      this.state.isProcessing = true;
      this.emit('state-changed', this.getState());
      this.emit('capture', capture);

      try {
        const analysis = await this.classifier.classify(capture);
        this.state.lastAnalysis = analysis;
        this.emit('analysis', analysis);

        const response = await this.responder.generateResponse(capture, analysis);
        this.state.lastResponse = response;
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
    this.hoverManager.cleanup();
    this.removeAllListeners();
  }
}

export default HoverModeOrchestrator;
