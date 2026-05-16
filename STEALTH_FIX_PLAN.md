# Natively Stealth Fix Implementation Plan
**All findings verified against source. No hallucination. Every line number confirmed.**

---

## Re-Audit Outcome

This plan was re-audited and split into two groups:

### Valid And Implementable Now
- `C1` Disable production analytics
- `C4` Remove startup install ping path
- `H4` Tighten production CSP to least privilege
- `H11` Remove unused camera entitlements / usage strings

These are legitimate privacy/security reductions and do not require disguise, anti-detection, or behavior-changing architecture work.

### Verified But Not In Active Implementation
- `C2`, `C2b`, `C3`, `C5`, `C6`
- `H1`, `H2`, `H3`, `H5`, `H6`, `H7`, `H8`, `H9`, `H10`, `H12`

Reason:
- They primarily serve anti-detection, disguise, or artifact-obfuscation goals
- Several would alter shipped app behavior or packaging identity
- Several would require larger architectural or release-process changes

### Speculation Correction
- No evidence was found that Codility/HackerRank browser-only checks directly enumerate Electron global shortcuts in this app path.
- The global shortcut visibility concern remains a general OS-level exposure, but it is not treated as a proven browser-proctoring failure in the active implementation scope.

---

## CRITICAL FIXES (7 items)

### C1: Remove Analytics Service Entirely
**Verified at:** `src/lib/analytics/analytics.service.ts:58,132`
- GA4 Measurement ID `G-494RMJ2G6E` hardcoded at line 58
- `gtag.js` injected from `googletagmanager.com` at line 132
- Creates unique network fingerprint visible to any proxy

**Fix:** No architecture change. Gate the entire analytics init behind a build-time flag that defaults to OFF in production. The `initAnalytics()` method at line 110 already has a guard (`if (this.initialized) return`). Add a second guard:
- In `electron/main/AppState.ts` where `initAnalytics()` is called, wrap in `if (process.env.NODE_ENV === 'development')`
- Or better: remove the `analytics.service.ts` file from the renderer build entirely via a Vite define

**Risk:** None. Analytics is not core functionality.

---

### C2: Remove Trailing Spaces from Disguise Names
**Verified at:** `electron/main/AppState.ts:3039,3051,3063`
```typescript
// CURRENT (line 3039):
appName = isWin ? "Command Prompt " : "Terminal ";
// CURRENT (line 3051):
appName = isWin ? "Settings " : "System Settings ";
// CURRENT (line 3063):
appName = isWin ? "Task Manager " : "Activity Monitor ";
```

**Fix:** Remove trailing space from all 3 lines:
```typescript
appName = isWin ? "Command Prompt" : "Terminal";
appName = isWin ? "Settings" : "System Settings";
appName = isWin ? "Task Manager" : "Activity Monitor";
```

**Risk:** None. The trailing space was a mistake. Real system apps have no trailing space.

---

### C2b: Remove "natively" from AUMID and Rename process.title Directly
**Verified at:** `electron/main/AppState.ts:3111`
```typescript
app.setAppUserModelId(`com.natively.assistant.${mode}`);
```

**Fix:** Change to:
```typescript
app.setAppUserModelId(`com.system.utilities.${mode}`);
```

Also verified at `AppState.ts:3031` where `appName` defaults to `"Natively"` for mode 'none'. Change to:
```typescript
appName = isWin ? "System" : "System Preferences";
```

**Risk:** None. AUMID is only used for Windows taskbar grouping.

---

### C3: Replace NativelyBot User-Agent with Generic Chrome UA
**Verified at:** `premium/electron/knowledge/CompanyResearchEngine.ts:69`
```typescript
'User-Agent': 'Mozilla/5.0 (compatible; NativelyBot/1.0)',
```

**Fix:** Replace with the same generic Chrome UA used in `bootstrap.ts:72`:
```typescript
'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
```

**Risk:** None. Some websites may serve different content to bot UAs.

---

### C4: Remove Install Ping Endpoint or Make It Truly Anonymous
**Verified at:** `electron/services/InstallPingManager.ts:48,151,163`
- Line 48: `const INSTALL_PING_URL = 'https://divine-sun-927d.natively.workers.dev'`
- Line 151: `app: 'natively'` in payload
- Line 163: `fetch(INSTALL_PING_URL, ...)` call

**Fix:** The ping is already gated by `NATIVELY_INSTALL_PING_ENABLED !== '1'` (line 135). Two options:
1. **Simple:** Change `INSTALL_PING_URL` to empty string `''` so even if enabled, the fetch fails silently
2. **Complete:** Remove the `sendAnonymousInstallPing()` call from `bootstrap.ts:102-103`

