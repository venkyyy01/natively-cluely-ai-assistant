# Stealth macOS Layer 3 Production Program

## Goal
Define the production program required to deliver complete macOS-only Layer 3 functionality outside the main Electron repo: the Layer 2 native display/compositor prerequisite, the secure presentation path, and the validation, signing, rollout, rollback, QA, telemetry, and support model needed to ship it.

## Understanding Summary
- This document is a standalone spec plus implementation plan for the macOS-only Layer 3 program.
- Kernel-adjacent work is explicitly deferred and is not part of this spec.
- The canonical layer numbering and claim boundary from `electron/stealth/implementation-plan.md` remain unchanged.
- The current Electron app remains the broker and policy surface, not the final renderer for sensitive pixels.
- The program includes the Layer 2 macOS secure-display/compositor dependency because Layer 3 cannot be made real without it.
- The deliverable covers architecture, ownership, signing, rollout, rollback, QA, telemetry, support, and release gates.
- If a canonical macOS Layer 3 path cannot be proven, this program ends in a no-go decision rather than shipping a weaker claim.

## Assumptions
- The macOS path will be delivered through separate native artifacts, not folded into the shipping Electron repo.
- Sensitive pixels must move out of the Electron `BrowserWindow` path and into a native secure presentation path.
- The current `macos-virtual-display-helper` boundary is the natural home for the secure presentation system.
- The current `integration-harness` boundary is the natural home for repeatable Layer 3 validation.
- `kernel-security-program` remains deferred and is only revisited if Layer 3 ships and product requirements later still demand Layer 4.

## Decision Log
- Scope narrowed to macOS only.
- Scope stops at Layer 3; all kernel-adjacent work is deferred.
- The program includes Layer 2 prerequisites because Layer 3 without a secure display/compositor path is not executable.
- Electron remains a broker, not the owner of high-assurance presentation.
- Sensitive presentation uses a dedicated native UI host, not Electron offscreen output.
- Technology stance: prefer Apple-native implementation first (Swift/Objective-C++, AppKit, Metal, XPC, `SMAppService`); use Rust only if a later low-level component proves materially better without reducing stability.
- This spec has only one shippable outcome: a full macOS Layer 3 release. If the feasibility or validation gates fail, the program ends in a no-go decision.

## Scope

### In Scope
- macOS Layer 2 prerequisite work required for complete Layer 3 delivery
- macOS Layer 3 secure presentation architecture and implementation plan
- signing, entitlement, installer, rollback, QA, telemetry, support, and release requirements
- integration harness and adversary-matrix validation for macOS
- macOS TCC/privacy-permission strategy needed to run validation repeatedly and support the shipped system

### Out Of Scope
- Layer 4 and any kernel-adjacent deliverable
- Windows Layer 2/3/4 delivery
- modifying the main Electron app to claim Layer 3 readiness today
- shipping unmanaged or unsigned privileged artifacts
- marketing claims beyond measured macOS support coverage

## Threat And Claim Boundary

### Threat Target
- Primary target: a macOS program designed to reach the canonical Layer 3 claim only if the explicit feasibility and validation gates pass

### Claim Boundary
- Layer 3 retains the canonical meaning: a hardware-protected GPU presentation path intended to resist the documented L1-L4 capture classes for the supported macOS matrix.
- If validation cannot prove that outcome, this program does not ship.

### M1 Claim Matrix

