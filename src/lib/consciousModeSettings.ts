export const SESSION_MENU_TOGGLE_ORDER = [
  'Fast Response',
  'Transcript',
  'Conscious Mode',
  'Hover Only Mode',
] as const;

export function buildConsciousModeModeSelectedPayload(enabled: boolean) {
  return {
    mode: 'conscious_mode' as const,
    enabled,
  };
}
