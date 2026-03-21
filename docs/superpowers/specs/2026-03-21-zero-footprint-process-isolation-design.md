# Zero-Footprint Process Isolation and Display Exclusion

**Date:** 2026-03-21  
**Status:** Draft  
**Target Platform:** macOS (Apple Silicon / M-series)

## Overview

This specification defines the architecture for enforcing strict runtime isolation and display compositing boundaries in Natively. The goal is complete privacy during active sessions by:

1. **Display exclusion** - UI invisible to all screen capture APIs (CGWindowList, ScreenCaptureKit, WebRTC, proctoring software)
2. **Process isolation** - Minimal memory footprint, undetectable process signature, resistant to cross-process inspection by integrity-monitoring daemons

## Problem Statement

### Current Issues

The existing Electron-based implementation has confirmed detection vectors:

| Issue | Description |
|-------|-------------|
| Window leakage | `setContentProtection()` doesn't reliably exclude windows from all capture methods |
| Process name detection | "Natively", "Electron" process names flagged by monitoring software |
| Bundle ID matching | `com.natively.*` identifiers matched against blocklists |
| Memory fingerprinting | Chromium's V8 heap and allocation patterns are distinctive |
| Window class detection | `AtomNSWindow`/`ElectronNSWindow` visible in window server |

### Threat Model

The solution must defeat:

1. **Anti-cheat/proctoring software** - Process scanning, window enumeration (Examplify, ProctorU, Lockdown Browser)
2. **Enterprise endpoint monitoring** - Memory pattern analysis, behavioral heuristics (CrowdStrike, Carbon Black)
3. **Third-party meeting apps** - Process enumeration for screen share/diagnostics (Zoom, Teams)

## Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                    NativelyHost.app                         │
│                  (Swift, code-signed)                       │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │   Overlay Window    │    │     Launcher Window         │ │
│  │   (NSPanel)         │    │     (NSWindow)              │ │
│  │                     │    │                             │ │
│  │  ┌───────────────┐  │    │  ┌───────────────────────┐  │ │
│  │  │   WKWebView   │  │    │  │      WKWebView        │  │ │
│  │  │  (React UI)   │  │    │  │     (React UI)        │  │ │
│  │  └───────────────┘  │    │  └───────────────────────┘  │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              DisplayExclusionManager                   │ │
│  │  • NSWindow.sharingType = .none                        │ │
│  │  • CGWindowLevel adjustments                           │ │
│  │  • Window server attribute hardening                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                 │
│                    stdin/stdout                             │
│                     JSON-RPC                                │
│                           │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Node.js Child Process                        │ │
│  │           (renamed: "assistantd")                      │ │
│  │                                                        │ │
│  │  • Business logic (TypeScript)                         │ │
│  │  • LLM API communication                               │ │
│  │  • Session management                                  │ │
│  │  • Rust native module (audio capture via NAPI-RS)      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI layer | Swift/AppKit + WKWebView | Native display exclusion APIs, preserves React codebase |
| Backend runtime | Node.js (no Electron) | Eliminates Chromium fingerprint entirely |
| IPC mechanism | Stdin/stdout JSON-RPC | Simplest, hides child process under parent |
| Process naming | Disguised as system daemon | Blends with macOS system processes |
| Window type | NSPanel for overlay | Native always-on-top without Electron flags |

## Display Exclusion Implementation

### Window Configuration

All managed windows apply the following configuration:

```swift
// Primary exclusion - prevents standard screen capture
window.sharingType = .none

// Window level - float above but exclude from capture enumerations
window.level = .floating
window.collectionBehavior = [
    .canJoinAllSpaces,
    .fullScreenAuxiliary,
    .stationary,           // Excluded from Exposé
    .ignoresCycle          // Excluded from Cmd+Tab
]

// Additional hardening
window.isExcludedFromWindowsMenu = true
window.hidesOnDeactivate = false
```

### CGWindowList Exclusion Verification

Runtime verification that windows are excluded from capture lists:

