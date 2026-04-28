#!/usr/bin/env node
/**
 * NAT-082 — Stealth Capture Fixture Runner
 *
 * Usage:
 *   node scripts/run-stealth-capture-fixture.js [mock|live]
 *
 * mock mode (default): validates fixture structure without SCK.
 * live mode: requires macOS + screen-recording entitlement + SCK helper binary.
 */

const { StealthCaptureFixture, getDefaultProtectedWindows } = require('../dist-electron/electron/stealth/StealthCaptureFixture.js');

async function main() {
  const mode = process.argv[2] || 'mock';
  console.log(`Running stealth capture fixture in ${mode} mode...`);

  const fixture = new StealthCaptureFixture({ mode });
  const windows = getDefaultProtectedWindows();
  const results = await fixture.run(windows);

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${result.window}${result.reason ? ` — ${result.reason}` : ''}`);
    if (result.passed) passed += 1;
    else failed += 1;
  }

  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Stealth capture fixture failed:', err);
  process.exitCode = 1;
});
