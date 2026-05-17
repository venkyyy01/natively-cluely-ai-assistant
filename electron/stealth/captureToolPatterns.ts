/**
 * Consolidated capture tool pattern matching.
 *
 * Replaces 50+ individual regex entries in StealthManager with a single
 * combined regex and path-qualified matching for ambiguous patterns.
 *
 * False positives excluded: coreaudiod, chrome, screenshot, airplay
 * (Requirements 6.1, 6.2, 6.3, 6.4)
 */

export interface CaptureToolMatch {
  /** Whether the process matched a capture tool pattern */
  matched: boolean;
  /** Human-readable name of the matched tool, or null if no match */
  toolName: string | null;
  /** Whether the match requires executable path verification to confirm */
  requiresPathVerification: boolean;
}

/**
 * Known capture tool names mapped from regex pattern groups.
 * Order corresponds to alternation groups in CAPTURE_TOOL_REGEX.
 */
const TOOL_NAMES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /obs/i, name: 'OBS' },
  { pattern: /zoom\.us|zoom/i, name: 'Zoom' },
  { pattern: /microsoft teams|teams2|teams for enterprise/i, name: 'Microsoft Teams' },
  { pattern: /meet/i, name: 'Google Meet' },
  { pattern: /webex/i, name: 'Webex' },
  { pattern: /snipping/i, name: 'Snipping Tool' },
  { pattern: /screen ?studio/i, name: 'Screen Studio' },
  { pattern: /quicktime/i, name: 'QuickTime' },
  { pattern: /loom/i, name: 'Loom' },
  { pattern: /capture/i, name: 'Screen Capture' },
  { pattern: /sharex/i, name: 'ShareX' },
  { pattern: /greenshot/i, name: 'Greenshot' },
  { pattern: /flameshot/i, name: 'Flameshot' },
  { pattern: /discord/i, name: 'Discord' },
  { pattern: /slack/i, name: 'Slack' },
  { pattern: /ffmpeg/i, name: 'FFmpeg' },
  { pattern: /screencapture/i, name: 'screencapture' },
  { pattern: /vnc/i, name: 'VNC' },
  { pattern: /anydesk/i, name: 'AnyDesk' },
  { pattern: /teamviewer/i, name: 'TeamViewer' },
  { pattern: /screen ?recorder/i, name: 'Screen Recorder' },
  { pattern: /camtasia/i, name: 'Camtasia' },
  { pattern: /bandicam/i, name: 'Bandicam' },
  { pattern: /printwindow/i, name: 'PrintWindow' },
  { pattern: /chromium/i, name: 'Chromium' },
  { pattern: /msedge|microsoft edge/i, name: 'Microsoft Edge' },
  { pattern: /brave/i, name: 'Brave' },
  { pattern: /nvidia|shadowplay|geforce/i, name: 'NVIDIA ShadowPlay' },
  { pattern: /gamebar|xbox/i, name: 'Xbox Game Bar' },
  { pattern: /skype/i, name: 'Skype' },
  { pattern: /gotomeeting|goto/i, name: 'GoToMeeting' },
  { pattern: /bluejeans/i, name: 'BlueJeans' },
  { pattern: /jitsi/i, name: 'Jitsi' },
  { pattern: /parallels/i, name: 'Parallels' },
  { pattern: /vmware/i, name: 'VMware' },
  { pattern: /rdpclip|mstsc|remote desktop/i, name: 'Remote Desktop' },
  { pattern: /parsec/i, name: 'Parsec' },
  { pattern: /nomachine/i, name: 'NoMachine' },
  { pattern: /distant/i, name: 'Distant Desktop' },
  { pattern: /screenrecording/i, name: 'Screen Recording' },
  { pattern: /screencasting/i, name: 'Screencasting' },
  { pattern: /facet/i, name: 'Facet' },
  { pattern: /gather/i, name: 'Gather' },
  { pattern: /teramind/i, name: 'Teramind' },
  { pattern: /activtrak/i, name: 'ActivTrak' },
  { pattern: /time doctor/i, name: 'Time Doctor' },
  { pattern: /hubstaff/i, name: 'Hubstaff' },
  { pattern: /workpuls/i, name: 'Workpuls' },
  { pattern: /idletime/i, name: 'IdleTime' },
  { pattern: /screencastify/i, name: 'Screencastify' },
  { pattern: /vidyard/i, name: 'Vidyard' },
  { pattern: /wistia/i, name: 'Wistia' },
];

/**
 * Single combined regex replacing 50+ individual patterns.
 * Excludes false positives: coreaudiod, chrome, screenshot, airplay.
 *
 * The regex uses alternation groups for all legitimate capture tools.
 * Case-insensitive matching.
 */
