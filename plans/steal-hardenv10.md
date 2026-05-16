# Ghost-Mode Stealth Hardening — Ticketed Implementation Plan v10

> **Scope**: Fail-proof ghost operation on macOS + Windows 11. All features preserved. Zero regressions.
> **Methodology**: 30-pass adversarial audit → 3-pass self-evaluation → cross-platform verification.

---

## Platform Coverage Matrix

| Component | macOS | Win11 | Detection Vector |
|-----------|:-----:|:-----:|-----------------|
| `StealthManager.detectCaptureProcesses` | `ps`/`pgrep` | `tasklist` | Child process spawn |
| `MonitoringDetector` | 16-tool `pgrep` loop | No-op | Child process spawn |
| `TCCMonitor` | `sqlite3` + `pgrep` | No-op | Child process spawn |
| `ChromiumCaptureDetector` | `pgrep`/`ps`/`python3` | No-op | Child process + string leak |
| Tray tooltip / menu | Both | Both | String exposure |
| `app.setAppUserModelId` | N/A | Active | Registry string |
| `console.log` stealth strings | Both | Both | stdout capture |
| `process.title` disguise | Both | Both | Binary path reversal |

---

## TIER 0 — CRITICAL (P0)

---

### T-001: Replace Child Process Spawning With Native FFI

**Priority**: P0 | **Platform**: macOS + Windows | **Risk**: 🟢 LOW

#### Problem

Three modules spawn detectable child processes on every poll cycle:

| Module | File | Call | Frequency |
|--------|------|------|-----------|
| `MonitoringDetector` | `electron/stealth/MonitoringDetector.ts:103` | `pgrep -lf <bundleId>` × 16 tools | Every 2s |
| `TCCMonitor` | `electron/stealth/TCCMonitor.ts:96-98` | `sqlite3 /Library/.../TCC.db` | Every 2s |
| `TCCMonitor` | `electron/stealth/TCCMonitor.ts:137` | `pgrep -lf <bundleId>` × 16 tools | Every 2s |
| `StealthManager` | `electron/stealth/StealthManager.ts:1268` | `tasklist /FO CSV /NH` (Windows) | Every 1s |
| `StealthManager` | `electron/stealth/StealthManager.ts:1313` | `ps -A -o command=` (macOS) | Every 1s |

A proctoring tool monitoring `posix_spawn`/`CreateProcessW` sees 30+ child processes per minute.

#### Steps

1. **Rust FFI — macOS** (`native-module/src/stealth.rs`):
   - Add `pub fn get_running_processes() -> Vec<ProcessInfo>` using `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_ALL)`
   - Return struct: `{ pid: u32, ppid: u32, name: String }`
   - Export via `#[napi]` as `getRunningProcesses()`

2. **Rust FFI — Windows** (`native-module/src/stealth.rs`):
   - Add `#[cfg(windows)] pub fn get_running_processes_win32()` using `CreateToolhelp32Snapshot` + `Process32First/Next`
   - Same return shape as macOS

3. **MonitoringDetector.ts** — replace `checkProcess()`:
   ```
   // BEFORE (line 101-117): execFile('pgrep', ['-lf', bundleId], ...)
   // AFTER: const procs = nativeModule.getRunningProcesses();
   //        return procs.find(p => p.name.includes(bundleId)) ?? null;
   ```
   - Remove `import { execFile } from 'node:child_process'`

4. **TCCMonitor.ts** — replace `checkTCCDatabase()`:
   ```
   // BEFORE (line 96-98): execFile('sqlite3', [TCC_DB_PATH, SQL], ...)
   // AFTER: const db = new Database(TCC_DB_PATH, { readonly: true, fileMustExist: true });
   //        const rows = db.prepare(SQL).all(); db.close();
   ```
   - Replace `checkEnterpriseTools()` with same native process list approach
   - Remove `import { execFile } from 'node:child_process'`

