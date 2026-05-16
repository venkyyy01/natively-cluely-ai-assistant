# Capture Matrix Harness

This directory owns release evidence artifacts for screen-share visibility
claims.

## Implemented Scope

- Matrix row schema.
- Mock adapter lifecycle.
- Deterministic artifact writing.
- `npm run capture-matrix:mock`.
- Local macOS `screencapture` adapter with persisted PNG artifacts.
- Local macOS native CGWindow enumeration adapter.
- High-contrast canary renderer and pixel detector.
- Explicit skip semantics for permission, platform, and unsupported-adapter
  gaps.
- Browser `getDisplayMedia` test page and adapter scaffold.
- Manual/semi-automated external adapter rows for Zoom, Meet, Teams, and OBS.

## Artifact Contract

Each row writes:

- `metadata.json`: row, adapter, verdict, reason, and artifact paths.
- `capture.log`: adapter log for the row.
- Optional capture artifact, copied into the row artifact directory.

Each run writes:

- `summary.json`: aggregate verdict and all row results.

## Local Commands

```bash
npm run capture-matrix:local
npm run capture-matrix:macos:screencapture
npm run capture-matrix:macos:cgwindow
npm run capture-matrix:windows:stub
npm run capture-matrix:browser:get-display-media
npm run capture-matrix:external:manual
```

Live macOS rows skip until `NATIVELY_CAPTURE_MATRIX_CANARY_ARMED=1` is set.
Set it only after the generated canary fixture is visible in the protected or
control test surface for the row being qualified.

ScreenCaptureKit remains explicit opt-in for release qualification because it
can trigger macOS capture indicators. Meeting-app adapters are tracked by
manual rows that skip until a capture artifact is supplied and analyzed.