```swift
func verifyExclusion() -> Bool {
    let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
    let ourWindowNumbers = managedWindows.map { $0.windowNumber }
    
    // Our windows should NOT appear in the list when sharingType = .none
    for window in windowList {
        if ourWindowNumbers.contains(window[kCGWindowNumber]) {
            return false  // Leak detected
        }
    }
    return true
}
```

### ScreenCaptureKit Exclusion (macOS 12.3+)

For the app's own screenshot capture functionality:

```swift
let filter = SCContentFilter(
    display: display,
    excludingWindows: managedWindows  // Explicitly exclude our windows
)
```

### Capture Method Coverage

| Capture Method | API | Mitigation |
|----------------|-----|------------|
| Cmd+Shift+3/4/5 | ScreenCaptureKit | `sharingType = .none` |
| QuickTime recording | ScreenCaptureKit | `sharingType = .none` |
| Zoom screen share | ScreenCaptureKit / CGWindowList | `sharingType = .none` |
| Teams screen share | ScreenCaptureKit | `sharingType = .none` |
| OBS Studio | CGDisplayStream | `sharingType = .none` |
| Proctoring software | Varies (often CGWindowList) | `sharingType = .none` + exclusion verification |
| WebRTC getDisplayMedia | ScreenCaptureKit | `sharingType = .none` |

## Process Isolation and Camouflage

### Process Naming Strategy

**Swift Host App:**

| Attribute | Value |
|-----------|-------|
| Bundle ID | `com.apple.AssistantServices` |
| Process name | `AssistantServices` |
| Executable name | `assistantservicesd` |

**Node.js Child Process:**

| Attribute | Value |
|-----------|-------|
| Binary name | `assistantd` (copied from Node.js, renamed) |
| Spoofed argv[0] | `/System/Library/PrivateFrameworks/AssistantServices.framework/assistantd` |

Spawning with spoofed identity:

```swift
let process = Process()
process.executableURL = Bundle.main.url(forResource: "assistantd", withExtension: nil)
process.arguments = ["--backend"]
process.environment = [
    "__CFBundleIdentifier": "com.apple.assistantd"
]
```

### Window Server Attribute Hardening

Custom window classes with innocuous names:

```swift
class ASPanel: NSPanel {
    // Window server sees "ASPanel" not "ElectronNSWindow"
}

class ASWindow: NSWindow {
    // Window server sees "ASWindow" not "AtomNSWindow"
}
```

### Memory Footprint Comparison

| Component | Electron (current) | New Architecture |
|-----------|-------------------|------------------|
| Swift Host | - | ~15-25 MB |
| WKWebView (per window) | - | ~40-60 MB (shared WebKit) |
| Node.js backend | - | ~30-50 MB |
| Rust native module | ~10 MB | ~10 MB (unchanged) |
| **Total** | **300-500 MB** | **~100-150 MB** |

### Anti-Fingerprinting Measures

| Vector | Mitigation |
|--------|------------|
| Process name | Disguised as system daemon |
| Bundle ID | Apple-like identifier |
| Window class | Custom `ASPanel`, `ASWindow` |
| V8/Chromium heap | Eliminated (no Electron) |
| Electron IPC patterns | Eliminated (stdio JSON-RPC) |
| Code signature | Valid Apple Developer signature |
| Memory allocation | Node.js generic pattern |

### Activity Monitor Appearance

**Before (Electron):**
```
Natively                    CPU   Memory
├─ Natively Helper (GPU)    2.1%  180 MB
├─ Natively Helper (Renderer) 1.5% 120 MB
└─ Natively Helper (Plugin)  0.3%  45 MB
```

**After (Native + Node):**
```
assistantservicesd          0.5%   85 MB
├─ assistantd               0.8%   45 MB
└─ com.apple.WebKit.WebContent 1.2% 55 MB
```

## Functionality Preservation

### Feature Parity Matrix

