import test from 'node:test';
import assert from 'node:assert/strict';

import { derivePrivacyShieldState } from '../stealth/privacyShieldState';

test('PrivacyShieldState activates when capture-risk warnings are present', () => {
  assert.deepEqual(
    derivePrivacyShieldState({ warnings: ['chromium_capture_active'] }),
    {
      active: true,
      reason: 'Sensitive content hidden while capture risk is detected.',
    },
  );
});

test('PrivacyShieldState activates on stealth faults until protection is restored', () => {
  assert.deepEqual(
    derivePrivacyShieldState({ faultReason: 'stealth heartbeat missed' }),
    {
      active: true,
      reason: 'Sensitive content hidden until privacy protection is restored.',
    },
  );
});

test('PrivacyShieldState ignores non-capture degradation warnings', () => {
  assert.deepEqual(
    derivePrivacyShieldState({ warnings: ['private_api_failed'] }),
    {
      active: false,
      reason: null,
    },
  );
});

test('PrivacyShieldState prioritizes active faults over warning-derived reasons', () => {
  assert.deepEqual(
    derivePrivacyShieldState({
      faultReason: 'stealth heartbeat missed',
      warnings: ['window_visible_to_capture'],
    }),
    {
      active: true,
      reason: 'Sensitive content hidden until privacy protection is restored.',
    },
  );
});
