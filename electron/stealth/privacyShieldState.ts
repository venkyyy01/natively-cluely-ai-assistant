export interface PrivacyShieldState {
  active: boolean;
  reason: string | null;
}

interface DerivePrivacyShieldStateOptions {
  warnings?: readonly string[];
  faultReason?: string | null;
  captureProtectionEnabled?: boolean;
}

const CAPTURE_RISK_WARNINGS = new Set([
  'chromium_capture_active',
  'native_module_unavailable',
  'native_stealth_failed',
  'new_screencapture_permission',
  'stealth_verification_failed',
  'window_visible_to_capture',
]);

const CAPTURE_RISK_REASON = 'Sensitive content hidden while capture risk is detected.';
const PROTECTION_FAULT_REASON = 'Sensitive content hidden until privacy protection is restored.';

export function hasCaptureRiskWarnings(warnings: readonly string[] = []): boolean {
  return warnings.some((warning) => CAPTURE_RISK_WARNINGS.has(warning));
}

export function derivePrivacyShieldState(options: DerivePrivacyShieldStateOptions = {}): PrivacyShieldState {
  if (options.faultReason) {
    return {
      active: true,
      reason: PROTECTION_FAULT_REASON,
    };
  }

  const warnings = options.warnings ?? [];
  if ((options.captureProtectionEnabled ?? true) && hasCaptureRiskWarnings(warnings)) {
    return {
      active: true,
      reason: CAPTURE_RISK_REASON,
    };
  }

  return {
    active: false,
    reason: null,
  };
}
