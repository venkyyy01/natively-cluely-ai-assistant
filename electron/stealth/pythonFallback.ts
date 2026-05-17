export type SubprocessError = NodeJS.ErrnoException & { stderr?: string };

export function withStderr(error: Error | null, stderr: string): SubprocessError | null {
  if (!error) {
    return null;
  }

  const decorated = error as SubprocessError;
  if (stderr) {
    decorated.stderr = stderr;
  }
  return decorated;
}

export function getProcessErrorSummary(error: unknown): string {
  if (!error) {
    return 'unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  const err = error as SubprocessError;
  const parts = [err.message, err.stderr].filter((value): value is string => !!value && value.trim().length > 0);

  if (parts.length > 0) {
    return parts.join(' | ');
  }

  return String(error);
}

export function getOptionalPythonFallbackReason(error: unknown): string | null {
  const err = error as SubprocessError;
  const summary = getProcessErrorSummary(error).toLowerCase();

  if (err?.code === 'ENOENT' || summary.includes('command not found')) {
    return 'python3 is not installed';
  }

  if (err?.code === 'EACCES' || summary.includes('permission denied')) {
    return 'python3 is unavailable';
  }

  if (summary.includes('bad cpu type')) {
    return 'python3 binary is incompatible';
  }

  if (
    summary.includes('modulenotfounderror') ||
    summary.includes('no module named') ||
    summary.includes('importerror')
  ) {
    if (
      summary.includes('quartz') ||
      summary.includes('objc') ||
      summary.includes('pyobjc')
    ) {
      return 'Quartz/PyObjC is unavailable';
    }
    return 'required python modules are unavailable';
  }

  if (summary.includes('pyobjc')) {
    return 'PyObjC is unavailable';
  }

  return null;
}