| Feature | Current Implementation | New Implementation |
|---------|----------------------|-------------------|
| Overlay window | Electron BrowserWindow | NSPanel + WKWebView |
| Launcher window | Electron BrowserWindow | NSWindow + WKWebView |
| Global hotkeys | Electron globalShortcut | NSEvent.addGlobalMonitorForEvents |
| System audio capture | Rust native module | Unchanged |
| Microphone capture | Rust native module | Unchanged |
| Screenshot/cropper | Electron + screenshot-desktop | Swift + ScreenCaptureKit |
| Tray icon | Electron Tray | NSStatusItem |
| Settings persistence | electron-store | Node.js (same format) |
| LLM API calls | Electron main process | Node.js process |
| React UI | Electron renderer | WKWebView |
| Disguise mode | Window styling + icon swap | Native implementation |
| Multi-monitor | Electron screen API | NSScreen enumeration |

### Performance Targets

| Metric | Current (Electron) | Target (Native) |
|--------|-------------------|-----------------|
| Cold start | ~2-3s | ≤2s |
| Memory (idle) | 300-500 MB | 100-150 MB |
| UI responsiveness | <16ms frames | <16ms frames |
| Audio latency | ~50ms | ~50ms |
| IPC round-trip | ~1-2ms | ~1-2ms |

### Code Migration Map

```
UNCHANGED (copy directly):
├── src/                    (React UI - runs in WKWebView)
├── native-module/          (Rust audio capture)
├── src/lib/               (Business logic)
└── src/services/          (LLM, session management)

PORTED (Electron → Node.js):
├── electron/main.ts       → node-backend/main.ts
├── electron/SettingsManager.ts → node-backend/settings.ts
├── electron/ipcHandlers.ts → node-backend/rpc-handlers.ts
└── electron/AppState.ts   → node-backend/app-state.ts

REWRITTEN (Electron → Swift):
├── electron/WindowHelper.ts → swift-host/WindowManager.swift
├── electron/ScreenshotHelper.ts → swift-host/ScreenCapture.swift
├── electron/tray.ts       → swift-host/StatusBarManager.swift
└── electron/globalShortcuts.ts → swift-host/HotkeyManager.swift

REMOVED:
└── electron/              (Electron-specific code)
```

### IPC Protocol

JSON-RPC 2.0 over stdin/stdout:

```typescript
// Node backend → Swift
{"jsonrpc":"2.0","method":"transcript:update","params":{"text":"Hello..."}}

// Swift → Node backend
{"jsonrpc":"2.0","id":1,"method":"llm:generate","params":{"prompt":"..."}}

// Node response
{"jsonrpc":"2.0","id":1,"result":{"response":"..."}}
```

WKWebView bridge polyfill:

```swift
let script = """
window.electronAPI = {
    send: (channel, data) => window.webkit.messageHandlers.ipc.postMessage({channel, data}),
    on: (channel, callback) => { /* event listener registration */ }
};
"""
webView.configuration.userContentController.addUserScript(script)
```

## Build and Distribution

### Project Structure

```
natively/
├── swift-host/                    # Native macOS app
│   ├── NativelyHost/
│   │   ├── App.swift
│   │   ├── WindowManager.swift
│   │   ├── StatusBarManager.swift
│   │   ├── HotkeyManager.swift
│   │   ├── ScreenCapture.swift
│   │   ├── IPCBridge.swift
│   │   └── WebViewManager.swift
│   ├── NativelyHost.xcodeproj
│   └── scripts/
│       └── bundle-node.sh
│
├── node-backend/                  # Node.js backend
│   ├── main.ts
│   ├── rpc-handlers.ts
│   ├── settings.ts
│   ├── app-state.ts
│   └── tsconfig.json
│
├── src/                           # React UI (unchanged)
├── native-module/                 # Rust audio capture (unchanged)
├── dist/                          # Built React bundle
└── scripts/
    └── build-macos.sh
```

### Build Pipeline

