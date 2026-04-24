import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type WindowAssetResolverContext = {
  electronDir: string;
  nodeEnv?: string;
  isPackaged?: boolean;
  appPath?: string;
  resourcesPath?: string;
  fileExists?: (filePath: string) => boolean;
};

export type WindowAssetCandidates = {
  rendererEntry: string[];
  preload: string[];
  shellHtml: string[];
  shellPreload: string[];
};

const uniquePaths = (paths: string[]): string[] => {
  return Array.from(new Set(paths.filter((candidate) => candidate.length > 0)));
};

const safeExists = (filePath: string): boolean => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
};

const resolveResourcesPath = (appPath: string, explicitResourcesPath?: string): string => {
  if (explicitResourcesPath && explicitResourcesPath.length > 0) {
    return explicitResourcesPath;
  }

  const processResourcesPath = process.resourcesPath;
  if (processResourcesPath && processResourcesPath.length > 0) {
    return processResourcesPath;
  }

  if (appPath.endsWith('.asar')) {
    return path.dirname(appPath);
  }

  return path.resolve(appPath, '..');
};

const resolvePackagedAsarRoot = (appPath: string, resourcesPath: string): string => {
  return appPath.endsWith('.asar') ? appPath : path.join(resourcesPath, 'app.asar');
};

const resolveExistingPath = (
  candidates: string[],
  fileExists: (filePath: string) => boolean,
): string => {
  const deduped = uniquePaths(candidates);
  for (const candidate of deduped) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return deduped[0] ?? '';
};

export function getWindowAssetCandidates(context: WindowAssetResolverContext): WindowAssetCandidates {
  const appPath = context.appPath ?? app.getAppPath();
  const resourcesPath = resolveResourcesPath(appPath, context.resourcesPath);
  const electronDir = path.resolve(context.electronDir);
  const packagedAsarRoot = resolvePackagedAsarRoot(appPath, resourcesPath);
  const unpackedRoot = path.join(resourcesPath, 'app.asar.unpacked');
  const isPackaged = context.isPackaged ?? app.isPackaged;

  const rendererEntryCandidates = isPackaged
    ? [
        path.join(packagedAsarRoot, 'dist', 'index.html'),
        path.join(appPath, 'dist', 'index.html'),
      ]
    : [
        path.join(appPath, 'dist', 'index.html'),
        path.join(packagedAsarRoot, 'dist', 'index.html'),
      ];

  const preloadCandidates = isPackaged
    ? [
        path.join(unpackedRoot, 'dist-electron', 'electron', 'preload.js'),
        path.join(electronDir, 'preload.js'),
        path.join(packagedAsarRoot, 'dist-electron', 'electron', 'preload.js'),
        path.join(appPath, 'dist-electron', 'electron', 'preload.js'),
      ]
    : [
        path.join(electronDir, 'preload.js'),
        path.join(appPath, 'dist-electron', 'electron', 'preload.js'),
        path.join(unpackedRoot, 'dist-electron', 'electron', 'preload.js'),
        path.join(packagedAsarRoot, 'dist-electron', 'electron', 'preload.js'),
      ];

  const shellHtmlCandidates = isPackaged
    ? [
        path.join(packagedAsarRoot, 'electron', 'renderer', 'shell.html'),
        path.join(appPath, 'electron', 'renderer', 'shell.html'),
      ]
    : [
        path.join(appPath, 'electron', 'renderer', 'shell.html'),
        path.join(packagedAsarRoot, 'electron', 'renderer', 'shell.html'),
      ];

  const shellPreloadCandidates = isPackaged
    ? [
        path.join(unpackedRoot, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
        path.join(electronDir, 'stealth', 'shellPreload.js'),
        path.join(packagedAsarRoot, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
        path.join(appPath, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
      ]
    : [
        path.join(electronDir, 'stealth', 'shellPreload.js'),
        path.join(appPath, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
        path.join(unpackedRoot, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
        path.join(packagedAsarRoot, 'dist-electron', 'electron', 'stealth', 'shellPreload.js'),
      ];

  return {
    rendererEntry: uniquePaths(rendererEntryCandidates),
    preload: uniquePaths(preloadCandidates),
    shellHtml: uniquePaths(shellHtmlCandidates),
    shellPreload: uniquePaths(shellPreloadCandidates),
  };
}

export function resolveRendererStartUrl(context: WindowAssetResolverContext): string {
  const nodeEnv = context.nodeEnv ?? process.env.NODE_ENV;
  const isPackaged = context.isPackaged ?? app.isPackaged;
  if (nodeEnv === 'development' && !isPackaged) {
    return 'http://localhost:5180';
  }

  const fileExists = context.fileExists ?? safeExists;
  const entryPath = resolveExistingPath(getWindowAssetCandidates(context).rendererEntry, fileExists);
  return pathToFileURL(entryPath).toString();
}

export function resolveRendererPreloadPath(context: WindowAssetResolverContext): string {
  const fileExists = context.fileExists ?? safeExists;
  return resolveExistingPath(getWindowAssetCandidates(context).preload, fileExists);
}

export function resolveStealthShellHtmlPath(context: WindowAssetResolverContext): string {
  const fileExists = context.fileExists ?? safeExists;
  return resolveExistingPath(getWindowAssetCandidates(context).shellHtml, fileExists);
}

export function resolveStealthShellPreloadPath(context: WindowAssetResolverContext): string {
  const fileExists = context.fileExists ?? safeExists;
  return resolveExistingPath(getWindowAssetCandidates(context).shellPreload, fileExists);
}
