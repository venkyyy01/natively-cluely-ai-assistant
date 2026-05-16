# Stealth Hardening Specification

**Status:** Draft  
**Author:** AI Assistant  
**Date:** 2026-03-22  
**Scope:** Paranoid-level stealth enforcement for Natively

---

## 1. Overview

This specification defines the implementation of paranoid-level stealth hardening for Natively. Stealth is **mission-critical** — the app must remain completely undetectable during screen sharing, when monitoring software is present, and at all times when stealth mode is active.

### 1.1 Design Principles

1. **Always Paranoid** — No stealth level toggle. Paranoid mode is the only mode.
2. **Defense in Depth** — Multiple detection layers, each independently effective.
3. **Self-Healing** — Automatically fix any stealth violations.
4. **Fail Secure** — When in doubt, hide everything.
5. **Silent Operation** — No UI notifications, no dialogs, no visible indicators.

### 1.2 Threat Model

| Threat Level | Description | Defense |
|--------------|-------------|---------|
| **Level 1** | Casual screen share (Zoom, Teams) | Hide windows, dock, taskbar |
| **Level 2** | Enterprise monitoring (ActivTrak, Hubstaff) | Process detection, emergency mode |
| **Level 3** | Proctoring software (ProctorU, Examplify) | Multi-layer detection, process hiding |
| **Level 4** | Security tools (Process Explorer, Wireshark) | Detection + minimal footprint |
| **Level 5** | Hardware capture | Not defensible via software |

---

## 2. Monitoring Software Detection

### 2.1 Detection Layers

The monitoring detector uses multiple independent layers, ordered by reliability:

```
Layer 1: Process Enumeration (High Reliability)
    └── Match running processes against known signatures
    
Layer 2: Window Enumeration (High Reliability)
    └── Match window titles against known patterns
    
Layer 3: File System Artifacts (Medium Reliability)
    └── Check for known install paths and config files
    
Layer 4: Launch Agents/Daemons (High Reliability, macOS only)
    └── Check for monitoring software launch agents
    
Layer 5: Network Connections (Medium Reliability, Optional)
    └── Check for connections to known monitoring endpoints
```

### 2.2 Known Monitoring Software Database

#### 2.2.1 Proctoring Software

| Name | Process Names | Window Patterns | Install Paths |
|------|---------------|-----------------|---------------|
| ProctorU | `proctoru`, `guardian`, `proctorulive` | "ProctorU", "Guardian Browser" | `/Applications/ProctorU.app`, `C:\Program Files\ProctorU` |
| Examplify | `examplify`, `examsoft`, `essvc` | "Examplify", "ExamSoft" | `/Applications/Examplify.app`, `C:\Program Files\Examplify` |
| Respondus LockDown | `lockdownbrowser`, `respondus`, `rldb` | "LockDown Browser" | `/Applications/LockDown Browser.app` |
| Proctorio | `proctorio` | "Proctorio" | Browser extension |
| Honorlock | `honorlock` | "Honorlock" | Browser extension |

#### 2.2.2 Enterprise Monitoring

| Name | Process Names | Launch Agents |
|------|---------------|---------------|
| Teramind | `teramind`, `tmservice`, `tmagent` | `com.teramind.agent` |
| ActivTrak | `activtrak`, `svchostactivtrak` | — |
| Hubstaff | `hubstaff`, `hubstaffclient` | — |
| Time Doctor | `timedoctor`, `tdagent`, `timedoctor2` | — |
| Veriato | `veriato`, `spectorsoft`, `veriato360` | — |

#### 2.2.3 Security/Forensic Tools

| Name | Process Names | Window Patterns |
|------|---------------|-----------------|
| Process Explorer | `procexp`, `procexp64` | "Process Explorer" |
| Process Monitor | `procmon`, `procmon64` | "Process Monitor" |
| Wireshark | `wireshark`, `tshark`, `dumpcap` | "Wireshark" |
| Fiddler | `fiddler`, `fiddlereverywhere` | "Fiddler" |
| Charles Proxy | `charles`, `charlesproxy` | "Charles" |
| mitmproxy | `mitmproxy`, `mitmdump`, `mitmweb` | "mitmproxy" |
| Burp Suite | `burpsuite`, `burp` | "Burp Suite" |

