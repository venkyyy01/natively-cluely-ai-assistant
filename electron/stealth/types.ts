export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StealthFramePayload {
  dataUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  dirtyRects: DirtyRect[];
}

export type StealthMouseEventType = 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave';
export type StealthWheelEventType = 'mouseWheel';
export type StealthKeyboardEventType = 'keyDown' | 'keyUp';
export type StealthFocusEventType = 'focus' | 'blur';

export interface StealthMouseInputEvent {
  kind: 'mouse';
  type: StealthMouseEventType;
  x: number;
  y: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta' | 'leftButtonDown' | 'middleButtonDown' | 'rightButtonDown'>;
}

export interface StealthWheelInputEvent {
  kind: 'wheel';
  type: StealthWheelEventType;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>;
}

export interface StealthKeyboardInputEvent {
  kind: 'keyboard';
  type: StealthKeyboardEventType;
  key: string;
  code: string;
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>;
}

export interface StealthFocusInputEvent {
  kind: 'focus';
  type: StealthFocusEventType;
}

export type StealthInputEvent =
  | StealthMouseInputEvent
  | StealthWheelInputEvent
  | StealthKeyboardInputEvent
  | StealthFocusInputEvent;

export interface StealthShellBounds {
  width: number;
  height: number;
}
