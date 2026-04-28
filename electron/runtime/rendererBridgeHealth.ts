import type { BrowserWindow } from 'electron';

export type RendererBridgeHealthResult = 'ready' | 'reloading' | 'failed' | 'destroyed' | 'unprobeable';
export type RendererBridgeSettledResult = Exclude<RendererBridgeHealthResult, 'reloading'>;

type RendererBridgeMonitorOptions = {
  expectedPreloadPath: string;
  url: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  maxReloadAttempts?: number;
  onSettled?: (result: RendererBridgeSettledResult) => void;
};

type ProbeableWebContents = Electron.WebContents & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  reloadIgnoringCache?: () => void;
};

const bridgeReloadAttempts = new WeakMap<Electron.WebContents, number>();

const BRIDGE_PROBE_SCRIPT = `
  (() => {
    const api = window.electronAPI;
    return Boolean(api && (typeof api === 'object' || typeof api === 'function'));
  })();
`;

async function probeRendererBridge(
  label: string,
  window: BrowserWindow,
  options: RendererBridgeMonitorOptions,
): Promise<RendererBridgeHealthResult> {
  const logger = options.logger ?? console;
  const maxReloadAttempts = options.maxReloadAttempts ?? 1;
  const webContents = window.webContents as ProbeableWebContents;

  if (window.isDestroyed()) {
    logger.warn(`[RendererBridge] ${label} bridge probe skipped: window destroyed`);
    return 'destroyed';
  }

  if (typeof webContents.executeJavaScript !== 'function') {
    logger.warn(`[RendererBridge] ${label} bridge probe skipped: executeJavaScript unavailable`);
    return 'unprobeable';
  }

  try {
    const hasBridge = await webContents.executeJavaScript(BRIDGE_PROBE_SCRIPT, true);
    if (hasBridge === true) {
      logger.log(`[RendererBridge] ${label} bridge probe passed`);
      return 'ready';
    }
  } catch (error) {
    logger.error(`[RendererBridge] ${label} bridge probe threw:`, error);
  }

  const attempts = bridgeReloadAttempts.get(window.webContents) ?? 0;
  logger.error(
    `[RendererBridge] ${label} bridge probe failed (attempt ${attempts + 1}/${maxReloadAttempts + 1}) preload=${options.expectedPreloadPath} url=${options.url}`,
  );

  if (attempts < maxReloadAttempts && typeof webContents.reloadIgnoringCache === 'function') {
    bridgeReloadAttempts.set(window.webContents, attempts + 1);
    webContents.reloadIgnoringCache();
    return 'reloading';
  }

  return 'failed';
}

export function attachRendererBridgeMonitor(
  label: string,
  window: BrowserWindow,
  options: RendererBridgeMonitorOptions,
): () => void {
  const handleDidFinishLoad = () => {
    void probeRendererBridge(label, window, options).then((result) => {
      if (result === 'reloading') {
        return;
      }

      if (!window.isDestroyed()) {
        window.webContents.removeListener('did-finish-load', handleDidFinishLoad);
      }
      options.onSettled?.(result);
    });
  };

  window.webContents.on('did-finish-load', handleDidFinishLoad);
  return () => {
    if (!window.isDestroyed()) {
      window.webContents.removeListener('did-finish-load', handleDidFinishLoad);
    }
  };
}