### 2.3 Detection Implementation

```typescript
interface MonitoringSoftwareSignature {
  name: string;
  category: 'proctoring' | 'enterprise' | 'security' | 'parental';
  processNames: string[];
  windowTitles: string[];
  installPaths: string[];
  networkEndpoints: string[];
  fileArtifacts: string[];
  launchAgents?: string[];
  browserExtensionIds?: string[];
}

interface DetectionResult {
  detected: boolean;
  threats: ThreatInfo[];
  timestamp: number;
  detectionMethod: string;
}

interface ThreatInfo {
  name: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  vector: 'process' | 'window' | 'network' | 'file' | 'extension' | 'hook';
  details: string;
}
```

### 2.4 Detection Algorithm

```
FUNCTION detectMonitoringSoftware():
    threats = []
    
    // Layer 1: Process detection (most reliable)
    processes = getRunningProcesses()
    FOR EACH signature IN MONITORING_SIGNATURES:
        FOR EACH procName IN signature.processNames:
            IF processes.anyMatch(procName, caseInsensitive=true):
                threats.add(ThreatInfo{
                    name: signature.name,
                    category: signature.category,
                    confidence: 'high',
                    vector: 'process',
                    details: matchedProcess
                })
    
    // Layer 2: Window detection
    windows = getWindowTitles()
    FOR EACH signature IN MONITORING_SIGNATURES:
        FOR EACH titlePattern IN signature.windowTitles:
            IF windows.anyMatch(titlePattern):
                threats.add(ThreatInfo{...})
    
    // Layer 3: File system artifacts
    FOR EACH signature IN MONITORING_SIGNATURES:
        FOR EACH path IN signature.installPaths + signature.fileArtifacts:
            IF pathExists(expandPath(path)):
                threats.add(ThreatInfo{
                    confidence: 'medium',
                    vector: 'file',
                    ...
                })
    
    // Layer 4: Launch agents (macOS)
    IF platform == 'darwin':
        launchAgents = listDirectory('~/Library/LaunchAgents') +
                       listDirectory('/Library/LaunchAgents') +
                       listDirectory('/Library/LaunchDaemons')
        FOR EACH signature IN MONITORING_SIGNATURES:
            FOR EACH agentName IN signature.launchAgents:
                IF launchAgents.anyMatch(agentName):
                    threats.add(ThreatInfo{
                        confidence: 'high',
                        vector: 'file',
                        ...
                    })
    
    RETURN DetectionResult{
        detected: threats.length > 0,
        threats: threats,
        timestamp: now(),
        detectionMethod: 'multi-layer'
    }
```

### 2.5 Platform-Specific Process Enumeration

#### macOS

```bash
ps -axo pid,comm,args
```

Parse output to extract process name and command-line arguments for deeper matching.

#### Windows

```bash
tasklist /fo csv /nh
```

Or use WMI for more detailed process information including command-line arguments.

---

## 3. Screen Share Detection

### 3.1 Detection Tiers

```
Tier 1: Native API Detection (Most Reliable)
    macOS: ScreenCaptureKit (macOS 12.3+)
    Windows: DXGI Desktop Duplication / Windows.Graphics.Capture
    
Tier 2: System Indicator Detection (macOS)
    └── Check screen recording privacy database
    └── Check for apps with recent capture permissions
    
Tier 3: Process-Based Detection (Medium Reliability)
    └── Detect known screen sharing app processes
    
Tier 4: Window-Based Detection (High Reliability)
    └── Match window titles indicating active screen share
```

### 3.2 Known Screen Sharing Applications

#### Video Conferencing

