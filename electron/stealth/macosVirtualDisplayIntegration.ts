import fs from 'node:fs';
import path from 'node:path';

import { MacosVirtualDisplayClient, MacosVirtualDisplayCoordinator } from './MacosVirtualDisplayClient';

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  resourcesPath?: string;
  pathExists?: (candidate: string) => boolean;
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function resolveMacosVirtualDisplayHelperPath(options: ResolveOptions = {}): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const pathExists = options.pathExists ?? ((candidate: string) => fs.existsSync(candidate));

  if (isEnvFlagEnabled(env.NATIVELY_DISABLE_MACOS_VIRTUAL_DISPLAY_HELPER)) {
    return null;
  }

  const envOverride = env.NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER;
  if (envOverride && pathExists(envOverride)) {
    return envOverride;
  }

  const candidates = [
    ...(resourcesPath
      ? [
          path.join(resourcesPath, '../XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper'),
          path.join(resourcesPath, '../XPCServices/macos-full-stealth-helper.xpc/macos-full-stealth-helper'),
        ]
      : []),
    ...(resourcesPath ? [path.join(resourcesPath, 'bin/macos/stealth-virtual-display-helper')] : []),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/debug/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/arm64-apple-macosx/debug/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/arm64-apple-macosx/release/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/x86_64-apple-macosx/debug/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/x86_64-apple-macosx/release/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-full-stealth-helper/.build/release/macos-full-stealth-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/arm64-apple-macosx/debug/stealth-virtual-display-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/arm64-apple-macosx/release/stealth-virtual-display-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/x86_64-apple-macosx/debug/stealth-virtual-display-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/x86_64-apple-macosx/release/stealth-virtual-display-helper'),
    path.join(cwd, 'stealth-projects/macos-virtual-display-helper/.build/release/stealth-virtual-display-helper'),
  ];

  return candidates.find((candidate) => pathExists(candidate)) ?? null;
}

export function createMacosVirtualDisplayCoordinator(helperPath: string): MacosVirtualDisplayCoordinator {
  return new MacosVirtualDisplayCoordinator(new MacosVirtualDisplayClient({ helperPath }));
}
