# Windows 11 Installation & Stealth Guide

## Quick Start

```powershell
# Run as Administrator in PowerShell
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1
```

First run takes 15-30 minutes (installs Node.js, Rust, VS Build Tools if missing).

---

## Prerequisites

| Tool | Required | Auto-installed? |
|------|----------|-----------------|
| Windows 10 2004+ or Windows 11 | Yes | — |
| Node.js 18+ LTS | Yes | Yes (via winget) |
| Git | Recommended | Yes (via winget) |
| Visual Studio Build Tools 2022 (C++ workload) | Yes | Yes (via winget) |
| Rust toolchain (stable) | Yes | Yes (via rustup) |

> **Note:** VS Build Tools install may require a **reboot** before native modules compile correctly. If the build fails on the native module step, reboot and re-run.

---

## Build Options

### Basic build (default disguise profile)

```powershell
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1
```

### Build with a specific disguise profile

The disguise profile controls the binary name, install path, and process identity:

```powershell
# Looks like Windows Terminal helper process
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 -DisguiseProfile terminal

# Looks like Windows Settings helper process
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 -DisguiseProfile settings

# Looks like a generic system helper (default)
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 -DisguiseProfile system
```

| Profile | Binary Name | Install Path | Task Manager Name |
|---------|-------------|--------------|-------------------|
| `default` / `system` | `WindowsHelper.exe` | `%LOCALAPPDATA%\Microsoft\WindowsHelper\` | WindowsHelper |
| `terminal` | `WindowsTerminalHelper.exe` | `%LOCALAPPDATA%\Microsoft\WindowsTerminalHelper\` | WindowsTerminalHelper |
| `settings` | `SettingsHelper.exe` | `%LOCALAPPDATA%\Microsoft\SettingsHelper\` | SettingsHelper |

### Skip quality gates (faster build)

```powershell
$env:SKIP_QUALITY_GATES = "1"
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1
```

### Build only (don't install)

```powershell
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 -SkipInstall
```

### Force clean dependency reinstall

```powershell
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 -ForceDependencySync
```

---

## Post-Install Setup

### 1. Launch the app

From Start Menu search for the disguise name (e.g., "Windows Helper"), or run directly:

```powershell
& "$env:LOCALAPPDATA\Microsoft\WindowsHelper\WindowsHelper.exe"
```

### 2. Grant permissions when prompted

- **Microphone** — needed for audio transcription
- **Screen Recording** — needed for system audio capture and screenshots

### 3. Configure AI provider

Go to **Settings → AI Providers** and add your API key (OpenAI, Anthropic, Groq, etc.), or configure Ollama for fully local inference.

### 4. Enable Invisible Mode

Toggle the **Invisible** switch in the app's settings or use the keyboard shortcut. This activates:

- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — window invisible to all screen capture
- `WS_EX_TOOLWINDOW` — hidden from Alt-Tab switcher
- `setSkipTaskbar(true)` — hidden from Windows taskbar
- Tray icon hidden
- DWM cloak (if enabled) — additional capture pipeline coverage
- Continuous enforcement loop — re-applies protection every 2 seconds and immediately on display/session events

### 5. Set a disguise (optional, in-app)

In **Settings → Appearance → Disguise**, choose:
- **Terminal** — process appears as "Command Prompt" in Task Manager
- **Settings** — process appears as "Settings"
- **Activity** — process appears as "Task Manager"
- **None** — shows real name

---

## Stealth Architecture on Windows 11

### Layer 0: SetWindowDisplayAffinity (WDA_EXCLUDEFROMCAPTURE)

The primary protection. Makes the window completely absent from:
- Screen sharing (Zoom, Teams, Meet, Discord, Slack)
- Screen recording (OBS, Camtasia, Bandicam)
- Browser `getDisplayMedia()` (Codility, HackerRank, CodeSignal proctoring)
- Print Screen / Snipping Tool
- Windows Game Bar recording
- Any DXGI/GDI-based capture

The window is **not** a black rectangle — it's completely absent. Capture tools don't know it exists.

### Layer 1: Alt-Tab Exclusion (WS_EX_TOOLWINDOW)

Removes the window from the Alt-Tab task switcher. Combined with `setSkipTaskbar`, the window has no visible presence in the Windows shell UI.

### Layer 2: DWM Cloak (DWMWA_CLOAK)

Optional additional layer. Removes the window from the Desktop Window Manager's render tree entirely. Some capture pipelines that bypass `SetWindowDisplayAffinity` still respect DWM cloaking.

**Trade-off:** Cloaked windows can have reduced drag-drop reliability. Enabled via the `enablePrivateMacosStealthApi` feature flag (shared flag name, applies to both platforms).

### Layer 3: Continuous Enforcement

A background loop that:
1. Polls every 2 seconds to verify `WDA_EXCLUDEFROMCAPTURE` is still set
2. Re-applies immediately if stripped (display sleep/wake, monitor connect/disconnect, session lock/unlock)
3. Hooks `powerMonitor.resume`, `powerMonitor.unlock-screen`, `display-added`, `display-removed`, `display-metrics-changed` for instant re-application
4. After 3 consecutive failures, **fails closed** — engages the privacy shield and hides the window

### Layer 4: Process Disguise

- Binary renamed at build time (not "Natively.exe")
- Install path mimics Microsoft system directories
- `process.title` set to match disguise profile
- `app.setAppUserModelId()` set to a Microsoft AUMID
- Window titles match the disguise
- Jump list, recent documents, and user tasks cleared

---

## What's Protected vs What's Not

### Protected (invisible to these)

| Vector | Status |
|--------|--------|
| Screen recording / screen sharing | ✅ Fully invisible |
| Browser `getDisplayMedia()` proctoring | ✅ Fully invisible |
| Print Screen / Snipping Tool | ✅ Fully invisible |
| Alt-Tab switcher | ✅ Hidden |
| Windows taskbar | ✅ Hidden |
| System tray | ✅ Hidden |
| Task Manager → Processes tab (casual scan) | ✅ Disguised name |
| Jump list / recent items | ✅ Cleared |

### Not fully protected (limitations)

| Vector | Status | Notes |
|--------|--------|-------|
| Task Manager → Details tab | ⚠️ Shows real .exe name | Binary renaming helps but path is visible on hover |
| `tasklist` / `Get-Process` (programmatic) | ⚠️ Process exists | Name is disguised but process is enumerable |
| Tab/focus loss detection (browser) | ❌ Not addressed | Clicking the app causes browser blur events |
| Copy/paste detection | ❌ Not addressed | Pasting from app is logged by proctoring |
| AI code fingerprinting | ❌ Not addressed | Generated code patterns are detectable |
| Typing rhythm analysis | ❌ Not addressed | Behavioral signal independent of stealth |
| Kernel-mode capture drivers | ❌ Not addressed | Requires kernel-level defense (not implemented) |

---

## Troubleshooting

### Build fails on native module

```
error: linking with `link.exe` failed
```

**Fix:** Reboot after VS Build Tools installation, then re-run the script.

### App window is invisible to ME (not just capture)

This means DWM cloak is active but the window isn't rendering. Disable DWM cloak:
- Settings → Advanced → uncheck "Enhanced capture protection"
- Or set `enablePrivateMacosStealthApi: false` in settings

### Defender flags the binary

The native module makes Win32 calls (`SetWindowDisplayAffinity`, `SetWindowLongPtrW`, low-level hooks) that some AV heuristics flag. Solutions:
1. Add an exclusion for the install directory in Windows Security
2. Code-sign the binary (requires a certificate)

### Screen share still shows the window

Verify capture protection is active:
1. Open the app's developer console (Ctrl+Shift+I)
2. Check for `[StealthManager] Native module unavailable` warnings
3. If present, the native `.node` binary failed to load — rebuild with `npm run build:native:current`

### Alt-Tab still shows the window

The `WS_EX_TOOLWINDOW` style may not have applied. Check:
1. Ensure invisible mode is toggled ON
2. Restart the app after enabling invisible mode

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_QUALITY_GATES` | `0` | Set to `1` to skip typecheck/tests during build |
| `SKIP_INSTALL` | `0` | Set to `1` to build without installing |
| `QUALITY_GATE_TIMEOUT` | `300` | Per-gate timeout in seconds |
| `FORCE_DEPENDENCY_SYNC` | `0` | Set to `1` to force `npm ci` |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle overlay visibility |
| `Ctrl+Shift+B` | Toggle invisible mode |
| `Ctrl+Shift+Q` | Quit app |

> Shortcuts use CGEventTap-equivalent on Windows (low-level keyboard hooks) so they don't appear in the browser's keyboard event log.

---

## Updating

Pull the latest code and re-run the build script:

```powershell
git pull origin windows-1.1.6
powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1
```

The installer will overwrite the previous installation in-place.

---

## Uninstalling

Run the uninstaller from the install directory:

```powershell
& "$env:LOCALAPPDATA\Microsoft\WindowsHelper\Uninstall WindowsHelper.exe"
```

Or remove the directory manually:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Microsoft\WindowsHelper"
```
