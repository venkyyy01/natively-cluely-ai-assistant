# Stealth Deployment Guide

## Binary Path Fingerprinting Mitigation

By default, the Natively application bundle contains the product name in its file path (e.g., `Natively.app` on macOS or `Natively.exe` on Windows). Proctoring and monitoring tools can discover this path via OS APIs such as:

- **macOS**: `proc_pidpath()` — returns the full filesystem path to the process executable
- **Windows**: `QueryFullProcessImageNameW` — returns the full path to the `.exe`

Even when `process.title` is disguised, the binary path still reveals the application identity.

### Build-Time Renaming

Set the `NATIVELY_BUNDLE_NAME` environment variable during the build to produce a renamed binary:

```bash
# macOS
NATIVELY_BUNDLE_NAME="SystemHelper" npm run build:mac

# Windows
set NATIVELY_BUNDLE_NAME=SystemHelper
npm run build:win
```

This produces:
- macOS: `SystemHelper.app` instead of `Natively.app`
- Windows: `SystemHelper.exe` instead of `Natively.exe`

### macOS Info.plist Hiding

When `NATIVELY_DEFAULT_STEALTH=1` is set at build time, the generated `Info.plist` includes:

```xml
<key>LSUIElement</key>
<true/>
```

This hides the application from:
- Dock
- Cmd+Tab application switcher
- Force Quit window

### Limitations

- **Code signature**: Renaming the bundle does not change the code signing identity. A determined adversary with root access can still inspect the code signature.
- **Runtime detection**: The application still opens network connections and uses specific windowing APIs that may be fingerprinted.
- **Best effort**: This mitigation raises the bar but does not guarantee complete invisibility against a sophisticated, privileged attacker.
