import type { StealthInputEvent, StealthKeyboardInputEvent } from './types';

interface InputTarget {
  sendInputEvent(event: Record<string, unknown>): void;
}

const mapModifiers = (modifiers: string[] | undefined): string[] => modifiers ?? [];

const isPrintableKey = (event: StealthKeyboardInputEvent): boolean => event.key.length === 1 && !event.modifiers?.includes('meta');

export class InputBridge {
  forward(target: InputTarget, event: StealthInputEvent): void {
    switch (event.kind) {
      case 'mouse':
        target.sendInputEvent({
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount: event.clickCount ?? 1,
          modifiers: mapModifiers(event.modifiers),
        });
        return;
      case 'wheel':
        target.sendInputEvent({
          type: event.type,
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: mapModifiers(event.modifiers),
        });
        return;
      case 'keyboard':
        target.sendInputEvent({
          type: event.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
          keyCode: event.key,
          code: event.code,
          modifiers: mapModifiers(event.modifiers),
        });
        if (event.type === 'keyDown' && isPrintableKey(event)) {
          target.sendInputEvent({
            type: 'char',
            keyCode: event.key,
            modifiers: mapModifiers(event.modifiers),
          });
        }
        return;
      case 'focus':
        target.sendInputEvent({ type: event.type });
        return;
      default:
        return;
    }
  }
}
