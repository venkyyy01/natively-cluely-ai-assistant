import * as path from "path";

export function resolvePathInsideDirectory(rootDir: string, filePath: string): string | null {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);

  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

export function resolveUserDataFilePath(userDataDir: string, filePath: string): string | null {
  return resolvePathInsideDirectory(userDataDir, filePath);
}

export function resolveUserDataFilePaths(userDataDir: string, filePaths?: string[]): string[] | undefined {
  if (!filePaths) {
    return undefined;
  }

  return filePaths.map((filePath) => {
    const resolved = resolveUserDataFilePath(userDataDir, filePath);
    if (!resolved) {
      throw new Error("PATH_NOT_ALLOWED");
    }
    return resolved;
  });
}