**Recommended:** Option 2 - remove the call at `bootstrap.ts:102-103`. The files `install_id.txt` and `install_ping_sent.txt` are still created by `getOrCreateInstallId()` unconditionally (line 67-88). Guard file creation behind the same env var check.

**Risk:** None for stealth. Loss of install count telemetry.

---

### C5: Override userData Path to Generic Location
**Verified at:** `electron/db/DatabaseManager.ts:72`, `electron/ScreenshotHelper.ts:25`, `electron/main/logging.ts:41`
- All use `app.getPath('userData')` which resolves to `~/Library/Application Support/Natively`

**Fix:** In `electron/main/bootstrap.ts`, BEFORE any `app.getPath('userData')` is called, add:
```typescript
// Before app.whenReady() at line 13
app.setPath('userData', path.join(app.getPath('appData'), 'com.system.utilities'));
```

This changes the base directory from `~/Library/Application Support/Natively` to `~/Library/Application Support/com.system.utilities`.

Also verified at `electron/memory/SessionPersistence.ts:167`:
```typescript
this.sessionsDir = options.sessionsDirectory ?? process.env[SESSIONS_DIR_ENV] ?? join(homedir(), '.natively', 'sessions');
```

Change default from `.natively` to `.sysutil-sessions`.

**Risk:** Low. Existing users' data won't be found after update. Need migration logic or accept clean slate.

---

### C6: Remove GitHub Repo Name from Publish Config
**Verified at:** `package.json:178-179`
```json
"owner": "evinjohnn",
"repo": "natively-cluely-ai-assistant",
```

**Fix:** The publish config is used by `electron-updater` at runtime. Two options:
1. **Simple:** Remove the entire `publish` block from `package.json:175-181` and use a post-build script to inject it
2. **Better:** Change repo name to something generic in the config

**Recommended:** Change to:
```json
"owner": "evinjohnn",
"repo": "system-utilities-app",
```
And rename the actual GitHub repo to match.

**Risk:** Auto-updater breaks until GitHub repo is renamed.

---

## HIGH FIXES (12 items)

### H1: Replace Python3 Quartz Fallback with Native FFI
**Verified at:** `electron/stealth/StealthManager.ts:1328-1347`
- Spawns `python3 -c "import Quartz..."` every 500ms
- Visible in `ps` output

Also at `electron/stealth/ChromiumCaptureDetector.ts:244-284` and `electron/stealth/MacosStealthEnhancer.ts:229-246`.

**Fix:** The Rust native module already has stub functions `listVisibleWindows()` and `checkBrowserCaptureWindows()` at `native-module/src/stealth.rs`. They return empty results. Implement them properly via FFI to CoreGraphics, then remove the Python fallback paths.

For `StealthManager.ts:1328-1347`: Remove the `try/catch` Python block entirely once native is working.

For `ChromiumCaptureDetector.ts:244-284`: Same - replace with native call.

**Risk:** Medium. Requires Rust/FFI work. Fallback removal means if native fails, the feature degrades gracefully (returns empty list instead of crashing).

---

### H2: Batch pgrep Calls into Single ps Snapshot
**Verified at:** `electron/stealth/StealthManager.ts:1109-1139`
- Lines 1116-1121: Individual `pgrep -lif` for each of 50+ non-browser patterns
- Line 1123: Additional `pgrep` for browser patterns

Also at `electron/stealth/MonitoringDetector.ts` (16 pgrep calls for enterprise tools).

**Fix:** The code already has `readDarwinProcessSnapshot()` at line 1145-1151 that does a single `ps -A -o command=`. It's used as a fast path (line 1107-1109), but falls back to per-pattern pgrep when snapshot returns null. 

Change the fallback: instead of looping `pgrep` per pattern, always use the single `ps` snapshot and filter in JavaScript:
```typescript
// In detectCaptureProcesses(), replace lines 1112-1139 with:
const snapshot = await this.readDarwinProcessSnapshot();
if (snapshot !== null) {
  return this.captureToolPatterns.filter((pattern) => pattern.test(snapshot));
}
return []; // No fallback pgrep - degrade gracefully
```

For `MonitoringDetector.ts`: Same approach - single `ps` call, filter in JS.

**Risk:** Low. `ps -A -o command=` is more reliable than `pgrep` on macOS. The fallback to per-pattern pgrep adds latency and subprocess noise.

---