5. **StealthManager.ts** — replace `detectCaptureProcesses()` (line 1266-1309):
   - macOS: Replace `readDarwinProcessSnapshot()` (`ps -A`) with `getRunningProcesses()`
   - Windows: Replace `tasklist /FO CSV /NH` with `getRunningProcessesWin32()`
   - Keep `captureToolPatterns` regex matching — just operate on process names from native list

6. **StealthManager.ts** — replace `defaultProcessEnumerator` (line 191-208):
   - This function wraps `execFile`. After all callers are converted, delete it entirely
   - Remove `import { execFile } from 'node:child_process'` from line 7

#### Acceptance

```bash
grep -rn "execFile\|child_process" electron/stealth/MonitoringDetector.ts  # 0 results
grep -rn "execFile\|child_process" electron/stealth/TCCMonitor.ts          # 0 results
grep -rn "pgrep\|tasklist" electron/stealth/StealthManager.ts              # 0 results (in detection paths)
npm test  # all existing tests pass
```

#### Regression Guard

- `MonitoringDetector` constructor accepts `execFileFn` via DI — tests mock it. New code uses injected `nativeModule` instead (same DI pattern).
- `TCCMonitor` tests mock `execFile` — convert to mock `Database` constructor.
- `StealthManager` tests inject `processEnumerator` — convert to inject native module mock.

---

### T-002: Remove Python3 Fallback From ChromiumCaptureDetector

**Priority**: P0 | **Platform**: macOS only | **Risk**: 🟢 LOW

#### Problem

`electron/stealth/ChromiumCaptureDetector.ts` lines 258-332 contain an inline Python3 script with strings `meet.google.com`, `zoom.us`, `Quartz.CGWindowListCopyWindowInfo`. Even though `StealthFallbackPolicy` blocks execution in production, the **strings exist in the binary** and are discoverable via `strings` dump.

#### Steps

1. **Delete lines 258-332** in `ChromiumCaptureDetector.ts` — the entire Python fallback block starting from `const pythonPolicy = decideStealthFallback(...)` through the end of `checkBrowserWindowTitleCapture()`

2. **Replace with safe default**:
   ```typescript
   // After the native try/catch block (line 253), simply:
   this.logger.log('[ChromiumCaptureDetector] Native module unavailable; assuming no browser capture');
   return false;
   ```

3. **Remove unused imports** from `ChromiumCaptureDetector.ts` line 5-8:
   - Remove `getOptionalPythonFallbackReason`, `getProcessErrorSummary` imports from `./pythonFallback`
   - Remove `decideStealthFallback` import from `./StealthFallbackPolicy`
   - Keep `withStderr` only if still used by `execPromise` (it is — line 338)

4. **Remove `pythonFallbackNotices` field** (line 58) — no longer needed after Python path deletion

#### Acceptance

```bash
grep -n "python3\|Quartz\|CGWindowList\|meet\.google\.com" electron/stealth/ChromiumCaptureDetector.ts  # 0 results
npm test
```

---

### T-003: Replace pgrep/ps in ChromiumCaptureDetector

**Priority**: P0 | **Platform**: macOS only | **Risk**: 🟢 LOW

#### Problem

`detectBrowserProcesses()` (line 119-159) calls `pgrep` for 6 browsers. `checkScreenCaptureAgentParentage()` (line 207-232) chains `pgrep` → `ps -o ppid=` → `ps -o comm=`. Up to 9 child process spawns per 500ms cycle.

#### Steps

