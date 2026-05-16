import { redactStealthSubstrings } from './logRedactor';

let installed = false;

export function installConsoleRedactor(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const redact = (args: unknown[]): unknown[] =>
    args.map(a => typeof a === 'string' ? redactStealthSubstrings(a) : a);

  console.log = (...args: unknown[]) => origLog(...redact(args));
  console.warn = (...args: unknown[]) => origWarn(...redact(args));
  console.error = (...args: unknown[]) => origError(...redact(args));
}