export const CAPTURE_TOOL_REGEX: RegExp = new RegExp(
  [
    'obs',
    'zoom\\.us|zoom',
    'microsoft teams|teams2|teams for enterprise',
    'meet',
    'webex',
    'snipping',
    'screen ?studio',
    'quicktime',
    'loom',
    'capture',
    'sharex',
    'greenshot',
    'flameshot',
    'discord',
    'slack',
    'ffmpeg',
    'screencapture',
    'vnc',
    'anydesk',
    'teamviewer',
    'screen ?recorder',
    'camtasia',
    'bandicam',
    'printwindow',
    'chromium',
    'msedge|microsoft edge',
    'brave',
    'nvidia|shadowplay|geforce',
    'gamebar|xbox',
    'skype',
    'gotomeeting|goto',
    'bluejeans',
    'jitsi',
    'parallels',
    'vmware',
    'rdpclip|mstsc|remote desktop',
    'parsec',
    'nomachine',
    'distant',
    'screenrecording',
    'screencasting',
    'facet',
    'gather',
    'teramind',
    'activtrak',
    'time doctor',
    'hubstaff',
    'workpuls',
    'idletime',
    'screencastify',
    'vidyard',
    'wistia',
  ].map(p => `(?:${p})`).join('|'),
  'i'
);

/**
 * Patterns that require additional path verification before classifying
 * a process as a capture tool. These patterns are ambiguous because they
 * match common system processes or browsers that may not be performing capture.
 *
 * Key: regex pattern that triggers ambiguous matching
 * Value: array of known capture-tool executable paths that confirm the match
 */
export const AMBIGUOUS_PATTERNS: Map<RegExp, string[]> = new Map([
  [
    /chromium/i,
    [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
  ],
  [
    /msedge|microsoft edge/i,
    [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  ],
  [
    /brave/i,
    [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '/usr/bin/brave',
      '/usr/bin/brave-browser',
    ],
  ],
  [
    /meet/i,
    [
      '/Applications/Google Meet.app/Contents/MacOS/Google Meet',
    ],
  ],
  [
    /capture/i,
    [
      '/usr/sbin/screencapture',
      '/Applications/Screen Capture.app/Contents/MacOS/Screen Capture',
      'C:\\Windows\\System32\\SnippingTool.exe',
    ],
  ],
  [
    /goto/i,
    [
      '/Applications/GoToMeeting.app/Contents/MacOS/GoToMeeting',
      'C:\\Program Files (x86)\\Citrix\\GoToMeeting\\GoToMeeting.exe',
      'C:\\Program Files\\GoTo\\GoToMeeting\\GoToMeeting.exe',
    ],
  ],
]);

/**
 * False-positive patterns that are explicitly excluded from matching.
 * These are common system processes that should never trigger capture detection.
 */
const FALSE_POSITIVE_REGEX = /^(coreaudiod|chrome|screenshot|airplay)$/i;

/**
 * Match a process name against known capture tool patterns.
 *
 * @param processName - The process name to check
 * @param executablePath - Optional executable path for disambiguation of ambiguous patterns
 * @returns CaptureToolMatch result indicating match status and verification requirements
 */
export function matchCaptureToolProcess(
  processName: string,
  executablePath?: string
): CaptureToolMatch {
  // Check false positives first — these are never capture tools
  if (FALSE_POSITIVE_REGEX.test(processName)) {
    return { matched: false, toolName: null, requiresPathVerification: false };
  }

  // Check if the process matches the consolidated regex
  if (!CAPTURE_TOOL_REGEX.test(processName)) {
    return { matched: false, toolName: null, requiresPathVerification: false };
  }

  // Determine which tool matched and whether it's ambiguous
  for (const [ambiguousPattern, knownPaths] of AMBIGUOUS_PATTERNS) {
    if (ambiguousPattern.test(processName)) {
      // This is an ambiguous pattern — requires path verification
      if (executablePath) {
        const normalizedPath = executablePath.toLowerCase();
        const pathConfirmed = knownPaths.some(
          known => normalizedPath === known.toLowerCase()
        );
        if (pathConfirmed) {
          const toolName = resolveToolName(processName);
          return { matched: true, toolName, requiresPathVerification: false };
        }
        // Path provided but doesn't match known capture tool locations
        return { matched: false, toolName: null, requiresPathVerification: false };
      }
      // No path provided — flag as requiring verification
      const toolName = resolveToolName(processName);
      return { matched: true, toolName, requiresPathVerification: true };
    }
  }

  // Non-ambiguous match — confirmed capture tool
  const toolName = resolveToolName(processName);
  return { matched: true, toolName, requiresPathVerification: false };
}

/**
 * Resolve the human-readable tool name from a process name.
 */
function resolveToolName(processName: string): string {
  for (const entry of TOOL_NAMES) {
    if (entry.pattern.test(processName)) {
      return entry.name;
    }
  }
  return processName;
}