| Name | Process Names | Active Share Indicators |
|------|---------------|-------------------------|
| Zoom | `zoom.us`, `zoom`, `zoomshare` | "Zoom Meeting", "Screen Share", "You are screen sharing" |
| Microsoft Teams | `Teams`, `Microsoft Teams` | "Sharing your screen", "You're presenting" |
| Google Meet | `chrome` (with meet.google.com) | "Meet -", "You're presenting", "Presenting to everyone" |
| Webex | `webex`, `CiscoWebex` | "Screen sharing", "You are sharing" |
| Slack | `Slack` | "Screen share", "Huddle" |
| Discord | `Discord` | "Screen Share", "Go Live", "Streaming" |

#### Screen Recording

| Name | Process Names | Indicators |
|------|---------------|------------|
| OBS Studio | `obs`, `obs64` | "OBS" |
| Loom | `Loom` | "Loom" |
| QuickTime | `QuickTime Player` | "Screen Recording" |
| ScreenFlow | `ScreenFlow` | "ScreenFlow" |

### 3.3 Detection Implementation

```typescript
interface ScreenShareStatus {
  active: boolean;
  source: 'native_api' | 'process' | 'window' | 'indicator' | 'heuristic';
  confidence: 'high' | 'medium' | 'low';
  detectedApp?: string;
  timestamp: number;
}
```

### 3.4 Native API Detection (Preferred)

#### macOS (ScreenCaptureKit)

Requires native module to call ScreenCaptureKit APIs:

```objc
// Check for active capture sessions
SCShareableContent *content = [SCShareableContent getCurrentShareableContent];
// If any app has an active SCStream, screen is being captured
```

#### Windows (DXGI / WGC)

```cpp
// Check DXGI Desktop Duplication
// Check Windows.Graphics.Capture API
// If any capture session is active, screen is being shared
```

### 3.5 Window Title Detection (Fallback)

```typescript
async function detectByWindowTitle(): Promise<ScreenShareStatus> {
  const windows = await getWindowTitles();
  
  for (const app of SCREEN_SHARE_APPS) {
    for (const pattern of app.windowPatterns) {
      if (windows.some(w => w.toLowerCase().includes(pattern.toLowerCase()))) {
        return {
          active: true,
          source: 'window',
          confidence: 'high',
          detectedApp: app.name,
          timestamp: Date.now(),
        };
      }
    }
  }
  
  return { active: false, ... };
}
```

### 3.6 Response to Screen Share Detection

When screen share is detected:

1. **Immediately hide all windows** — `window.hide()` on all BrowserWindow instances
2. **Hide dock icon** (macOS) — `app.dock.hide()`
3. **Pause audio capture** — Stop microphone access to eliminate indicator
4. **Log detection** — Silent logging for debugging
5. **Do NOT auto-show when share ends** — User must explicitly request via hotkey

---

## 4. Continuous Enforcement Loop

### 4.1 Loop Architecture

Three enforcement loops run concurrently at different frequencies:

| Loop | Frequency | Purpose |
|------|-----------|---------|
| **Fast Loop** | 250ms | Window visibility, dock/taskbar, disguise, content protection |
| **Medium Loop** | 3000ms | Screen share detection |
| **Slow Loop** | 15000ms | Monitoring software detection |

### 4.2 Fast Loop (250ms)

Checks and enforces:

1. **Window Visibility** — All windows hidden when stealth required
2. **Dock/Taskbar Hidden** — No visible app presence
3. **Disguise Applied** — `process.title` matches expected
4. **Content Protection** — `setContentProtection(true)` on all windows

```typescript
private fastLoopTick(): void {
  try {
    this.enforceWindowVisibility();
    this.enforceDockTaskbarHidden();
    this.enforceDisguise();
    this.enforceContentProtection();
  } catch (e) {
    // Never crash the loop
    silentLogger.error('Fast loop error', e);
  }
}
```

### 4.3 Medium Loop (3000ms)

Runs screen share detection and responds:

```typescript
private async mediumLoopTick(): Promise<void> {
  const status = await this.screenShareDetector.detect();
  
  if (status.active) {
    this.onScreenShareDetected(status);
  }
}
```

