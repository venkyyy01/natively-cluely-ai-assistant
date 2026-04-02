import { execFile } from 'node:child_process';

export type ExecCommand = (command: string, args: string[]) => Promise<string>;

interface WindowEnumerationCommand {
  command: string;
  args: string[];
}

const WINDOWS_WINDOW_ENUMERATION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-Process |',
  '  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |',
  '  ForEach-Object { "{0}|{1}" -f $_.ProcessName, $_.MainWindowTitle }',
].join(' ');

const MACOS_WINDOW_ENUMERATION_SCRIPT = [
  'tell application "System Events"',
  'set windowLines to {}',
  'repeat with proc in (application processes whose background only is false)',
  'try',
  'repeat with win in windows of proc',
  'set end of windowLines to ((name of proc as text) & "|" & (name of win as text))',
  'end repeat',
  'end try',
  'end repeat',
  'return windowLines as string',
  'end tell',
].join('\n');

export function defaultExecCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => {
      const err = error as NodeJS.ErrnoException | null;
      if (err && String(err.code ?? '') !== '1') {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}

export function getWindowEnumerationCommand(platform: string): WindowEnumerationCommand | null {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', WINDOWS_WINDOW_ENUMERATION_SCRIPT],
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', MACOS_WINDOW_ENUMERATION_SCRIPT],
    };
  }

  return null;
}

export function findCaseInsensitiveMatches(haystack: string, needles: readonly string[]): string[] {
  const normalizedHaystack = haystack.toLowerCase();
  const matches: string[] = [];

  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    if (normalizedHaystack.includes(needle.toLowerCase()) && !matches.includes(needle)) {
      matches.push(needle);
    }
  }

  return matches;
}
