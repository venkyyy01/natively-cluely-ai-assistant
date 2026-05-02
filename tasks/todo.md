# Task Plan: Revalidate and Remediate Executive Summary Findings

This is the project-level task tracker for resolving the architectural issues identified in `reviews/**Executive Summary**.md`.

- [x] **Phase 1: Stealth & Runtime Lifecycle Fixes**
  - [x] FS-01: Fix Stealth containment fail-open `StealthSupervisor.ts` and set macOS heartbeat `main.ts`
  - [x] FS-02: Enforce finalizer cleanup even on error `RuntimeCoordinator.ts`
  - [x] FS-03: Aggregate listener errors for critical events `SupervisorBus.ts`
  - [x] FS-04: Abort properly on uncaught exceptions `main.ts`
  - [x] FS-05: Remove silent STT cross-vendor fallback `main.ts`
- [x] **Phase 2: Persistence & Conscious Mode Fixes**
  - [x] FS-06: Sanitize `meetingId` filenames `SessionPersistence.ts`
  - [x] CM-01: Remove self-grounding hypothesis text `ConsciousProvenanceVerifier.ts`
  - [x] CM-02: Hard `verification_degraded` return on timeout `ConsciousVerifier.ts`
  - [x] CM-03: Skip state restore if explicit toggle is off `SessionTracker.ts`
  - [x] CM-04: Add mode enum to retrieval to prevent caching pseudo embeddings
- [x] **Phase 3: Fault-Injection Tests**
  - [x] Prove renderer-hang scenario retains native lock-in
  - [ ] **Phase 4: Infrastructure & Git Maintenance**
    - [ ] Resolve git pull divergence (rebase `FoundationModel-silicon` onto `origin/FoundationModel-silicon`)
    - [ ] Verify linear history and system stability