| Area | Required Layer 3 outcome | Current M1 status | M1 exit evidence |
|---|---|---|---|
| Sensitive presenter ownership | Sensitive pixels are rendered by the native presenter, not Electron windows | Planned | Sequence/data-flow review shows no Electron-owned sensitive pixel path |
| `CGVirtualDisplay` + compositor prerequisite | Isolated display/control plane exists for the secure presenter | Planned | Native architecture doc and lifecycle diagrams approved |
| Physical-display presentation primitive | A concrete macOS-supported hardware-protected presentation mechanism is identified | Unproven | Written go/no-go decision with named primitive and constraints |
| `ScreenCaptureKit` resistance | Capture probes do not recover guarded pixels on supported test machines | Unproven | Harness evidence across approved machine matrix |
| Chromium/WebRTC-class resistance | Browser/share paths do not recover guarded pixels on supported test machines | Unproven | Harness evidence across Chrome/Meet/WebRTC validation flows |
| Mission Control / Spaces / Stage Manager | Secure presenter does not leak or surface guarded pixels during OS transitions | Planned | Window-management validation report passes |
| Sleep / wake / hot-plug / clamshell | Session recovers safely without exposing guarded pixels | Planned | Lifecycle validation report passes |
| TCC / Screen Recording operability | Permission state handling is repeatable for QA, support, and field recovery | Planned | TCC workflow doc and repeatable reset/run procedure approved |
| Ship decision | Release only if canonical Layer 3 claim is proven | Fixed | Final release gate is `go` or `no-go`, never degraded-claim ship |

### M1 Support And Distribution Matrix

| Dimension | M1 frozen assumption | Why |
|---|---|---|
| Distribution model | Managed direct distribution only | Layer 3 validation depends on repeatable installer, entitlement, rollback, and permission handling |
| Mac App Store | Not supported | Secure presenter, companion lifecycle, and validation workflows should not be constrained by MAS rules during Layer 3 proof |
| Primary hardware target | Apple Silicon Macs on the active supported macOS matrix | Lowest-risk target for native presenter and display-path validation |
| Secondary validation target | Intel Macs are validation-only until the physical-display mechanism is proven stable there | Avoids overcommitting support before the core mechanism is proven |
| OS validation floor | macOS 14+ for Layer 3 program validation | Keeps the secure-presenter and TCC behavior on a narrower, supportable matrix while the mechanism is still unproven |
| Display topology | Single-display and controlled multi-display setups only during proof phase | Hot-plug/clamshell/Spaces behavior must be measured before broadening support |
| Capture matrix | `ScreenCaptureKit`, Chromium/WebRTC-class paths, QuickTime, OBS, Zoom, Teams, Meet | Matches the claim and validation gates in this program |

These are the frozen M1 planning assumptions. Broadening the support matrix is a later decision and only happens after the canonical Layer 3 mechanism is proven.

## Non-Functional Requirements
- Performance: secure presentation must sustain target interaction and animation rates without visible tearing or instability.
- Reliability: secure-session creation, crash recovery, teardown, and rollback must be deterministic.
- Security: privileged operations must be least-privilege, signed, auditable, and revocable.
- Privacy: telemetry must never contain sensitive content; only state, timing, capability, permission, and failure metadata are allowed.
- Maintainability: each native artifact must have an owner, CI lane, release checklist, and support playbook.
- Supportability: every failure path must degrade safely and explain why the high-assurance path is unavailable.

## Platform Reality Check
- There is no public third-party equivalent to the Windows D3D11 protected-swap-chain story on macOS.
- No currently approved macOS-supported physical-display presentation mechanism is known in this repo that satisfies the canonical Layer 3 definition.
- A credible macOS Layer 3 program therefore begins as a prove-or-stop program: either identify a real hardware-protected GPU presentation path that satisfies the canonical definition, or end in a no-go decision.
- A credible Layer 3 program also requires the full `CGVirtualDisplay` plus overlay/compositor workstream from the separate-project blueprint.

## Recommended Architecture

### 1. Electron Control Plane
Electron becomes a broker for policy and session control only.

Responsibilities:
- authenticate the user and session
- decide when a secure session should start or stop
- hand non-sensitive model and state data to the native secure presentation system
- receive capability, health, permission, and telemetry status
- tear down sessions cleanly on app exit, crash, sleep/wake, and policy changes

Required API surface:
- `probeCapabilities()`
- `createProtectedSession()`
- `attachSurface()`
- `present()`
- `teardownSession()`
- `getHealth()`
- `getTelemetry()`

### 1.1 Apple-Native Control Plane Contract
The control plane is a command-oriented broker contract between Electron and the native presenter.

