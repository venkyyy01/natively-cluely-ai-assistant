# Capture Matrix

The capture matrix is the release evidence boundary for screen-share visibility
claims. It records one row per platform, app version, capture tool, mode,
monitor setup, strict flag, protected surface, expected result, actual result,
and artifact paths.

## Mock Harness

Run the deterministic scaffold:

```bash
npm run capture-matrix:mock
```

Artifacts are written to:

```text
output/capture-matrix/mock/mock-run/
```

The mock harness proves matrix plumbing only. It does not prove OS capture
behavior.

## Local OS Harness

Run the local adapter set for the current platform:

```bash
npm run capture-matrix:local
```

macOS adapters can also be run independently:

```bash
npm run capture-matrix:macos:screencapture
npm run capture-matrix:macos:cgwindow
```

The local harness includes:

- macOS `screencapture` adapter with high-contrast canary pixel detection.
- macOS native CGWindow enumeration adapter backed by the Rust native module.
- ScreenCaptureKit row scaffolding that skips unless explicitly enabled for
  release qualification; it is not a silent fallback.
- Windows Graphics Capture stub rows that skip with an explicit reason until
  native automation is implemented.

Local OS artifacts are written under:

```text
output/capture-matrix/local/
```

Live local rows skip until the canary test surface is armed. Load the generated
canary HTML in the protected/control fixture surface, then run with:

```bash
NATIVELY_CAPTURE_MATRIX_CANARY_ARMED=1 npm run capture-matrix:macos:screencapture
```

Skipped rows are evidence gaps, not passing proof. Product claims must be
generated from passed rows only.

## Planned Meeting/External Tools

Run browser/manual external scaffolds:

```bash
npm run capture-matrix:browser:get-display-media
npm run capture-matrix:external:manual
```

The browser harness ships a `getDisplayMedia` test page at:

```text
stealth-projects/integration-harness/capture-matrix/browser/get-display-media.html
```

The manual external adapter records app name, external app version when known,
and capture mode in the row metadata. Rows skip until a capture artifact is
provided and analyzed.

- Zoom
- Microsoft Teams
- Google Meet
- OBS Studio
- QuickTime
- Chromium `getDisplayMedia`
- Snipping Tool / Windows Graphics Capture automation

## Planned Platforms

- macOS supported packaged builds
- Windows supported packaged builds

## Checks

- protected window visibility
- physical-display leak status
- virtual-display session recovery
- restore after hide-and-restore watchdog mitigation
- canary token absent from protected capture artifacts
