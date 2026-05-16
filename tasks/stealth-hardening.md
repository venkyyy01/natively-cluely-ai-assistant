# Task: Stealth Hardening Implementation

**Spec:** `docs/superpowers/specs/2026-03-22-stealth-hardening.md`  
**Priority:** P0 — mission-critical stealth enforcement  
**Date:** 2026-03-22

---

## Context

The existing `electron/stealth/StealthManager.ts` is a 58-line stub that only sets
`contentProtection` and `skipTaskbar` on window creation. This task adds three
new capabilities:

1. **Monitoring software detection** — scans running processes, window titles,
   file system artifacts, and macOS launch agents against a known-bad DB
2. **Screen share detection** — tiered fallback chain (native API → TCC probe →
   process match → window title match)
3. **Continuous enforcement loop** — 250ms / 3s / 15s self-healing loops with
   event-driven triggers and emergency quit on confirmed threat

**Key rule:** When monitoring/proctoring software is detected → `app.quit()`
immediately, zero residue. Screen-share only → hide windows, stay alive.

---

## Checklist

### Phase 1 — Signature Database

- [ ] Create `electron/stealth/signatures/monitoring-software.json`
  - Include all entries from spec §2.2 (ProctorU, Examplify, Respondus, Proctorio,
    Honorlock, Teramind, ActivTrak, Hubstaff, Time Doctor, Veriato, Process Explorer,
    Process Monitor, Wireshark, Fiddler, Charles, mitmproxy, Burp Suite)
  - **Also include:** SuperProctor, HackerRank, CoderPad
  - Schema per spec §2.3: `{ name, category, processNames, windowTitles, installPaths,
    fileArtifacts, networkEndpoints, launchAgents? }`

### Phase 2 — MonitoringDetector

- [ ] Create `electron/stealth/MonitoringDetector.ts`
  - Export types: `MonitoringSoftwareSignature`, `DetectionResult`, `ThreatInfo`
  - Load `monitoring-software.json` at construction
  - Implement `detectAll(): Promise<DetectionResult>` with 4 independent layers:
    - **Layer 1 (process):** `ps -axo pid,comm,args` (macOS) / `tasklist /fo csv /nh`
      (Windows) — case-insensitive match on `processNames` → confidence: `'high'`
    - **Layer 2 (window):** shell `osascript` (macOS) / WMI (Windows) to enumerate
      system window titles → match `windowTitles` → confidence: `'high'`
    - **Layer 3 (file):** `fs.existsSync` on `installPaths` + `fileArtifacts` →
      confidence: `'medium'`
    - **Layer 4 (launch agents, macOS only):** `fs.readdirSync` on
      `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` →
      confidence: `'high'`
  - Each layer wrapped in try/catch — crash of one layer must NOT stop others
  - Return `{ detected: boolean, threats: ThreatInfo[], timestamp, detectionMethod }`

### Phase 3 — ScreenShareDetector

- [ ] Create `electron/stealth/ScreenShareDetector.ts`
  - Export type: `ScreenShareStatus`
  - Implement `detect(): Promise<ScreenShareStatus>` with tiered fallback:
    - **Tier 1:** native module guard (`nativeModule?.detectScreenShare` if present)
    - **Tier 2 (macOS):** probe TCC database for recent screen-recording grants
    - **Tier 3:** `ps`/`tasklist` match against known screen-sharing processes
      (Zoom `zoom.us`, Teams `Teams`, OBS `obs`, Loom `Loom`, QuickTime
      `QuickTime Player`, etc.)
    - **Tier 4:** window title match for active-share strings ("You are screen
      sharing", "Sharing your screen", "You're presenting", "Go Live", etc.)
  - Must always return a value — fallback: `{ active: false, confidence: 'low',
    source: 'heuristic', timestamp: Date.now() }`

### Phase 4 — ContinuousEnforcementLoop

- [ ] Create `electron/stealth/ContinuousEnforcementLoop.ts`
  - Export `EnforcementConfig` interface and `PARANOID_CONFIG` constant (spec §5.1-5.2)
  - Constructor: `{ appState, windowHelper, monitoringDetector, screenShareDetector, config }`
  - `start()` / `stop()` methods manage three independent `setInterval` timers
  - **Fast loop (250ms):** enforce window visibility, dock/taskbar hidden, disguise,
    content protection — wrapped in try/catch, never throws
  - **Medium loop (3000ms):** call `screenShareDetector.detect()` → if active:
    hide all windows, hide dock (`app.dock.hide()`); do NOT auto-show
  - **Slow loop (15000ms):** call `monitoringDetector.detectAll()` → if detected:
    **call `app.quit()` immediately** (zero residue)
  - **Event-driven triggers:** `app.on('browser-window-focus')`,
    `app.on('browser-window-created')`, `app.on('activate')` → re-run fast loop tick
  - **Violation tracking:** `StealthViolation` ring buffer; 3+ violations in 60s →
    emergency quit
  - **Emergency mode:** `app.quit()` — no partial state, no audio pause, no logging delay

### Phase 5 — Integration into main.ts

- [ ] Import `ContinuousEnforcementLoop`, `MonitoringDetector`, `ScreenShareDetector`,
  `PARANOID_CONFIG` in `electron/main.ts`
- [ ] Add `private enforcementLoop: ContinuousEnforcementLoop | null = null` to `AppState`
- [ ] In `initializeApp()`, after `appState.createWindow()`:
  ```typescript
  const enforcementLoop = new ContinuousEnforcementLoop({
    appState,
    windowHelper: appState.getWindowHelper(),
    monitoringDetector: new MonitoringDetector(),
    screenShareDetector: new ScreenShareDetector(),
    config: PARANOID_CONFIG,
  });
  enforcementLoop.start();
  ```
- [ ] On `app.before-quit` — call `enforcementLoop.stop()`

### Phase 6 — StealthManager.ts minor update

- [ ] Re-export `EnforcementConfig` and `PARANOID_CONFIG` from `StealthManager.ts`
  so consumers have a single import point — no breaking changes to existing interface

### Phase 7 — Tests

- [ ] Create `electron/tests/monitoringDetector.test.ts`
  - Mock `child_process.exec` to inject fake `ps` output
  - Mock `fs.existsSync` and `fs.readdirSync`
  - Test: process match → `detected: true`, confidence `'high'`
  - Test: file match → `detected: true`, confidence `'medium'`
  - Test: launch agent match → `detected: true`
  - Test: no matches → `detected: false`
  - Test: layer crash doesn't abort other layers

- [ ] Create `electron/tests/screenShareDetector.test.ts`
  - Test: process match → `active: true, source: 'process'`
  - Test: window title match → `active: true, source: 'window'`
  - Test: no match → `active: false`
  - Test: all tiers fail → safe default returned

- [ ] Create `electron/tests/continuousEnforcementLoop.test.ts`
  - Use `mock.timers` from `node:test`
  - Test: fast loop fires at 250ms interval
  - Test: monitoring detected → `app.quit()` called
  - Test: screen share → windows hidden, process stays alive
  - Test: 3 violations in 60s → `app.quit()` called
  - Test: loop crash doesn't stop other loops
  - Test: `stop()` clears all intervals

---

## Verification

```bash
# Typecheck
npm run typecheck

# Run all electron tests (picks up new test files automatically)
npm run test:electron
```

Manual checks:
1. Open Zoom → share screen → Natively windows hidden within 3s, app stays alive
2. Open Activity Monitor → Natively quits within 15s → verify `ps aux | grep Natively` empty
3. Set disguise "Terminal" → process title always reflects disguise
4. `Cmd+Shift+3` screenshot → Natively window not in screenshot
