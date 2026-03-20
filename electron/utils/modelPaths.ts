import fs from 'fs';
import path from 'path';
import { app } from 'electron';

function existingDir(paths: string[]): string {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return paths[0];
}

export function resolveBundledModelsPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'models')]
    : [
        path.join(process.cwd(), 'resources', 'models'),
        path.join(app.getAppPath(), 'resources', 'models'),
        path.join(__dirname, '..', '..', 'resources', 'models'),
        path.join(__dirname, '..', '..', '..', 'resources', 'models'),
      ];

  return existingDir(candidates);
}
