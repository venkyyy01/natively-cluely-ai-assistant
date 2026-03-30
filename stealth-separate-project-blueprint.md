# Stealth Separate Project Blueprint

## Goal
Deliver the remaining stealth roadmap items that cannot be truthfully finished inside the current Electron app repository: virtual display isolation (Layer 2), hardware-protected GPU surfaces (Layer 3), and kernel-adjacent capture resistance (Layer 4).

## Scope Boundary
- Current repo now covers shipping Phase 1 and repo-feasible Phase 2 controls.
- Remaining work requires new native projects, signing, platform QA, and hardware-specific verification.
- Do not merge driver, protected-surface, or kernel-adjacent experiments directly into the main app branch without isolated build/test lanes.

## Workstreams

### 1. Virtual Display Isolation Program
- **Windows**: create a dedicated UMDF2 + IddCx virtual display driver project with installer, signer, and a small compositor service.
- **macOS**: create a native helper for `CGVirtualDisplay` management plus an overlay compositor path.
- **Electron integration**: expose a narrow IPC/control plane so the app can hand sensitive surfaces to the compositor only when the feature flag is enabled.
- **Definition of done**: sensitive content renders only on the isolated path and manual QA confirms the physical display capture path does not receive those pixels.

### 2. Hardware-Protected Surface Program
- **Windows only**: create a native rendering host that owns a D3D11 protected swap chain and protected textures.
- **Renderer bridge**: define a texture/surface handoff contract from Electron offscreen output or a dedicated native UI host.
- **Capability detection**: add GPU/driver support checks before enabling the path.
- **Definition of done**: supported GPUs render via protected surfaces and desktop duplication tests return protected/blank content for guarded regions.

### 3. Kernel-Adjacent Security Program
- **Windows**: separate WDDM-compatible driver exploration from the app repo; include signing, attestation, installer, rollback, and telemetry workstreams.
- **macOS**: evaluate whether DriverKit is actually needed after Layer 2 validation; do not assume parity with Windows kernel work.
- **Security review**: require dedicated legal/compliance/release approval before any kernel-adjacent distribution.
- **Definition of done**: signed artifacts install cleanly, pass platform policy gates, and survive rollback/uninstall tests.

## Suggested Repository Split
- `stealth-display-driver-windows/` -> IddCx driver, INF, installer, signing scripts
- `stealth-display-helper-macos/` -> `CGVirtualDisplay` helper + compositor helper
- `stealth-render-host-windows/` -> protected swap chain rendering host
- `stealth-integration-harness/` -> capture validation tooling, QA scripts, telemetry replay

## Milestones
- **M1**: virtual display proof-of-concept on one OS with capture validation harness
- **M2**: feature-gated integration with the Electron app in a dev environment
- **M3**: installer/signing pipeline and rollback support
- **M4**: production QA matrix across supported hardware/OS builds
- **M5**: release readiness review and support playbook

## Blocking Dependencies
- Microsoft/Apple platform signing and entitlement requirements
- hardware-specific validation machines
- capture-tool test matrix across Zoom, Teams, Meet, OBS, QuickTime, and OS-native tools
- distribution/rollback policy for driver or helper installation

## Done When
- [ ] Each deeper layer has its own repository or isolated package boundary
- [ ] Build/sign/install pipelines exist for the new native artifacts
- [ ] Manual capture validation is automated enough to be repeatable
- [ ] Release claims stay aligned with measured support coverage
