export interface PrivacyShieldState {
  active: boolean;
  reason: string | null;
}

export type VisibilityIntent =
  | 'boot_unknown'
  | 'protected_hidden'
  | 'protected_shield'
  | 'visible_safe_controls'
  | 'visible_app'
  | 'faulted_shield';

interface DerivePrivacyShieldStateOptions {
  warnings?: readonly string[];
  faultReason?: string | null;
  captureProtectionEnabled?: boolean;
  visibilityIntent?: VisibilityIntent;
}

const CAPTURE_RISK_WARNINGS = new Set([
  'chromium_capture_active',
  'capture_visibility_unknown',
  'scstream_capture_detected',
  'capture_tools_still_running',
  'native_module_unavailable',
  'native_stealth_failed',
  'private_api_failed',
  'new_screencapture_permission',
  'stealth_verification_failed',
  'virtual_display_failed',
  'virtual_display_exhausted',
  'window_visible_to_capture',
]);

const CAPTURE_RISK_REASON = 'Sensitive content hidden while capture risk is detected.';
const PROTECTION_FAULT_REASON = 'Sensitive content hidden until privacy protection is restored.';
const PROTECTED_INTENT_REASON = 'Sensitive content hidden while privacy mode is active.';

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

  const visibilityIntent = options.visibilityIntent ?? 'visible_app';
  if (visibilityIntent !== 'visible_app' && visibilityIntent !== 'visible_safe_controls') {
    return {
      active: true,
      reason: PROTECTED_INTENT_REASON,
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