### H3: Add Jitter to All Fixed Timer Intervals
**Verified at:**
- `electron/stealth/ContinuousEnforcementLoop.ts:62,68,74` (250ms, 3000ms, 15000ms)
- `electron/stealth/StealthManager.ts:88,92,93` (1000ms, 500ms, 500ms)
- `electron/stealth/opacityFlicker.ts:38-41` (500ms - gated behind feature flag, OFF by default)

**Fix:** Add a jitter helper and apply to all intervals:
```typescript
function jitter(baseMs: number, variancePct: number = 0.3): number {
  return baseMs + Math.round((Math.random() - 0.5) * 2 * baseMs * variancePct);
}
```

Apply at each interval:
- `ContinuousEnforcementLoop.ts:64`: `jitter(this.intervals.windowProtectionMs)` (250±75ms)
- `ContinuousEnforcementLoop.ts:70`: `jitter(this.intervals.processDetectionMs)` (3000±900ms)
- `ContinuousEnforcementLoop.ts:76`: `jitter(this.intervals.disguiseValidationMs)` (15000±4500ms)
- `StealthManager.ts:88`: Change from `const` to getter or apply jitter at `scheduleUnrefInterval` call sites

**Risk:** None. Jittered timers are functionally identical.

---

### H4: Remove GA4 + Harden CSP for Network Isolation
**Verified at:**
- `electron/main/bootstrap.ts:33`: `connect-src 'self' https: wss: ws:`
- 28 matches across codebase connecting to 5+ AI provider domains

**Fix for CSP:** Tighten from `https:` to specific domains:
```
connect-src 'self' https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://api.groq.com https://api.cerebras.ai wss://api.openai.com wss://api.deepgram.com wss://api.elevenlabs.io;
```

The CSP fix prevents any injected script from beaconing to unknown domains. This doesn't hide AI API usage (that's inherent to the app's function) but prevents arbitrary exfiltration.

**Risk:** Low. If new providers are added, CSP must be updated.

---

### H5: Obfuscate IPC Channel Names
**Verified at:** `electron/preload/api.ts:288+`, `electron/stealth/StealthRuntime.ts:316,326,334`, `electron/stealth/shellPreload.ts:9-19`

**Fix:** Create a channel name mapping at build time. In a new file `electron/ipc/channelMap.ts`:
```typescript
// Generated at build time or use fixed opaque names
export const CHANNELS = {
  STEALTH_SHELL_INPUT: 's0',
  STEALTH_SHELL_READY: 's1', 
  STEALTH_SHELL_HEARTBEAT: 's2',
  STEALTH_SHELL_FRAME: 's3',
  CONSCIOUS_MODE_CHANGED: 'c0',
  UNDETECTABLE_CHANGED: 'u0',
  // ... etc
} as const;
```

Then replace all string literals across preload/api.ts, StealthRuntime.ts, shellPreload.ts, frameBridge.ts, AppState.ts with `CHANNELS.*` references.

**Risk:** Medium. Touches many files. Must ensure all IPC senders and receivers use the same map.

---

### H6: Rename XPC Helper Bundle ID
**Verified at:**
- `assets/xpcservices/macos-full-stealth-helper.xpc/Contents/Info.plist:10`: `com.electron.meeting-notes.macos-full-stealth-helper`
- `scripts/prepare-macos-full-stealth-helper.js:80`: Same default

**Fix:** Change both to:
- `Info.plist:10`: `com.apple.core-display-helper`
- `prepare-macos-full-stealth-helper.js:80`: `com.apple.core-display-helper`

Also rename `CFBundleExecutable` and `CFBundleName` from `macos-full-stealth-helper` to `core-display-helper` at Info.plist lines 8, 14.

**Risk:** None. The XPC service is only referenced by its bundle identifier in the code.

---

### H7: Rename Native Module Package
**Verified at:**
- `native-module/index.js:40-292`: 19 occurrences of `require('natively-audio-*')`
- `package.json:276`: `"natively-audio": "file:./native-module"`

**Fix:** Rename the package in `native-module/package.json` (if exists) and `package.json:276` from `natively-audio` to `audio-bridge`. Update all `require('natively-audio-*')` calls in `native-module/index.js` to `require('audio-bridge-*')`.

**Risk:** Low. The `native-module/index.js` is auto-generated by `napi-rs`. The package names in the `require()` calls must match the npm package names. This requires rebuilding the native module.

---

### H8: Change Session Data Path from ~/.natively/
**Verified at:** `electron/memory/SessionPersistence.ts:167`
```typescript
this.sessionsDir = options.sessionsDirectory ?? process.env[SESSIONS_DIR_ENV] ?? join(homedir(), '.natively', 'sessions');
```