Contract rules:
- transport is Apple-native (`XPC`) behind the native presenter boundary
- requests are session-scoped and idempotent where possible
- every response is explicit about `ok`, `degraded`, or `blocked`
- blocked states must include machine-readable reasons so the app can fail closed

M1 contract surface:
- `probeCapabilities`: returns OS version, presenter availability, `CGVirtualDisplay` availability, TCC state, and known blockers
- `createProtectedSession`: allocates a secure-presenter session and declares the requested presentation mode
- `attachSurface`: binds a native scene or surface descriptor owned by the presenter
- `present`: transitions the presenter into active guarded presentation on the target display path
- `teardownSession`: releases presentation resources and returns to a safe idle state
- `getHealth`: returns session state, recovery status, and exposure-risk flags
- `getTelemetry`: returns redacted session events and validation-facing counters

The authoritative TypeScript contract for these calls lives in `electron/stealth/separateProjectContracts.ts`.

### 2. macOS Secure Presentation System
This is the main program deliverable, built by expanding the existing `macos-virtual-display-helper` boundary into the full secure presentation system.

Responsibilities:
- own the `CGVirtualDisplay` session lifecycle and overlay/compositor path
- own the high-assurance rendering path for sensitive content
- render outside the ordinary Electron window path
- manage display/session lifecycle, crash recovery, and health reporting
- manage Mission Control, Spaces, fullscreen transitions, Stage Manager, display hot-plug, clamshell, and fast user/session switching behavior for the secure presenter
- isolate native presentation code from the Electron process boundary
- enforce safe teardown and rollback if the path becomes unhealthy

Required subcomponents:
- native secure presenter app/service written in Swift/Objective-C++ with Metal-capable rendering
- `CGVirtualDisplay` manager plus overlay/compositor path
- dedicated native UI host for sensitive presentation
- installer/update/rollback lane
- entitlement and signing policy bundle
- telemetry and health reporter

Design constraint:
- sensitive UI must be rendered by the secure presenter through the native UI host, not by an Electron `BrowserWindow` that is merely copied elsewhere.

Chosen candidate presentation mechanism:
- the secure presenter owns the sensitive scene graph natively
- the secure presenter renders with Metal into native textures or IOSurfaces that it controls
- the secure presenter owns the physical-display presentation through a native fullscreen presentation surface tied to the compositor path
- the `CGVirtualDisplay` path is used as the prerequisite isolated display and control plane
- this mechanism is a candidate only; no release may proceed until a concrete macOS-supported path is proven to satisfy the canonical Layer 3 claim without falling back into a normally capturable path

### 3. macOS Process And Privilege Topology
The program chooses a concrete macOS runtime shape.

Process model:
- the Electron app remains the interactive shell and policy broker
- a bundled signed companion app provides the secure presenter UI host
- the companion app is managed through `SMAppService` for controlled lifecycle and recovery
- the Electron app talks to the presenter through XPC for session control and health reporting

Privilege model:
- keep the presenter path unprivileged
- no privileged capability is allowed to leak into the Electron process
- any future kernel-adjacent work remains outside this spec and outside the Layer 3 runtime boundary

### 4. macOS Integration Harness
This is the verification boundary, represented by `integration-harness`.

Responsibilities:
- run the adversary-matrix capture validation
- run first-party API-level capture probes, including `ScreenCaptureKit` and Chromium/WebRTC-class validation paths
- validate install, rollback, uninstall, crash recovery, sleep/wake, TCC state changes, multi-display behavior, Mission Control, Spaces, Stage Manager, hot-plug, clamshell, and fast user/session switching
- produce repeatable evidence for the final release gate

## What Is Needed

### Technical Requirements
- separate native artifact boundaries matching the current scaffold set: `macos-virtual-display-helper` and `integration-harness`
- shared control-plane contract between Electron and the native secure presentation system
- crash-safe session manager and watchdog integration
- signed installer/update path for every native artifact
- macOS capability detection and environment validation
- repeatable capture-validation automation
- Apple-native implementation is the default path for the secure presenter and control-plane runtime; cross-language additions are optional, not assumed.

