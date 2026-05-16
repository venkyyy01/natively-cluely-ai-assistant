"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mountStealthShell = mountStealthShell;
const mapModifiers = (event) => {
    const modifiers = [];
    if (event.shiftKey)
        modifiers.push('shift');
    if (event.ctrlKey)
        modifiers.push('control');
    if (event.altKey)
        modifiers.push('alt');
    if (event.metaKey)
        modifiers.push('meta');
    return modifiers;
};
function mountStealthShell(bridge, documentRef = document) {
    const canvas = documentRef.getElementById('stealth-shell-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Missing stealth shell canvas');
    }
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Unable to create shell canvas context');
    }
    const drawFrame = (payload) => {
        const image = new Image();
        image.onload = () => {
            canvas.width = payload.width;
            canvas.height = payload.height;
            context.clearRect(0, 0, payload.width, payload.height);
            context.drawImage(image, 0, 0, payload.width, payload.height);
        };
        image.src = payload.dataUrl;
    };
    const eventPoint = (event) => {
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
        bridge.sendInputEvent({ kind: 'keyboard', type: 'keyDown', key: event.key, code: event.code, modifiers: mapModifiers(event) });
    });
    window.addEventListener('keyup', (event) => {
        bridge.sendInputEvent({ kind: 'keyboard', type: 'keyUp', key: event.key, code: event.code, modifiers: mapModifiers(event) });
    });
    bridge.onFrame(drawFrame);
    bridge.notifyReady();
}
//# sourceMappingURL=shell.js.map