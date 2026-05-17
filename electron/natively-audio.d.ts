declare module 'natively-audio' {
    export function getHardwareId(): string;
    export function verifyGumroadKey(key: string): Promise<string>;
    export function applyMacosWindowStealth(windowNumber: number): void;
    export function applyMacosPrivateWindowStealth(windowNumber: number): void;
    export function removeMacosWindowStealth(windowNumber: number): void;
    export function removeMacosPrivateWindowStealth(windowNumber: number): void;
    export function setMacosWindowLevel(windowNumber: number, level: number): void;
    export function applyWindowsWindowStealth(handle: Buffer): void;
    export function removeWindowsWindowStealth(handle: Buffer): void;
    export function applyWindowsNoActivate(handle: Buffer): void;
    export function clearWindowsNoActivate(handle: Buffer): void;
    export class MacosCursorHook {
        constructor();
        setOverlayBounds(x: number, y: number, width: number, height: number): void;
        setActive(active: boolean): void;
        start(callback: (jsonPayload: string) => void): void;
        stop(): void;
        isActive(): boolean;
    }
    /**
     * Cross-platform cursor hook (CGEventTap on macOS, WH_MOUSE_LL on
     * Windows). Same shape as MacosCursorHook — kept as a separate
     * declaration so both names resolve while we transition.
     */
    export class CursorHook {
        constructor();
        setOverlayBounds(x: number, y: number, width: number, height: number): void;
        setActive(active: boolean): void;
        start(callback: (jsonPayload: string) => void): void;
        stop(): void;
        isActive(): boolean;
    }
}