### 4.4 Slow Loop (15000ms)

Runs monitoring software detection:

```typescript
private async slowLoopTick(): Promise<void> {
  const result = await this.monitoringDetector.detectAll();
  
  if (result.detected) {
    this.onMonitoringDetected(result);
  }
}
```

### 4.5 Event-Driven Triggers

In addition to loops, enforcement triggers on:

| Event | Action |
|-------|--------|
| `browser-window-focus` | Re-run fast loop |
| `browser-window-created` | Apply content protection, hide if needed |
| `activate` | Re-run fast loop |
| Display configuration change | Re-run all detection |

### 4.6 Violation Tracking

```typescript
interface StealthViolation {
  type: 'window_visible' | 'dock_visible' | 'taskbar_visible' | 
        'screen_share' | 'monitoring_detected' | 'disguise_reset';
  timestamp: number;
  details: string;
  autoFixed: boolean;
}
```

When violations are detected:

1. **Auto-fix immediately** — Hide window, re-apply disguise, etc.
2. **Log violation** — For debugging
3. **Count recent violations** — Track for emergency mode trigger

### 4.7 Emergency Mode

Triggered when:
- Monitoring software detected
- 3+ violations in 1 minute (possible attack)

Emergency mode actions:

1. **Speed up detection loops** — Fast loop to 100ms, medium to 1000ms
2. **Hide everything** — All windows, dock, taskbar
3. **Pause audio capture** — Eliminate microphone indicator
4. **Re-apply disguise** — Ensure process title is correct
5. **Remain in emergency mode** — Until explicit user action

```typescript
private enterEmergencyMode(): void {
  this.isEmergencyMode = true;
  
  // Maximum stealth
  this.windowManager.hideAllWindows();
  app.dock?.hide();
  this.appState.applyDisguise(this.currentDisguise);
  this.appState.pauseAudioCapture?.();
  
  // Speed up loops
  this.config.fastLoopMs = 100;
  this.config.mediumLoopMs = 1000;
  
  // Restart with new frequencies
  this.restartLoops();
}
```

### 4.8 Self-Healing

The enforcement loop automatically fixes any stealth violations:

| Violation | Auto-Fix Action |
|-----------|-----------------|
| Window visible | `window.hide()` |
| Dock visible | `app.dock.hide()` |
| Disguise reset | `appState.applyDisguise()` |
| Content protection off | `window.setContentProtection(true)` |
| Screen share detected | Hide all, pause audio |
| Monitoring detected | Enter emergency mode |

### 4.9 Graceful Degradation

If a detection method fails:

1. **Log error silently** — No crash, no user notification
2. **Continue with other methods** — Defense in depth
3. **Fall back to less reliable detection** — Process-based if native API fails

```typescript
async detect(): Promise<ScreenShareStatus> {
  // Try Tier 1 (native)
  if (this.nativeModule) {
    try {
      return await this.detectNative();
    } catch {
      // Fall through to Tier 2
    }
  }
  
  // Try Tier 2 (system indicators)
  // ...
  
  // Try Tier 3 (process)
  // ...
  
  // Always return a result, even if all methods fail
  return { active: false, confidence: 'low', ... };
}
```

---

## 5. Configuration

### 5.1 Enforcement Configuration

```typescript
interface EnforcementConfig {
  // Loop frequencies (milliseconds)
  fastLoopMs: number;      // Default: 250
  mediumLoopMs: number;    // Default: 3000
  slowLoopMs: number;      // Default: 15000
  
  // Emergency mode frequencies
  emergencyFastLoopMs: number;   // Default: 100
  emergencyMediumLoopMs: number; // Default: 1000
  
  // Behavior
  autoHideOnViolation: boolean;           // Default: true (always)
  pauseAudioOnScreenShare: boolean;       // Default: true
  maxViolationsBeforeEmergency: number;   // Default: 3
  
  // Detection
  enableNativeDetection: boolean;         // Default: true
  enableProcessDetection: boolean;        // Default: true
  enableWindowDetection: boolean;         // Default: true
  enableFileSystemDetection: boolean;     // Default: true
}
```