1. **Inject native process list** — add `nativeProcessList` to constructor options:
   ```typescript
   private readonly getProcessList: () => Array<{pid: number; ppid: number; name: string}>;
   ```
   Default to `() => nativeModule?.getRunningProcesses?.() ?? []` (reuse T-001's FFI).

2. **Replace `detectBrowserProcesses()`** — single native call + in-memory filter:
   ```typescript
   const procs = this.getProcessList();
   for (const browser of BROWSER_PATTERNS) {
     const matches = procs.filter(p => browser.pattern.test(p.name));
     for (const m of matches) {
       newDetected.set(`${browser.name}-${m.pid}`, { pid: m.pid, name: browser.name, bundleId: browser.bundleId });
     }
   }
   ```

3. **Replace `checkScreenCaptureAgentParentage()`** — in-memory parentage walk:
   ```typescript
   const procs = this.getProcessList();
   const scAgent = procs.find(p => /ScreenCaptureAgent/i.test(p.name));
   if (!scAgent) return false;
   const parent = procs.find(p => p.pid === scAgent.ppid);
   if (!parent) return false;
   return BROWSER_PATTERNS.some(b => b.pattern.test(parent.name));
   ```

4. **Delete `execPromise` method** (line 335-346) — no longer needed after all callers converted.

5. **Remove `import { execFile } from 'node:child_process'`** (line 1).

#### Acceptance

```bash
grep -n "execFile\|child_process\|pgrep\|execPromise" electron/stealth/ChromiumCaptureDetector.ts  # 0 results
npm test
```

---

### T-004: Intercept Console Output for Stealth Strings

**Priority**: P0 | **Platform**: Both | **Risk**: 🟡 MEDIUM

#### Problem

Hundreds of `console.log('[StealthManager] ...')`, `console.warn('[NativeStealthBridge] ...')` calls write unredacted stealth strings to stdout/stderr.

#### Steps

1. **Create `electron/stealth/consoleRedactor.ts`**:
   ```typescript
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
   ```

2. **Install early** in `electron/main/index.ts` (or equivalent entry point):
   ```typescript
   if (process.env.NATIVELY_STRICT_PROTECTION === '1') {
     installConsoleRedactor();
   }
   ```

3. **Add new patterns** to `logRedactor.ts` `STEALTH_SUBSTRING_PATTERNS`:
   - `/\[AudioHealth\]/gi`
   - `/\[MicrophoneCapture\]/gi`
   - `/\[SystemAudioCapture\]/gi`
   - `/pgrep/gi`
   - `/tasklist/gi`
   - `/CGS\w*/gi`

#### Acceptance

```bash
NATIVELY_STRICT_PROTECTION=1 npm start 2>&1 | grep -i "stealth\|natively\|cluely\|capture"  # 0 results
npm test  # verify console.log({obj: 'val'}) passes through unchanged
```

#### Regression Guard

- Only activates when `NATIVELY_STRICT_PROTECTION=1` — zero impact on default dev/production behavior
- Non-string arguments (objects, Errors) pass through unmodified

---

### T-005: Binary Path Fingerprinting Mitigation

**Priority**: P0 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`process.title = appName` changes `ps` output but `proc_pidpath()` (macOS) or `QueryFullProcessImageNameW` (Windows) reveals the real binary path containing "Natively".

#### Steps

1. **Build-time**: Add `NATIVELY_BUNDLE_NAME` env var to `electron-builder` config. When set, use it as the `.app`/`.exe` name.

2. **macOS Info.plist**: Add `LSUIElement=true` when `NATIVELY_DEFAULT_STEALTH=1` is set at build time (hides from Dock/Cmd+Tab at OS level).

3. **Documentation**: Add `docs/stealth-deployment.md` explaining that maximum stealth requires renaming the `.app` bundle.

#### Acceptance

- Build script accepts `NATIVELY_BUNDLE_NAME` and produces renamed binary
- Documentation exists

---

### T-006: Tray Tooltip and Menu Hardcode "Natively"

**Priority**: P0 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`electron/main/AppState.ts` lines 2805 and 2827: `tray.setToolTip('Natively')`. Menu has `'Show Natively'`.

#### Steps

1. **AppState.ts line 2805**: `this.tray.setToolTip(process.title.trim())`
2. **AppState.ts line 2827**: same
3. **AppState.ts line 2848**: `label: \`Show ${process.title.trim()}\``
4. **AppState.ts `showTray()` line 2767**: Add early return guard:
   ```typescript
   if (this.isUndetectable) return;
   ```

#### Acceptance

```bash
grep -n "'Natively'" electron/main/AppState.ts  # only in 'none' disguise case (line ~3478)
npm test
```

---

### T-007: `setAppUserModelId` Contains "natively"

**Priority**: P0 | **Platform**: Windows only | **Risk**: 🟢 LOW

#### Problem

`electron/main/AppState.ts` line 3514: `app.setAppUserModelId('com.natively.assistant.${mode}')`.

#### Steps

1. **Create AUMID map**:
   ```typescript
   const DISGUISE_AUMID: Record<string, string> = {
     terminal: 'Microsoft.WindowsTerminal',
     settings: 'windows.immersivecontrolpanel',
     activity: 'Microsoft.Windows.TaskManager',
     none: 'com.natively.assistant',
   };
   ```

2. **Line 3514**: `app.setAppUserModelId(DISGUISE_AUMID[mode] ?? DISGUISE_AUMID.none);`

#### Acceptance

```bash
# With disguise active, no "natively" in AUMID
grep -n "com.natively" electron/main/AppState.ts  # only in 'none' AUMID map entry
npm test
```

---

## TIER 1 — HIGH (P1)

---

### T-008: Kill Switch Bypasses Graceful Shutdown

**Priority**: P1 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`electron/stealth/ContinuousEnforcementLoop.ts` calls `this.exitFn(1)` (defaults to `process.exit(1)`), bypassing `GracefulShutdownManager`. Leaves SQLite WAL files and locked audio devices.

#### Steps

1. **ContinuousEnforcementLoop.ts** — change `exitFn` default:
   ```typescript
   // BEFORE: private readonly exitFn: (code: number) => never = process.exit;
   // AFTER:
   private readonly exitFn: (code: number, reason: string) => void = (code, reason) => {
     gracefulShutdown.shutdown(code, reason).catch(() => {
       setTimeout(() => process.exit(code), 3000);
     });
   };
   ```

2. **Update call sites** in `handleCriticalThreat` and `recordViolation` to pass reason string.

#### Acceptance

- After enforcement exit: `ls ~/Library/Application\ Support/Natively/*.wal` returns empty
- `npm test`

---

### T-009: MicrophoneCapture.stop() Deadlock Risk

**Priority**: P1 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`native-module/src/lib.rs` ~line 651: `handle.join()` without timeout. `SystemAudioCapture` correctly uses `join_thread_with_timeout`.

#### Steps

1. **lib.rs** — in `MicrophoneCapture::stop()`:
   ```rust
   // BEFORE: let _ = handle.join();
   // AFTER:
   join_thread_with_timeout(handle, Duration::from_secs(2), "MicrophoneCapture");
   ```

2. **Rebuild**: `npm run build:native:current`

#### Acceptance

- `MicrophoneCapture.stop()` returns within 2s even if CPAL thread is hung
- `npm test`

---

### T-010: Audio Recovery Infinite Retry Storm

**Priority**: P1 | **Platform**: Both | **Risk**: 🟡 MEDIUM

#### Problem

`electron/main/AppState.ts` line 1371: `this.audioRecoveryAttempts = 0` after success enables infinite recovery loops on flaky devices.

#### Steps

1. **Add sliding window tracker** to `AppState`:
   ```typescript
   private audioRecoveryTimestamps: number[] = [];
   private static readonly MAX_RECOVERIES_PER_WINDOW = 3;
   private static readonly RECOVERY_WINDOW_MS = 5 * 60 * 1000; // 5 min
   ```

2. **Before recovery** — check window:
   ```typescript
   const now = Date.now();
   this.audioRecoveryTimestamps = this.audioRecoveryTimestamps.filter(t => now - t < AppState.RECOVERY_WINDOW_MS);
   if (this.audioRecoveryTimestamps.length >= AppState.MAX_RECOVERIES_PER_WINDOW) {
     console.warn('[Main] Audio recovery cap reached. Manual restart required.');
     this.broadcast('audio-recovery-exhausted');
     return;
   }
   this.audioRecoveryTimestamps.push(now);
   ```

3. **Line 1371**: Remove `this.audioRecoveryAttempts = 0`. Replace with timestamp push only.

#### Acceptance

- Max 3 recovery cycles in 5 min window
- `npm test`

---

### T-011: GracefulShutdownManager Re-entry Hang

**Priority**: P1 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`electron/GracefulShutdownManager.ts` lines 28-31: re-entrant `shutdown()` does `await new Promise(() => {})` which never resolves.

#### Steps

1. **Track first shutdown promise**:
   ```typescript
   private shutdownPromise: Promise<never> | null = null;
   ```

2. **Return it on re-entry**:
   ```typescript
   async shutdown(code: number, reason: string): Promise<never> {
     if (this.shuttingDown) {
       if (this.shutdownPromise) return this.shutdownPromise;
       // Fallback: hard exit after 5s
       await new Promise(r => setTimeout(r, 5000));
       process.exit(code);
     }
     this.shuttingDown = true;
     this.shutdownPromise = this._runShutdown(code, reason);
     return this.shutdownPromise;
   }
   ```

#### Acceptance

- Second `shutdown()` call resolves when first completes
- `npm test`

---

### T-012: Content Renderer Crash — No Recovery

**Priority**: P1 | **Platform**: Both | **Risk**: 🟡 MEDIUM

#### Problem

`electron/stealth/StealthRuntime.ts` `handleContentCrash` hides shell + emits fault but no auto-recovery. User loses UI permanently until restart.

#### Steps

1. **Add crash counter + recovery**:
   ```typescript
   private contentCrashCount = 0;
   private contentCrashWindowStart = 0;
   private static readonly MAX_CRASHES_PER_WINDOW = 3;
   private static readonly CRASH_WINDOW_MS = 60_000;
   ```

2. **In `handleContentCrash`** — after hiding shell, schedule recovery:
   ```typescript
   const now = Date.now();
   if (now - this.contentCrashWindowStart > StealthRuntime.CRASH_WINDOW_MS) {
     this.contentCrashCount = 0;
     this.contentCrashWindowStart = now;
   }
   this.contentCrashCount++;
   if (this.contentCrashCount <= StealthRuntime.MAX_CRASHES_PER_WINDOW) {
     setTimeout(() => this.attemptContentRecovery(), 2000);
   }
   ```

3. **Add `attemptContentRecovery()`** that recreates the content BrowserWindow with same stealth protections.

#### Acceptance

- After renderer crash, UI recovers within 5s
- After 3 crashes in 60s, stops retrying and emits permanent fault
- `npm test`

---

### T-013: SupervisorBus Circuit Breaker Never Recovers

**Priority**: P1 | **Platform**: Both | **Risk**: 🟢 LOW

#### Problem

`electron/runtime/SupervisorBus.ts` lines 179-188: tripped listeners are permanently removed.

#### Steps

1. **Add half-open state** — instead of deleting listener, mark it as `tripped` with timestamp:
   ```typescript
   interface TrackedListener {
     fn: Function;
     failures: number;
     trippedAt: number | null;
   }
   ```

2. **In `emit()`** — if tripped and 60s elapsed, allow single test call. Reset on success.

3. **Log recovery**: `console.log('[SupervisorBus] Circuit breaker reset for <event>')`.

#### Acceptance

- Listener that fails 3x then stabilizes is re-enabled within 90s
- Existing `supervisorBus.test.ts` passes + new test for recovery
- `npm test`

---

## TIER 2 — MEDIUM (P2)

---

### T-014: Native Module Loader Stealth-Revealing Logs

**Priority**: P2 | **Platform**: Both | **Risk**: 🟢 LOW

**File**: `electron/stealth/nativeStealthModule.ts:19,57`

**Fix**: Replace `'Privacy protection is DEGRADED'` → `'Module L1 unavailable'`. Replace `'Privacy protection is operating in Layer 0 mode only'` → `'L0 fallback active'`.

---

### T-015: Recovery Controller — No Session-Level Cap

**Priority**: P2 | **Platform**: Both | **Risk**: 🟢 LOW

**File**: `electron/stealth/PrivacyShieldRecoveryController.ts`

**Fix**: Add `private hourlyRecoveryTimestamps: number[] = []`. Before `runAutoRecovery()`, check `hourlyRecoveryTimestamps.filter(t => Date.now() - t < 3600000).length < 10`. After cap, log warning and require manual recovery via shortcut.

---

### T-016: Startup Gate Timeout Too Tight

**Priority**: P2 | **Platform**: Both | **Risk**: 🟢 LOW

**File**: `electron/stealth/StartupProtectionGate.ts:66`

**Fix**: `const TIMEOUT_MS = parseInt(process.env.NATIVELY_STARTUP_GATE_TIMEOUT_MS || '1500', 10);`

---

### T-017: Duplicate Enterprise Tool Lists

**Priority**: P2 | **Platform**: macOS | **Risk**: 🟢 LOW

**Files**: `MonitoringDetector.ts:20-37`, `TCCMonitor.ts:16-33`

**Fix**: Create `electron/stealth/enterpriseToolRegistry.ts` with shared `KNOWN_ENTERPRISE_TOOLS` array. Import from both modules. Delete duplicate arrays.

---

### T-018: Audio Debug Logs Leak Metadata

**Priority**: P2 | **Platform**: Both | **Risk**: 🟢 LOW

**File**: `electron/main/AppState.ts:1650-1651,1679-1680`

**Fix**: Gate `Math.random() < 0.01` sampling logs behind `process.env.NATIVELY_DEBUG_AUDIO === '1'`.

---

## Execution Order

```mermaid
gantt
    title Implementation Priority Order
    dateFormat X
    axisFormat %s
    
    section P0 Critical
    T-001 Native Process FFI     :0, 3
    T-002 Remove Python Fallback :0, 1
    T-003 Native Browser Detect  :1, 3
    T-004 Console Log Redaction  :1, 2
    T-005 Binary Path Mitigation :3, 4
    T-006 Tray Tooltip Fix       :2, 3
    T-007 AUMID Fix              :2, 3
    
    section P1 Reliability
    T-008 Graceful Kill Switch   :3, 4
    T-009 Mic Stop Timeout       :3, 4
    T-010 Recovery Backoff Cap   :4, 5
    T-011 Shutdown Re-entry      :4, 5
    T-012 Content Crash Recovery :5, 6
    T-013 Circuit Breaker Reset  :5, 6
    
    section P2 Hardening
    T-014 Module Log Neutralize  :6, 7
    T-015 Recovery Session Cap   :6, 7
    T-016 Startup Gate Timeout   :6, 7
    T-017 Deduplicate Tool List  :7, 8
    T-018 Audio Log Gating       :7, 8
```

## Dependencies

```
T-001 ──→ T-003 (T-003 reuses T-001's Rust FFI)
T-001 ──→ T-017 (T-017 refactors modules touched by T-001)
T-002 ──→ T-003 (both modify ChromiumCaptureDetector.ts)
T-004 ──→ T-014 (T-014 adds patterns to the redactor T-004 installs)
T-008 ──→ T-011 (both modify shutdown flow)
```

## Verification Checklist

```bash
# After ALL tickets:
npm test                                          # full test suite
npm run build:native:current                      # native module compiles
grep -rn "execFile\|child_process" electron/stealth/MonitoringDetector.ts   # 0
grep -rn "execFile\|child_process" electron/stealth/TCCMonitor.ts           # 0
grep -rn "python3\|Quartz" electron/stealth/ChromiumCaptureDetector.ts      # 0
grep -rn "pgrep\|tasklist" electron/stealth/StealthManager.ts               # 0 in detection paths
NATIVELY_STRICT_PROTECTION=1 npm start 2>&1 | grep -ic "stealth\|natively" # 0
```

## Open Questions

> **Q1**: Should T-005 (binary path) be solved at build time (rename `.app`/`.exe`) or runtime?

> **Q2**: For T-001's native FFI, return full process list or boolean "any threat"? Full list reused by T-003.

> **Q3**: Windows Rust FFI bindings are declared in TypeScript but have no `#[cfg(windows)]` Rust implementation. Is Windows intentionally Layer 0-only?