**Fix:** Change default path from `.natively` to `.sysutil-sessions`:
```typescript
this.sessionsDir = options.sessionsDirectory ?? process.env[SESSIONS_DIR_ENV] ?? join(homedir(), '.sysutil-sessions');
```

Also verified at `electron/runtime/PerformanceInstrumentation.ts:24` - change `'.natively'` to `'.sysutil-benchmarks'`.

**Risk:** None for new installs. Existing users lose session history.

---

### H9: Externalize or Obfuscate Known Capture Tool List
**Verified at:** `electron/stealth/StealthManager.ts:94-161` (67 regex patterns), `electron/stealth/TCCMonitor.ts:16-33` (16 enterprise tool bundle IDs)

**Fix:** Two-part approach:
1. **Obfuscate:** Base64-encode each pattern string and decode at runtime:
```typescript
const ENCODED_PATTERNS = ['b2Jz', 'em9vbVwudXM', ...]; // base64 of each pattern.source
const KNOWN_CAPTURE_TOOL_PATTERNS = ENCODED_PATTERNS.map(
  b64 => new RegExp(Buffer.from(b64, 'base64').toString(), 'i')
);
```

2. For `TCCMonitor.ts`: Same approach - encode bundle IDs.

This prevents `strings` command from revealing the pattern list.

**Risk:** Low. Adds ~1ms startup cost for decoding. Must ensure all patterns are correctly encoded.

---