### People And Ownership
- Swift/Metal macOS engineer
- macOS platform/security engineer for entitlements, signing, and system behavior
- release engineer for notarization, installer, rollback, and managed deployment
- security/compliance owner
- QA lead with hardware-lab responsibility
- on-call owner for runtime failures in the secure path

### Environment And Lab Needs
- Apple Silicon and Intel macOS test machines
- capture-tool matrix: Zoom, Teams, Meet, OBS, QuickTime, and OS-native tools
- signed build infrastructure and secret-management controls
- reproducible install/rollback/uninstall test rigs
- TCC permission-reset workflow for Screen Recording and related validation flows
- monitor-lab coverage for hot-plug, clamshell, fullscreen/Spaces, and multi-user/session transition testing

### Program Dependencies
- Apple signing, notarization, and entitlement approval path
- managed direct distribution approval and installer policy
- support commitment for failure modes that disable the secure path
- documented TCC/privacy-permission handling for QA, support, and field recovery

## Release Structure
- There is one final customer-facing release gate for the macOS Layer 3 program.
- Internally, each native artifact still needs its own readiness gate: architecture complete, build reproducible, signing ready, install/rollback validated, telemetry wired, and validation harness coverage present.
- The final release gate is blocked until all artifact gates are green.
- If any hard gate fails, this program produces a no-go decision and does not ship under this spec.

## Hard Gates

### Gate A: Layer 2 Prerequisites Are Real
- The `CGVirtualDisplay` plus overlay/compositor path must be specified as a production workstream, not an implied dependency.

### Gate B: Physical-Display Layer 3 Mechanism Exists
- A concrete macOS-supported physical-display presentation mechanism must be identified and validated against the canonical Layer 3 definition.
- If no such mechanism is proven, this program does not ship.

### Gate C: Secure Presentation Ownership
- Confirm that sensitive UI can be rendered by the native secure presenter instead of Electron.
- If product requirements depend on arbitrary Electron DOM pixels, the program is blocked until that dependency is removed.

### Gate D: TCC And Validation Operability
- The program must define how Screen Recording and related permissions are requested, reset, tested, and supported across lab and field environments.
- If permission handling cannot be made repeatable, the validation program is not considered production-ready.

### Gate E: Operational Readiness
- No final release without installer, rollback, telemetry, support, and incident-response ownership.

## Repository And Artifact Split
- `macos-virtual-display-helper/` -> expand into the macOS secure presenter plus `CGVirtualDisplay` and overlay/compositor system
- `integration-harness/` -> macOS Layer 3 validation tooling and repeatable QA automation
- shared contract updates remain reflected in `electron/stealth/separateProjectContracts.ts` until they move into a dedicated native-program contract package
- `kernel-security-program/` is deferred outside this spec

## Program Sequence
- **M1:** Freeze claim, support matrix, canonical project boundaries, and control-plane contracts
- **M2:** Complete the macOS secure presentation architecture, dedicated native UI host, concrete process topology, and `CGVirtualDisplay` plus overlay/compositor design
- **M3:** Complete the physical-display Layer 3 mechanism decision, TCC strategy, and macOS signing/install/rollback/uninstall/support model
- **M4:** Complete `integration-harness` adversary-matrix coverage and operational readiness gates
- **M5:** Complete the final combined release gate

## Implementation Plan

## Goal
Deliver a final production release for the external macOS Layer 3 program only after all technical and operational gates pass.

