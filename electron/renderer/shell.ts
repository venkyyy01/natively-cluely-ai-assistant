import type { StealthFramePayload, StealthInputEvent } from "../stealth/types";

export interface StealthShellBridge {
  onFrame(callback: (payload: StealthFramePayload) => void): () => void;
  sendInputEvent(event: StealthInputEvent): void;
  sendShortcutAction(actionId: string): void;
  notifyReady(): void;
  notifyHeartbeat(): void;
}

const SHELL_HEARTBEAT_INTERVAL_MS = 500;

const mapModifiers = (
	event: MouseEvent | KeyboardEvent | WheelEvent,
): Array<"shift" | "control" | "alt" | "meta"> => {
	const modifiers: Array<"shift" | "control" | "alt" | "meta"> = [];
	if (event.shiftKey) modifiers.push("shift");
	if (event.ctrlKey) modifiers.push("control");
	if (event.altKey) modifiers.push("alt");
	if (event.metaKey) modifiers.push("meta");
	return modifiers;
};

const shortcutActions: Record<string, string> = {
  'meta+1': 'chat:whatToAnswer',
  'control+1': 'chat:whatToAnswer',
  'meta+2': 'chat:shorten',
  'control+2': 'chat:shorten',
  'meta+3': 'chat:followUp',
  'control+3': 'chat:followUp',
  'meta+4': 'chat:recap',
  'control+4': 'chat:recap',
  'meta+5': 'chat:answer',
  'control+5': 'chat:answer',
  'meta+ArrowUp': 'chat:scrollUp',
  'meta+ArrowDown': 'chat:scrollDown',
  'meta+alt+ArrowUp': 'window:move-up',
  'meta+alt+ArrowDown': 'window:move-down',
  'meta+alt+ArrowLeft': 'window:move-left',
  'meta+alt+ArrowRight': 'window:move-right',
  'meta+alt+shift+v': 'general:toggle-visibility',
  'meta+b': 'general:toggle-visibility',
  'meta+Enter': 'general:process-screenshots',
  'control+Enter': 'general:process-screenshots',
  'meta+r': 'general:reset-cancel',
  'control+r': 'general:reset-cancel',
  'meta+shift+s': 'general:take-screenshot',
  'meta+alt+shift+s': 'general:take-screenshot',
  'meta+alt+shift+a': 'general:selective-screenshot',
};

const normalizeShortcutKey = (event: KeyboardEvent): string => {
  if (event.key.length === 1) {
    return event.key.toLowerCase();
  }
  return event.key;
};

const shortcutChord = (event: KeyboardEvent): string => {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push('meta');
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  modifiers.push(normalizeShortcutKey(event));
  return modifiers.join('+');
};

const consumeKeyboardEvent = (event: KeyboardEvent): void => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

export function mountStealthShell(bridge: StealthShellBridge, documentRef: Document = document): void {
  const canvas = documentRef.getElementById('stealth-shell-canvas');
  const loadingIndicator = documentRef.getElementById('loading-indicator');
  const consumedShortcutCodes = new Set<string>();
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing stealth shell canvas');
  }

	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Unable to create shell canvas context");
	}

	const drawFrame = (payload: StealthFramePayload) => {
		const image = new Image();
		image.onload = () => {
			canvas.width = payload.width;
			canvas.height = payload.height;
			context.clearRect(0, 0, payload.width, payload.height);
			context.drawImage(image, 0, 0, payload.width, payload.height);
			loadingIndicator?.classList.add("hidden");
		};
		image.src = payload.dataUrl;
	};

	const eventPoint = (event: MouseEvent | WheelEvent) => {
		const rect = canvas.getBoundingClientRect();
		return {
			x: Math.round(event.clientX - rect.left),
			y: Math.round(event.clientY - rect.top),
		};
	};

  canvas.addEventListener('mousedown', (event) => {
    const point = eventPoint(event);
    bridge.sendInputEvent({ kind: 'mouse', type: 'mouseDown', ...point, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clickCount: event.detail || 1, modifiers: mapModifiers(event) });
  });
  canvas.addEventListener('mouseup', (event) => {
    const point = eventPoint(event);
    bridge.sendInputEvent({ kind: 'mouse', type: 'mouseUp', ...point, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clickCount: event.detail || 1, modifiers: mapModifiers(event) });
  });
  canvas.addEventListener('mousemove', (event) => {
    const point = eventPoint(event);
    bridge.sendInputEvent({ kind: 'mouse', type: 'mouseMove', ...point, modifiers: mapModifiers(event) });
  });
  canvas.addEventListener('wheel', (event) => {
    const point = eventPoint(event);
    bridge.sendInputEvent({ kind: 'wheel', type: 'mouseWheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: mapModifiers(event) });
    event.preventDefault();
  }, { passive: false });
  window.addEventListener('focus', () => bridge.sendInputEvent({ kind: 'focus', type: 'focus' }));
  window.addEventListener('blur', () => bridge.sendInputEvent({ kind: 'focus', type: 'blur' }));
  window.addEventListener('keydown', (event) => {
    const actionId = shortcutActions[shortcutChord(event)];
    if (actionId) {
      consumedShortcutCodes.add(event.code);
      consumeKeyboardEvent(event);
      bridge.sendShortcutAction(actionId);
      return;
    }
    bridge.sendInputEvent({ kind: 'keyboard', type: 'keyDown', key: event.key, code: event.code, modifiers: mapModifiers(event) });
  });
  window.addEventListener('keyup', (event) => {
    const actionId = shortcutActions[shortcutChord(event)];
    if (actionId || consumedShortcutCodes.has(event.code)) {
      consumedShortcutCodes.delete(event.code);
      consumeKeyboardEvent(event);
      return;
    }
    bridge.sendInputEvent({ kind: 'keyboard', type: 'keyUp', key: event.key, code: event.code, modifiers: mapModifiers(event) });
  });

	bridge.onFrame(drawFrame);
	bridge.notifyReady();
	bridge.notifyHeartbeat();
	const heartbeatTimer = setInterval(() => {
		bridge.notifyHeartbeat();
	}, SHELL_HEARTBEAT_INTERVAL_MS);
	const timerHandle = heartbeatTimer as unknown as { unref?: () => void };
	timerHandle.unref?.();
}
