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
}
