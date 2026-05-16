# Stealth Separate Project Blueprint

## Goal
Deliver the remaining stealth roadmap items that cannot be truthfully finished inside the current Electron app repository: virtual display isolation (Layer 2), hardware-protected GPU surfaces (Layer 3), and kernel-adjacent capture resistance (Layer 4).

Companion spec: `stealth-macos-layer3-program.md`

## Scope Boundary
- Current repo now covers shipping Phase 1 and repo-feasible Phase 2 controls.
- Remaining work requires new native projects, signing, platform QA, and hardware-specific verification.
- Do not merge driver, protected-surface, or kernel-adjacent experiments directly into the main app branch without isolated build/test lanes.

Canonical project names in this repo:
- `macos-virtual-display-helper`
- `windows-idd-driver`
- `windows-protected-render-host`
- `kernel-security-program`
- `integration-harness`

## Workstreams

### 1. Virtual Display Isolation Program
- **Windows**: create a dedicated UMDF2 + IddCx virtual display driver project with installer, signer, and a small compositor service.
- **macOS**: create a native helper for `CGVirtualDisplay` management plus an overlay compositor path.
- **Electron integration**: expose a narrow IPC/control plane so the app can hand sensitive surfaces to the compositor only when the feature flag is enabled.
- **Definition of done**: sensitive content renders only on the isolated path and manual QA confirms the physical display capture path does not receive those pixels.

### 2. Hardware-Protected Surface Program
- **Windows concrete path**: create a native rendering host that owns a D3D11 protected swap chain and protected textures.
- **macOS feasibility lane**: determine whether any macOS-supported hardware-protected GPU presentation path exists that can satisfy the canonical Layer 3 claim; if none exists, record a no-go decision instead of shipping a weaker Layer 3 claim.
- **Renderer bridge**: for the macOS Layer 3 path, require a dedicated native UI host rather than Electron offscreen output.
- **Capability detection**: add GPU/driver support checks before enabling the path.
- **Definition of done**: on macOS, either a canonical Layer 3 path is proven through API-level and adversary-matrix validation or the workstream ends in a documented no-go; on Windows, supported GPUs render via protected surfaces and desktop duplication tests return protected/blank content for guarded regions.

### 3. Kernel-Adjacent Security Program
- **Windows**: separate WDDM-compatible driver exploration from the app repo; include signing, attestation, installer, rollback, and telemetry workstreams.
- **macOS**: evaluate whether DriverKit is actually needed after Layer 2 validation; do not assume parity with Windows kernel work.
- **Security review**: require dedicated legal/compliance/release approval before any kernel-adjacent distribution.
- **Definition of done**: signed artifacts install cleanly, pass platform policy gates, and survive rollback/uninstall tests.

## Suggested Repository Split
- `macos-virtual-display-helper/` -> `CGVirtualDisplay` helper + compositor helper + secure presentation host
- `windows-idd-driver/` -> IddCx driver, INF, installer, signing scripts
- `windows-protected-render-host/` -> protected swap chain rendering host
- `kernel-security-program/` -> kernel-adjacent policy, signing, installer, rollback, and feasibility program assets
- `integration-harness/` -> capture validation tooling, QA scripts, telemetry replay

## Milestones
- **M1**: freeze the claim matrix, support/distribution assumptions, canonical project boundaries, and control-plane contracts
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