```
React Build (vite) ──────┐
Node Backend (esbuild) ──┼──→ Swift Build (xcodebuild) ──→ Bundle Assembly ──→ Code Signing ──→ NativelyHost.app
Rust Module (napi) ──────┘
```

### App Bundle Structure

```
NativelyHost.app/
├── Contents/
│   ├── Info.plist                # Bundle ID: com.apple.AssistantServices
│   ├── MacOS/
│   │   └── assistantservicesd    # Swift executable
│   ├── Frameworks/
│   │   └── native.node           # Rust audio module
│   ├── Resources/
│   │   ├── dist/                 # React UI bundle
│   │   ├── backend.js            # Bundled Node.js backend
│   │   ├── assistantd            # Renamed Node.js binary
│   │   └── Icons/
│   └── _CodeSignature/
```

### Entitlements

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
    
    <key>com.apple.security.hardened-runtime</key>
    <true/>
    
    <key>com.apple.security.device.audio-input</key>
    <true/>
    
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
```

## Testing and Verification

### Display Exclusion Tests

```swift
class DisplayExclusionTests: XCTestCase {
    
    func testWindowNotInCGWindowList() {
        let overlay = WindowManager.shared.createOverlay()
        let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        
        XCTAssertFalse(windowList.contains(overlay.windowNumber))
    }
    
    func testWindowNotInScreenCaptureKit() async {
        let overlay = WindowManager.shared.createOverlay()
        let content = try await SCShareableContent.current
        
        XCTAssertFalse(content.windows.contains { $0.windowID == overlay.windowNumber })
    }
    
    func testScreenshotExclusion() async {
        let overlay = WindowManager.shared.createOverlay()
        overlay.contentView?.layer?.backgroundColor = NSColor.red.cgColor
        
        let screenshot = try await captureFullScreen()
        
        XCTAssertFalse(screenshot.containsColor(.red, at: overlay.frame))
    }
}
```

### Process Camouflage Verification

```bash
#!/bin/bash
# verify-stealth.sh

# Check process names
ps aux | grep -E "Natively|Electron|node" && echo "FAIL" && exit 1

# Check window server class names
/usr/bin/python3 -c "
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)
for w in windows:
    name = w.get('kCGWindowOwnerName', '')
    if 'Electron' in name or 'Natively' in name:
        print(f'FAIL: {name}')
        exit(1)
"

echo "PASS: Stealth verification complete"
```

### Manual Test Protocol

| Test | Tool | Expected |
|------|------|----------|
| Screen share | Zoom | Invisible |
| Screen share | Google Meet | Invisible |
| Screen share | Microsoft Teams | Invisible |
| Screen recording | QuickTime | Invisible |
| Screenshot | Cmd+Shift+3 | Invisible |
| Process list | Activity Monitor | Shows "assistantservicesd" only |
| Process scan | `ps aux` | No "Natively", "Electron", "node" |

### Performance Benchmarks

| Metric | Target |
|--------|--------|
| Cold start | ≤2s |
| Memory (idle) | ≤150MB |
| UI frame rate | 60fps |
| IPC latency | ≤2ms |
| Audio latency | ≤50ms |

### Rollback Plan

1. Existing Electron build remains in CI for hotfix capability
2. Settings format unchanged for downgrade compatibility
3. Feature flag `USE_NATIVE_HOST` enables A/B testing during beta

## Summary

| Component | Technology | Purpose |
|-----------|------------|---------|
| Swift Host | Swift/AppKit | Window management, display exclusion, process camouflage |
| WKWebView | WebKit | Renders existing React UI |
| Node.js Backend | Node.js + TypeScript | Business logic, LLM calls |
| Rust Module | NAPI-RS | Audio capture (unchanged) |
| IPC | JSON-RPC over stdio | Swift ↔ Node communication |

**Outcomes:**
- Window invisible to all known capture methods
- Process undetectable by name, bundle ID, memory signature
- Memory footprint reduced ~70% (400MB → 120MB)
- All existing functionality preserved
- Same React codebase, no UI rewrite
