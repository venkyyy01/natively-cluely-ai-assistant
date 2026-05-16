import type { IpcMainInvokeEvent } from 'electron';

export type SafeHandle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any,
) => void;

export type SafeHandleValidated = <T extends unknown[]>(
  channel: string,
  parser: (args: unknown[]) => T,
  listener: (event: IpcMainInvokeEvent, ...args: T) => Promise<any> | any,
) => void;
