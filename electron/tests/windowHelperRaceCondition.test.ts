import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Logic verification tests for the boot/window-creation race condition protection
 * in WindowHelper (Task 4: S-RACE-1, S-RACE-2, S-RACE-3).
 *
 * Since WindowHelper has heavy Electron dependencies (BrowserWindow, screen, app),
 * we test the race condition protection logic in isolation by extracting the key
 * invariants and verifying them against mock implementations.
 *
 * Key invariants tested:
 * 1. createDirectWindow always forces show: false regardless of input options
 * 2. requestWindowShow calls verifyProtectionBeforeShow before showing
 * 3. If verification fails, the window is NOT shown
 * 4. waitForStealthReady() must resolve before windows can be shown
 */

// --- Mock infrastructure ---

interface MockWindow {
  id: number;
  shown: boolean;
  destroyed: boolean;
  contentProtectionEnabled: boolean;
  sckExclusionApplied: boolean;
  options: Record<string, unknown>;
}

interface ProtectionEvent {
  type: string;
  windowId: number;
  source: string;
}

function createMockWindow(options: Record<string, unknown> = {}): MockWindow {
  return {
    id: Math.floor(Math.random() * 10000),
    shown: false,
    destroyed: false,
    contentProtectionEnabled: false,
    sckExclusionApplied: false,
    options,
  };
}

function createMockStealthManager(opts: {
  enabled?: boolean;
  verifyResult?: boolean;
} = {}) {
  const { enabled = true, verifyResult = true } = opts;
  const appliedWindows: number[] = [];

  return {
    isEnabled: () => enabled,
    applyInitialStealth: (win: MockWindow) => {
      win.contentProtectionEnabled = true;
      win.sckExclusionApplied = true;
      appliedWindows.push(win.id);
    },
    verifyStealth: (_win: MockWindow) => verifyResult,
    getAppliedWindows: () => appliedWindows,
  };
}

// --- Extracted logic under test ---

/**
 * Replicates the createDirectWindow logic from WindowHelper.
 * S-RACE-2: Forces show: false regardless of caller options.
 * S-RACE-1: Applies initial stealth synchronously before returning.
 */
function createDirectWindow(
  options: Record<string, unknown>,
  stealthManager: ReturnType<typeof createMockStealthManager>,
): MockWindow {
  // S-RACE-2: Force show: false to guarantee the window is born hidden.
  const win = createMockWindow({ ...options, show: false });

  // S-RACE-1: Apply Layer-0 capture protection synchronously
  stealthManager.applyInitialStealth(win);

  return win;
}

/**
 * Replicates the verifyProtectionBeforeShow logic from WindowHelper.
 * Returns true if the window is safe to show, false if it should remain hidden.
 */
function verifyProtectionBeforeShow(
  win: MockWindow | null,
  stealthManager: ReturnType<typeof createMockStealthManager>,
  events: ProtectionEvent[],
  source: string,
): boolean {
  // Skip verification if stealth is not enabled or window is invalid
  if (!win || win.destroyed || !stealthManager.isEnabled()) {
    return true;
  }

  // Verify stealth protection including SCK exclusion on the window
  const verified = stealthManager.verifyStealth(win);
  if (!verified) {
    // Keep window hidden — do NOT show it
    events.push({ type: 'verification-failed', windowId: win.id, source });
    return false;
  }

  return true;
}

/**
 * Replicates the requestWindowShow logic from WindowHelper.
 * S-RACE-3: Verify stealth protection before allowing the window to become visible.
 */
function requestWindowShow(
  win: MockWindow | null,
  stealthManager: ReturnType<typeof createMockStealthManager>,
  events: ProtectionEvent[],
  source: string,
): void {
  if (!verifyProtectionBeforeShow(win, stealthManager, events, source)) {
    return;
  }

  events.push({ type: 'show-requested', windowId: win!.id, source });
  win!.shown = true;
  events.push({ type: 'shown', windowId: win!.id, source });
}

/**
 * Replicates the stealthReadyPromise gate logic from WindowHelper.
 * Windows cannot be shown until this gate resolves.
 */
function createStealthReadyGate(stealthEnabled: boolean, timeoutMs = 5000) {
  let stealthReadyResolve: (() => void) | null = null;
  let stealthReadyPromise: Promise<void>;
  let timedOut = false;

  if (!stealthEnabled) {
    stealthReadyPromise = Promise.resolve();
  } else {
    stealthReadyPromise = new Promise<void>((resolve) => {
      stealthReadyResolve = resolve;
    });

    setTimeout(() => {
      if (stealthReadyResolve) {
        timedOut = true;
        stealthReadyResolve();
        stealthReadyResolve = null;
      }
    }, timeoutMs);
  }

  return {
    waitForStealthReady: () => stealthReadyPromise,
    markStealthReady: () => {
      if (stealthReadyResolve) {
        stealthReadyResolve();
        stealthReadyResolve = null;
      }
    },
    didTimeout: () => timedOut,
  };
}