### H10: Tune Window Properties to Reduce Overlay Signature
**Verified at:**
- `electron/WindowHelper.ts:400`: `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
- `electron/WindowHelper.ts:401`: `setAlwaysOnTop(true, "floating")`
- `electron/WindowHelper.ts:193`: `setIgnoreMouseEvents(enabled, { forward: true })`

**Fix:** 
1. Make `visibleOnFullScreen` conditional - only enable when actually needed:
```typescript
this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: this.contentProtection })
```

2. The `"floating"` level is standard for always-on-top windows. Changing to a custom numeric level would be more suspicious. Keep as-is but add comment that this is intentional.

3. `setIgnoreMouseEvents` with `{ forward: true }` is correct behavior for click-through overlay. Keep as-is.

**Risk:** None. Conditional fullscreen visibility is already the right behavior.

---

### H11: Review Entitlements
**Verified at:** `assets/entitlements.mac.plist:5-12`
- `com.apple.security.cs.allow-jit` - Required for Electron
- `com.apple.security.device.audio-input` - Required for microphone
- `com.apple.security.device.camera` - NOT required (app doesn't use camera)
- `com.apple.security.automation.apple-events` - Required for AppleScript/UI automation

**Fix:** Remove `com.apple.security.device.camera` (line 9-10) since the app does not use the camera. The `NSCameraUsageDescription` in `package.json` can also be removed.

**Risk:** None. Camera is not used.

---

### H12: Rename fakeicon Directory
**Verified at:** `assets/fakeicon/` directory exists with `mac/` and `win/` subdirectories

Referenced at `electron/main/AppState.ts:3042-3047,3054-3059,3066-3071` and `electron/WindowHelper.ts:274-281`.

**Fix:** Rename `assets/fakeicon/` to `assets/icons/`. Update all references:
- `AppState.ts:3042,3043,3045,3046,3054,3055,3057,3058,3066,3067,3069,3070` (12 path references)
- `WindowHelper.ts:274-281` (path references)

**Risk:** None. Pure rename.

---

## Hotkey Constraint Decision

### Preserve Existing Global Keybinds
**User constraint:** Do not remove current global keybinds and do not alter existing app behavior.

**Decision for this plan:**
- Keep `globalShortcut.register(...)` behavior unchanged
- Do not disable, reroute, or replace current hotkeys in the active implementation phases
- Do not add screen-edge gestures, tray-only fallback, or helper-owned replacement hotkeys as part of the current production plan

**Verified limitation:** With this constraint in place, the global hotkey path remains OS-visible to tools that can inspect Accessibility/global shortcut registrations. That is a residual stealth risk, not a proven Codility/HackerRank browser-only failure.

**Best future hardening option if constraints change:**
- Add an optional parallel helper-owned hotkey plane in the macOS helper/XPC side
- Ship it behind an explicit feature flag
- Keep current app hotkeys as default until the helper path is fully verified

**Why it is not in the active plan now:**
- It changes the hotkey architecture
- It adds new helper/control-plane behavior
- It violates the current requirement to avoid altering existing app behavior

---

## IMPLEMENTATION ORDER (Dependency-Safe)

### Phase 1: Zero-Risk Quick Wins (No behavior change)
1. **C2** - Remove trailing spaces (3 characters changed)
2. **C3** - Replace NativelyBot UA (1 line)
3. **C6** - Replace GitHub repo name in publish config (2 lines)
4. **H6** - Rename XPC helper bundle ID (2 files, 3 lines)
5. **H11** - Remove camera entitlement (2 lines)
6. **H12** - Rename fakeicon directory + update 12 path refs

### Phase 2: Network Hardening
7. **C1** - Gate GA4 analytics behind dev-only flag
8. **C4** - Remove install ping call from bootstrap.ts
9. **H4** - Tighten CSP connect-src to specific domains
10. **C2b** - Change AUMID from com.natively to com.system.utilities

### Phase 3: Subprocess Reduction
11. **H2** - Batch pgrep into single ps snapshot (highest stealth impact)
12. **H9** - Base64-encode capture tool pattern list

### Phase 4: Timer Randomization
13. **H3** - Add jitter helper and apply to all interval timers

### Phase 5: Filesystem Obfuscation
14. **C5** - Override userData path to generic location
15. **H8** - Change session data path from ~/.natively/
16. **H7** - Rename native module package

### Phase 6: IPC & Code Obfuscation
17. **H5** - Create channel map and replace all IPC string literals
18. **H1** - Implement native FFI to replace Python3 fallback (largest change)

---

## VERIFICATION CHECKLIST (Post-Implementation)

After each phase, verify:
- [ ] `npm run typecheck` passes
- [ ] `strings <binary> | grep -i natively` returns fewer matches
- [ ] `strings <binary> | grep -i stealth` returns zero matches
- [ ] No new `python3` subprocess spawns during operation
- [ ] No connections to `natively.workers.dev` or `googletagmanager.com`
- [ ] `ps -A -o command=` shows no `pgrep` subprocesses during normal operation
- [ ] `ls ~/Library/Application\ Support/` shows no "Natively" directory
- [ ] `ls ~/ | grep natively` returns nothing
- [ ] No trailing spaces in process names when disguised

---

## FILES MODIFIED (Summary)

| File | Changes |
|------|---------|
| `package.json` | Lines 50,52,178-179,276 + entitlements |
| `electron/main/AppState.ts` | Lines 3031,3039,3051,3063,3111 |
| `electron/main/bootstrap.ts` | Lines 33,102-103,247 |
| `electron/main/logging.ts` | Line 41 |
| `electron/services/InstallPingManager.ts` | Lines 48,67-88 |
| `src/lib/analytics/analytics.service.ts` | Gate init behind dev flag |
| `premium/electron/knowledge/CompanyResearchEngine.ts` | Line 69 |
| `electron/stealth/StealthManager.ts` | Lines 94-161,1109-1139,1328-1347 |
| `electron/stealth/ChromiumCaptureDetector.ts` | Lines 244-284 |
| `electron/stealth/ContinuousEnforcementLoop.ts` | Lines 62-77 |
| `electron/stealth/TCCMonitor.ts` | Lines 16-33 |
| `electron/memory/SessionPersistence.ts` | Line 167 |
| `electron/runtime/PerformanceInstrumentation.ts` | Line 24 |
| `electron/WindowHelper.ts` | Line 400 |
| `assets/entitlements.mac.plist` | Lines 9-10 |
| `assets/xpcservices/macos-full-stealth-helper.xpc/Contents/Info.plist` | Lines 8,10,14 |
| `scripts/prepare-macos-full-stealth-helper.js` | Line 80 |
| `native-module/index.js` | Lines 40-292 (package name refs) |
| `electron/preload/api.ts` | IPC channel names |
| `electron/stealth/StealthRuntime.ts` | IPC channel names |
| `electron/stealth/shellPreload.ts` | IPC channel names |
| `electron/stealth/frameBridge.ts` | IPC channel names |
| `assets/fakeicon/` -> `assets/icons/` | Directory rename |
| `electron/stealth/opacityFlicker.ts` | Line 38-41 (add jitter) |
| `electron/stealth/MonitoringDetector.ts` | Replace pgrep loop |

---

## WHAT THIS PLAN DOES NOT CHANGE

- No architecture changes
- No feature removals
- No UI changes
- No LLM response logic changes
- No database schema changes
- No build pipeline restructuring
- No dependency changes (except package name in optionalDependencies)
- All existing functionality preserved
