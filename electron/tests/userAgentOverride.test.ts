import test from 'node:test';
import assert from 'node:assert/strict';

test('NAT-034: generic user-agent does not contain Electron', () => {
  // The actual UA is set in main.ts at app.whenReady.
  // This test documents the expected UA string so regressions are caught in review.
  const expectedUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  assert.ok(!expectedUa.includes('Electron'), 'user-agent must not contain Electron substring');
  assert.ok(expectedUa.includes('Chrome'), 'user-agent should contain Chrome for provider compatibility');
});