// --- Tests ---

test('createDirectWindow always forces show: false regardless of input options', () => {
  const stealthManager = createMockStealthManager({ enabled: true });

  // Even if caller passes show: true, createDirectWindow overrides it
  const win = createDirectWindow({ show: true, width: 800, height: 600 }, stealthManager);

  assert.equal(win.options.show, false, 'Window options must have show: false');
  assert.equal(win.shown, false, 'Window must not be shown after creation');
});

test('createDirectWindow applies stealth protection synchronously during creation', () => {
  const stealthManager = createMockStealthManager({ enabled: true });

  const win = createDirectWindow({ width: 800, height: 600 }, stealthManager);

  assert.equal(win.contentProtectionEnabled, true, 'Content protection must be applied');
  assert.equal(win.sckExclusionApplied, true, 'SCK exclusion must be applied');
  assert.ok(
    stealthManager.getAppliedWindows().includes(win.id),
    'Window must be tracked in applied windows',
  );
});

test('createDirectWindow forces show: false even when options explicitly set show: true', () => {
  const stealthManager = createMockStealthManager({ enabled: true });

  // Simulate various caller option combinations
  const testCases = [
    { show: true },
    { show: true, transparent: true },
    { show: true, frame: false },
    { show: undefined },
    {},
  ];

  for (const options of testCases) {
    const win = createDirectWindow(options, stealthManager);
    assert.equal(
      win.options.show,
      false,
      `Window must have show: false for input: ${JSON.stringify(options)}`,
    );
    assert.equal(win.shown, false, 'Window must not be visible');
  }
});

test('requestWindowShow calls verifyProtectionBeforeShow before showing', () => {
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: true });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);

  requestWindowShow(win, stealthManager, events, 'test.show');

  // Window should be shown since verification passes
  assert.equal(win.shown, true, 'Window should be shown when verification passes');
  assert.ok(
    events.some((e) => e.type === 'show-requested'),
    'show-requested event should be recorded',
  );
  assert.ok(
    events.some((e) => e.type === 'shown'),
    'shown event should be recorded',
  );
});

test('requestWindowShow does NOT show window when verification fails', () => {
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: false });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);

  requestWindowShow(win, stealthManager, events, 'test.failedVerification');

  // Window must remain hidden
  assert.equal(win.shown, false, 'Window must NOT be shown when verification fails');
  assert.ok(
    events.some((e) => e.type === 'verification-failed'),
    'verification-failed event should be recorded',
  );
  assert.ok(
    !events.some((e) => e.type === 'shown'),
    'shown event must NOT be recorded',
  );
});

test('verifyProtectionBeforeShow returns true when stealth is disabled (skip verification)', () => {
  const stealthManager = createMockStealthManager({ enabled: false, verifyResult: false });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);

  const result = verifyProtectionBeforeShow(win, stealthManager, events, 'test.disabled');

  assert.equal(result, true, 'Should return true when stealth is disabled');
  assert.equal(events.length, 0, 'No events should be recorded');
});

test('verifyProtectionBeforeShow returns true for null window', () => {
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: false });
  const events: ProtectionEvent[] = [];

  const result = verifyProtectionBeforeShow(null, stealthManager, events, 'test.null');

  assert.equal(result, true, 'Should return true for null window');
});

test('verifyProtectionBeforeShow returns true for destroyed window', () => {
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: false });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);
  win.destroyed = true;

  const result = verifyProtectionBeforeShow(win, stealthManager, events, 'test.destroyed');

  assert.equal(result, true, 'Should return true for destroyed window');
});

test('waitForStealthReady must resolve before windows can be shown', async () => {
  const gate = createStealthReadyGate(true, 60000);
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: true });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);

  let windowShown = false;

  // Simulate the pattern: await stealthReady, then show
  const showSequence = gate.waitForStealthReady().then(() => {
    requestWindowShow(win, stealthManager, events, 'test.afterReady');
    windowShown = true;
  });

  // Before markStealthReady, window should not be shown
  await Promise.resolve();
  assert.equal(windowShown, false, 'Window must not be shown before stealth is ready');
  assert.equal(win.shown, false, 'Window must remain hidden before stealth is ready');

  // Mark stealth ready
  gate.markStealthReady();
  await showSequence;

  assert.equal(windowShown, true, 'Window should be shown after stealth is ready');
  assert.equal(win.shown, true, 'Window must be visible after stealth ready + verification');
});

