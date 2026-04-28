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
 * S-7: Dynamic userData path pattern for redaction.
 * Set via initRedactorWithUserDataPath() at app startup.
 */
let userDataPattern: RegExp | null = null;

/**
 * Substrings that, on their own, indicate stealth-related activity. Each
 * entry is rewritten to `[REDACTED]` (case-insensitive). Order does not
 * matter — every pattern is applied to every line.
 *
 * S-7: Added product name patterns:
 * - Natively, Cluely: App/product names that fingerprint the application
 * - natively-debug: Debug log patterns
 * - Application Support/Natively: Full userData path components
 * - .natively: Config file extensions
 * - processFailure: Kill switch function name
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
  // S-7: Product name redaction
  /\bNatively\b/gi,
  /\bCluely\b/gi,
  /\bnatively[-_]debug/gi,
  /Application Support\/Natively/gi,
  /Application Support\/Cluely/gi,
  /\.natively/gi,
  /processFailure/gi,
];

/**
 * S-7: Initialize the redactor with the userData path for dynamic redaction.
 * Must be called after app.whenReady() to get the correct path.
 */
export function initRedactorWithUserDataPath(userDataPath: string): void {
  const escaped = userDataPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  userDataPattern = new RegExp(escaped, 'gi');
}

/**
 * Strip stealth-related substrings from a log line. The line is otherwise
 * preserved verbatim, including any leading prefix like `[LOG]` or
 * `[CRITICAL]` and trailing newline.
 */
export function redactStealthSubstrings(line: string): string {
  let out = line;

  // Apply static patterns
  for (const pattern of STEALTH_SUBSTRING_PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }

  // S-7: Apply dynamic userData path pattern if initialized
  if (userDataPattern) {
    out = out.replace(userDataPattern, REDACTION_PLACEHOLDER);
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
