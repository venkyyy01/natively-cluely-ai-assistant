# macOS Virtual Display Helper

A Swift command-line tool that creates virtual displays using Apple's CGVirtualDisplay API for secure, capture-resistant presentation.

## Requirements

- macOS 12.4 or later
- Xcode 15.0+ (for Swift 5.9)
- Screen Recording permission (for validation)

## Building

```bash
# Debug build
swift build

# Release build
swift build -c release

# Run tests
swift test
```

## Usage

The helper supports both one-shot and server modes:

### One-shot Mode

```bash
# Check status
./stealth-virtual-display-helper status

# Create session
echo '{"sessionId":"s1","windowId":"w1","width":1280,"height":720}' | \
  ./stealth-virtual-display-helper create-session

# Probe Layer 3 capabilities
./stealth-virtual-display-helper probe-capabilities
```

### Server Mode

```bash
# Start server
./stealth-virtual-display-helper serve

# Send JSON requests via stdin
echo '{"id":"req-1","command":"status"}' | nc -U /dev/stdin
```

## Code Signing

For production builds, the helper must be code-signed with hardened runtime:

```bash
# Set your signing identity
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# Build with signing
npm run prepare:macos:virtual-display-helper
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │         MacosVirtualDisplayClient                │   │
│  │         (TypeScript)                             │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │ spawn + JSON IPC                 │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────┐
│                       ▼                                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │         VirtualDisplayService                    │   │
│  │         (Swift)                                  │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │                                 │
│  ┌────────────────────┼─────────────────────────────┐   │
│  │                    ▼                             │   │
│  │  ┌────────────────────────────────────────────┐ │   │
│  │  │     CGVirtualDisplayBackend                │ │   │
│  │  │     (CoreGraphics Virtual Display API)     │ │   │
│  │  └────────────────────────────────────────────┘ │   │
│  │                                                 │   │
│  │  ┌────────────────────────────────────────────┐ │   │
│  │  │     AppKitMetalPresenterHost               │ │   │
│  │  │     (Metal-backed fullscreen window)       │ │   │
│  │  └────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│                 stealth-virtual-display-helper          │
└─────────────────────────────────────────────────────────┘
```

## Layer 3 Validation

The helper implements a "Layer 3" stealth validation program:

1. **Capability Probe** (`probe-capabilities`): Checks if the system supports:
   - macOS 14+ (required for validation program)
   - CGVirtualDisplay API availability
   - Metal device and command queue
   - ScreenCaptureKit availability
   - Screen Recording permission

2. **Protected Session** (`create-protected-session`): Creates a session for secure presentation

3. **Surface Attachment** (`attach-surface`): Attaches a Metal surface to the virtual display

4. **Presentation** (`present`): Activates/deactivates the presentation window

5. **Validation** (`validate-session`): Checks if the presentation is visible to:
   - CGWindowListCopyWindowInfo (window enumeration)
   - SCShareableContent (ScreenCaptureKit)

## Security Notes

- The helper creates windows at `NSScreenSaver` level for maximum visibility
- Windows are borderless and configured with specific collection behaviors
- The validation probe confirms whether the window is visible to screen capture APIs
- **Note**: The validation returns "failed" or "inconclusive" - it does not prove invisibility

## Commands Reference

| Command | Description | Input | Output |
|---------|-------------|-------|--------|
| `status` | Check helper status | None | `{component, backend, ready, activeSessionCount, layer3Candidate}` |
| `create-session` | Create virtual display session | `{sessionId, windowId, width, height}` | `{ready, sessionId, mode, surfaceToken, reason}` |
| `release-session` | Release session | `{sessionId}` | `{released}` |
| `probe-capabilities` | Probe Layer 3 capabilities | None | `{outcome, blockers, data: Layer3CandidateReport}` |
| `create-protected-session` | Create protected session | `{sessionId, presentationMode, displayPreference, reason}` | `{outcome, blockers, data}` |
| `attach-surface` | Attach Metal surface | `{sessionId, surfaceSource, surfaceId, width, height, hiDpi}` | `{outcome, blockers, data: Layer3HealthReport}` |
| `present` | Activate/deactivate presentation | `{sessionId, activate}` | `{outcome, blockers, data: Layer3HealthReport}` |
| `teardown-session` | Teardown protected session | `{sessionId}` | `{outcome, blockers, data: {released}}` |
| `get-health` | Get session health | `{sessionId}` | `{outcome, blockers, data: Layer3HealthReport}` |
| `get-telemetry` | Get session telemetry | `{sessionId}` | `{outcome, blockers, data: {events, counters}}` |
| `validate-session` | Validate session visibility | `{sessionId}` | `{outcome, blockers, data: Layer3ValidationReport}` |
| `serve` | Start JSON IPC server | JSON requests on stdin | JSON responses on stdout |

## Integration with Electron App

The helper is integrated into the Electron app via:

1. Build script: `scripts/prepare-macos-virtual-display-helper.js`
2. Client: `electron/stealth/MacosVirtualDisplayClient.ts`
3. Integration: `electron/stealth/macosVirtualDisplayIntegration.ts`

The helper is packaged in the app bundle at `bin/macos/stealth-virtual-display-helper`.
