// electron/stealth/logRedactor.ts
//
// NAT-011 / audit S-5: any line we *do* end up writing to disk must not
// betray that the host is running Natively in stealth mode. This redactor
// strips known stealth-related substrings *before* they are appended to the
// log file, so an attacker (or, more realistically, a curious end user
// browsing their own filesystem) cannot grep `~/Library/Logs` for
// stealth-revealing strings.
//
// The redactor is intentionally conservative: it only rewrites strings that
// directly identify stealth subsystems, virtual-display helpers, screen
// capture detection, opacity-flicker fingerprints, etc. Generic strings
// (timestamps, error messages from non-stealth modules) pass through
// unchanged so debugging release builds remains feasible when the operator
// explicitly enables file logging via `NATIVELY_DEBUG_LOG=1`.

const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Substrings that, on their own, indicate stealth-related activity. Each
 * entry is rewritten to `[REDACTED]` (case-insensitive). Order does not
 * matter — every pattern is applied to every line.
 */
const STEALTH_SUBSTRING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bStealth(?:Manager|Supervisor|Runtime|ArmController|StateMachine|Bridge|Enhancer)?\b/gi,
  /\bMacosStealthEnhancer\b/gi,
  /\bNativeStealthBridge\b/gi,
  /\bMacosVirtualDisplay\w*\b/gi,
  /\bvirtual[- ]display\b/gi,
  /\bcapture[- ]bypass\b/gi,
  /\bopacity[- ]flicker\b/gi,
  /\bSCStream(?:Monitor|Detection)?\b/gi,
  /\bChromiumCaptureDetector\b/gi,
  /\bTCCMonitor\b/gi,
  /\bsetContentProtection\b/gi,
  /\bsetExcludeFromCapture\b/gi,
  /\bisUndetectable\b/gi,
  /\bprivacy[- ]shield\b/gi,
  /\bfull[- ]stealth\b/gi,
  /\bfoundation[- ]intent\b/gi,
];

/**
 * Strip stealth-related substrings from a log line. The line is otherwise
 * preserved verbatim, including any leading prefix like `[LOG]` or
 * `[CRITICAL]` and trailing newline.
 */
export function redactStealthSubstrings(line: string): string {
  let out = line;
  for (const pattern of STEALTH_SUBSTRING_PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return out;
}

/**
 * Exposed for tests so a future ticket can extend the redaction list
 * without inverting the test hierarchy.
 */
export function getStealthRedactionPatternsForTesting(): ReadonlyArray<RegExp> {
  return STEALTH_SUBSTRING_PATTERNS;
}
