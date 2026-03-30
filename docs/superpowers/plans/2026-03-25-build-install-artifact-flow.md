# Build Install Artifact Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `build-and-install.sh` always clean old outputs, package the latest code, and clearly surface the fresh artifact paths before install.

**Architecture:** Keep the existing single-entry shell workflow, but tighten its packaging contract. Add sourceable shell helpers for artifact cleanup/discovery plus a non-install smoke-test mode so the script can be verified without copying into `/Applications`.

**Tech Stack:** Bash, Node.js `node:test`, npm, electron-builder

---

### Task 1: Add sourceable helpers and regression coverage

**Files:**
- Create: `scripts/tests/build-and-install-artifacts.test.js`
- Modify: `build-and-install.sh`

- [ ] **Step 1: Write the failing test**

Create a Node `node:test` file that invokes `bash -lc 'source build-and-install.sh; ...'` in a helper-only mode and asserts: (1) artifact discovery selects the newest `.app`, `.dmg`, and `.zip` by mtime inside `release/`; (2) cleanup removes seeded stale `release/mac/Natively.app` and `release/mac-arm64/Natively.app` directories plus old top-level package files; and (3) missing `.app` fails clearly.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/tests/build-and-install-artifacts.test.js`
Expected: FAIL because the shell script does not yet expose sourceable helper functions or helper-only mode.

- [ ] **Step 3: Write minimal implementation**

Add a `BUILD_AND_INSTALL_LIB=1` guard so the file can be sourced safely in tests, then extract small shell helpers for locating the newest `.app`, `.dmg`, and `.zip` outputs after packaging.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/tests/build-and-install-artifacts.test.js`
Expected: PASS.

### Task 2: Tighten cleanup and packaging output contract

**Files:**
- Modify: `build-and-install.sh`

- [ ] **Step 1: Update cleanup scope**

Ensure the script removes these stale targets before a new run: `release/mac/Natively.app`, `release/mac-arm64/Natively.app`, `release/*.dmg`, `release/*.zip`, `release/*.blockmap`, `release/*.yml`, root `*.dmg`, root `*.zip`, and root `*.blockmap`.

- [ ] **Step 2: Make packaging output explicit**

After `npm run app:build`, gather fresh artifact paths, fail if the packaged `.app` is missing, and print the generated `.app`, `.dmg`, and `.zip` paths clearly. Missing `.dmg`/`.zip` should warn, not fail.

- [ ] **Step 3: Keep install sourced from fresh package**

Use the discovered fresh `.app` path for signing, manifest verification, and installation.

- [ ] **Step 4: Add a smoke-test mode**

Add `SKIP_INSTALL=1` support so the script can stop after artifact/signing/verification output without copying into `/Applications`, and log that installation was skipped intentionally.

### Task 3: Verify end-to-end behavior

**Files:**
- Verify: `build-and-install.sh`
- Verify: `scripts/tests/build-and-install-artifacts.test.js`

- [ ] **Step 1: Run targeted regression test**

Run: `node --test scripts/tests/build-and-install-artifacts.test.js`
Expected: PASS.

- [ ] **Step 2: Run shell syntax verification**

Run: `bash -n build-and-install.sh`
Expected: exit 0.

- [ ] **Step 3: Run script smoke test**

Run: `SKIP_INSTALL=1 ./build-and-install.sh`
Expected: exit 0, printed artifact paths, explicit "install skipped" output, no copy into `/Applications`.

- [ ] **Step 4: Run packaging verification command**

Run: `npm run app:build`
Expected: fresh release artifacts generated under `release/`.
