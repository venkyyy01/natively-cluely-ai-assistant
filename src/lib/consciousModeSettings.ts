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

export function buildHoverOnlyModeSelectedPayload(enabled: boolean) {
return {
mode: 'hover_only_mode' as const,
enabled,
};
}