test('window remains hidden if stealth gate never resolves (until timeout)', async () => {
  const gate = createStealthReadyGate(true, 50); // short timeout
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: true });
  const events: ProtectionEvent[] = [];
  const win = createDirectWindow({}, stealthManager);

  let windowShown = false;

  gate.waitForStealthReady().then(() => {
    requestWindowShow(win, stealthManager, events, 'test.afterTimeout');
    windowShown = true;
  });

  // Immediately after creation, window is not shown
  await Promise.resolve();
  assert.equal(windowShown, false, 'Window must not be shown before gate resolves');

  // Wait for timeout
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(windowShown, true, 'Window should be shown after timeout resolves gate');
  assert.equal(gate.didTimeout(), true, 'Gate should indicate timeout occurred');
});

test('full race condition protection sequence: create → gate → verify → show', async () => {
  const gate = createStealthReadyGate(true, 60000);
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: true });
  const events: ProtectionEvent[] = [];

  // Step 1: Create window (born hidden, stealth applied synchronously)
  const win = createDirectWindow({ show: true }, stealthManager);
  assert.equal(win.options.show, false, 'S-RACE-2: show forced to false');
  assert.equal(win.contentProtectionEnabled, true, 'S-RACE-1: protection applied at creation');
  assert.equal(win.shown, false, 'Window is hidden after creation');

  // Step 2: Await stealth ready gate
  let revealed = false;
  const revealSequence = gate.waitForStealthReady().then(() => {
    // Step 3: Verify protection before show (S-RACE-3)
    requestWindowShow(win, stealthManager, events, 'test.fullSequence');
    revealed = true;
  });

  await Promise.resolve();
  assert.equal(revealed, false, 'Window not revealed before gate resolves');

  // Step 4: Gate resolves (stealth fully initialized)
  gate.markStealthReady();
  await revealSequence;

  assert.equal(revealed, true, 'Window revealed after full sequence');
  assert.equal(win.shown, true, 'Window is visible');
  assert.ok(
    events.some((e) => e.type === 'shown'),
    'shown event recorded',
  );
});

test('full sequence with verification failure: window stays hidden even after gate resolves', async () => {
  const gate = createStealthReadyGate(true, 60000);
  // Verification will FAIL
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: false });
  const events: ProtectionEvent[] = [];

  const win = createDirectWindow({}, stealthManager);

  let revealed = false;
  const revealSequence = gate.waitForStealthReady().then(() => {
    requestWindowShow(win, stealthManager, events, 'test.failedFullSequence');
    revealed = true;
  });

  gate.markStealthReady();
  await revealSequence;

  // Even though the gate resolved, verification failed so window stays hidden
  assert.equal(revealed, true, 'Reveal sequence completed');
  assert.equal(win.shown, false, 'Window must remain hidden when verification fails');
  assert.ok(
    events.some((e) => e.type === 'verification-failed'),
    'verification-failed event recorded',
  );
  assert.ok(
    !events.some((e) => e.type === 'shown'),
    'shown event must NOT be recorded',
  );
});

test('multiple windows all respect the stealth gate independently', async () => {
  const gate = createStealthReadyGate(true, 60000);
  const stealthManager = createMockStealthManager({ enabled: true, verifyResult: true });
  const events: ProtectionEvent[] = [];

  const win1 = createDirectWindow({ title: 'launcher' }, stealthManager);
  const win2 = createDirectWindow({ title: 'overlay' }, stealthManager);

  let win1Shown = false;
  let win2Shown = false;

  gate.waitForStealthReady().then(() => {
    requestWindowShow(win1, stealthManager, events, 'test.win1');
    win1Shown = true;
  });

  gate.waitForStealthReady().then(() => {
    requestWindowShow(win2, stealthManager, events, 'test.win2');
    win2Shown = true;
  });

  await Promise.resolve();
  assert.equal(win1Shown, false, 'Win1 not shown before gate');
  assert.equal(win2Shown, false, 'Win2 not shown before gate');

  gate.markStealthReady();
  await Promise.resolve();
  await Promise.resolve(); // extra tick for both .then() to run

  assert.equal(win1Shown, true, 'Win1 shown after gate');
  assert.equal(win2Shown, true, 'Win2 shown after gate');
  assert.equal(win1.shown, true, 'Win1 visible');
  assert.equal(win2.shown, true, 'Win2 visible');
});