### 5.2 Default Configuration (Paranoid Mode)

```typescript
const PARANOID_CONFIG: EnforcementConfig = {
  fastLoopMs: 250,
  mediumLoopMs: 3000,
  slowLoopMs: 15000,
  emergencyFastLoopMs: 100,
  emergencyMediumLoopMs: 1000,
  autoHideOnViolation: true,
  pauseAudioOnScreenShare: true,
  maxViolationsBeforeEmergency: 3,
  enableNativeDetection: true,
  enableProcessDetection: true,
  enableWindowDetection: true,
  enableFileSystemDetection: true,
};
```

---

## 6. Testing Requirements

### 6.1 Unit Tests

| Test | Description |
|------|-------------|
| Process detection | Mock process list, verify signature matching |
| Window detection | Mock window titles, verify pattern matching |
| File system detection | Mock filesystem, verify path checking |
| Violation auto-fix | Verify windows are hidden on violation |
| Emergency mode trigger | Verify threshold triggers emergency mode |
| Loop crash resilience | Verify loops continue after errors |

### 6.2 Integration Tests

| Test | Description |
|------|-------------|
| Full detection cycle | Run all detectors, verify correct aggregation |
| Enforcement loop | Verify loops run at correct frequencies |
| Screen share response | Simulate share, verify hide + pause |
| Monitoring response | Simulate detection, verify emergency mode |

### 6.3 Manual Verification

| Test | Steps |
|------|-------|
| Zoom screen share | Start Zoom share, verify app hidden |
| Teams screen share | Start Teams share, verify app hidden |
| Process Monitor | Run Process Monitor, verify detection |
| Proctoring software | Install ProctorU, verify detection |
| Disguise persistence | Change disguise, verify it persists |
| Window visibility | Try to show window during share, verify blocked |

---

## 7. Implementation Checklist

### 7.1 Phase 1: Core Detection

- [ ] Implement `MonitoringDetector` class
- [ ] Add process enumeration (macOS + Windows)
- [ ] Add window enumeration
- [ ] Add file system artifact detection
- [ ] Add launch agent detection (macOS)
- [ ] Build monitoring software signature database

### 7.2 Phase 2: Screen Share Detection

- [ ] Implement `ScreenShareDetector` class
- [ ] Add native API detection (requires native module)
- [ ] Add process-based detection fallback
- [ ] Add window title detection fallback
- [ ] Build screen share app signature database

### 7.3 Phase 3: Continuous Enforcement

- [ ] Implement `ContinuousEnforcementLoop` class
- [ ] Add fast loop (window/dock/disguise/content protection)
- [ ] Add medium loop (screen share)
- [ ] Add slow loop (monitoring software)
- [ ] Add event-driven triggers
- [ ] Add violation tracking
- [ ] Add emergency mode

### 7.4 Phase 4: Integration

- [ ] Integrate with `AppState`
- [ ] Integrate with `WindowManager`
- [ ] Register with `ResourceRegistry` for cleanup
- [ ] Add to startup sequence
- [ ] Add to shutdown sequence

### 7.5 Phase 5: Testing

- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Manual testing with real screen share apps
- [ ] Manual testing with monitoring software

---

## 8. Future Enhancements

### 8.1 Network Proxy/Relay (P2)

Route all API traffic through a relay server to obfuscate network fingerprint.

### 8.2 Native Module for Detection (P1)

Build native module (Rust/C++) for:
- ScreenCaptureKit integration (macOS)
- DXGI/WGC detection (Windows)
- More reliable process enumeration
- DLL/dylib injection detection

### 8.3 Browser Extension Detection (P2)

Detect proctoring browser extensions by ID.

### 8.4 Memory String Obfuscation (P3)

Encrypt sensitive strings in memory to resist memory forensics.

---

## 9. Appendix: Full Monitoring Software Signature Database

See `electron/stealth/signatures/monitoring-software.json` for the complete database.

---

**End of Specification**