## Tasks
- [ ] Task 1: Freeze the macOS Layer 3 product claim, support matrix, and managed distribution assumptions. -> Verify: approved claim table exists with explicit no-claim paths where feasibility is unproven.
- [ ] Task 2: Define the shared control-plane and telemetry contracts between Electron and the native secure presentation system, and update `electron/stealth/separateProjectContracts.ts` to reflect the Layer 3-focused native artifacts and deferred kernel scope. -> Verify: `probe/create/attach/present/teardown/health/telemetry` schemas and project readiness states are documented with failure semantics.
- [ ] Task 3: Expand `macos-virtual-display-helper` into the full macOS secure presentation architecture: `CGVirtualDisplay`, overlay/compositor, native secure presenter, and dedicated native UI host. -> Verify: sequence diagrams and data-flow docs show no Electron-owned sensitive pixel path in the final design.
- [ ] Task 4: Choose and document the concrete macOS process topology: bundled companion app, `SMAppService` lifecycle, XPC control plane, and secure presenter recovery model. -> Verify: process, privilege, update, crash-recovery, and uninstall diagrams are documented.
- [ ] Task 5: Define the macOS secure-presenter window-management strategy for Mission Control, Spaces, Stage Manager, fullscreen transitions, hot-plug, clamshell, and fast user/session switching. -> Verify: lifecycle and exposure-risk handling is documented for each OS behavior.
- [ ] Task 6: Run the physical-display Layer 3 mechanism decision and document whether a concrete macOS-supported path exists that satisfies the canonical Layer 3 definition. -> Verify: written go/no-go decision exists for the physical-display mechanism; if no-go, this program is closed as a no-ship outcome.
- [ ] Task 7: Define the macOS signing, entitlement, installer, managed deployment, update, rollback, uninstall behavior, and support model. -> Verify: install/uninstall/rollback/support flows and ownership are documented end to end.
- [ ] Task 8: Define the macOS TCC/privacy-permission strategy for QA, automation, support, and field recovery. -> Verify: Screen Recording permission request/reset/support flows are documented and tied to test execution.
- [ ] Task 9: Design `integration-harness` adversary-matrix automation and API-level capture probes for macOS. -> Verify: validation matrix covers `ScreenCaptureKit`, Chromium/WebRTC-class capture, capture tools, sleep/wake, crash recovery, multi-display, install/rollback/uninstall, and unsupported environments.
- [ ] Task 10: Define per-artifact readiness gates and the single final combined release gate. -> Verify: the final release checklist blocks shipment on missing signing, missing rollback, unresolved feasibility gates, or unproven capture outcomes.
- [ ] Task 11: Write the implementation backlog for the macOS native projects and wire it into the separate-project blueprint. -> Verify: every major workstream has an owning artifact, dependency list, and acceptance criteria.

## Done When
- [ ] The macOS Layer 2 secure-display/compositor prerequisite is explicitly included and specified.
- [ ] The macOS Layer 3 architecture is specified with honest platform constraints.
- [ ] The final release gate is claim-driven, testable, and blocked on feasibility, signing, rollback, QA, and support readiness.
- [ ] The spec clearly states what must be built, what must be validated, and what can block release.

## Validation Plan
- Validate the document against the current repo boundary docs: `electron/stealth/implementation-plan.md`, `electron/stealth/separateProjectContracts.ts`, and `stealth-separate-project-blueprint.md`.
- Validate architecture honesty: no section may imply that Electron alone can deliver Layer 3.
- Validate boundary honesty: project names, readiness states, and prerequisite workstreams must match the current scaffolded boundary docs.
- Validate layer honesty: Layer 3 must retain the canonical hardware-protected meaning rather than being redefined as ordinary user-space resistance.
- Validate operational completeness: signing, installer, rollback, uninstall, telemetry, support, TCC strategy, and QA must appear as first-class workstreams.

## Risks
- macOS may not expose a viable physical-display mechanism that satisfies the canonical Layer 3 claim.
- Product requirements may depend too heavily on Electron-rendered pixels to move sensitive UI into a native secure presenter.
- Entitlement, signing, notarization, and managed-deployment approvals may dominate schedule risk more than code.
- TCC permission management may make repeatable validation and support harder than expected.
- Hardware and capture-tool variance may make support coverage narrower than desired.

## Recommendation
Treat this as a macOS production security program, not an app feature. The first blocking decision is not code; it is whether a canonical macOS Layer 3 path is technically supportable after the full secure presentation path is designed. If that answer is weak, this program should end in a no-go decision instead of a weaker ship.

Implementation preference: start with the macOS-native stack that Apple supports best, then add non-native components only if the Apple-native path proves insufficient.
