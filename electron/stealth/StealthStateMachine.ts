import type { StealthState } from "../runtime/types";

export type StealthTransitionEvent =
	| "arm-requested"
	| "arm-succeeded"
	| "disabled"
	| "faulted";

const legalTransitions: Record<
	StealthState,
	Partial<Record<StealthTransitionEvent, StealthState>>
> = {
	OFF: {
		"arm-requested": "ARMING",
		faulted: "FAULT",
	},
	ARMING: {
		"arm-succeeded": "FULL_STEALTH",
		disabled: "OFF",
		faulted: "FAULT",
	},
	FULL_STEALTH: {
		disabled: "OFF",
		faulted: "FAULT",
	},
	FAULT: {
		"arm-requested": "ARMING",
		disabled: "OFF",
	},
};

export function transitionStealthState(
	state: StealthState,
	event: StealthTransitionEvent,
): StealthState {
	const nextState = legalTransitions[state][event];
	if (!nextState) {
		return "FAULT";
	}

	return nextState;
}

export function canArmStealth(state: StealthState): boolean {
	return state !== "ARMING" && state !== "FULL_STEALTH";
}

export function canDisableStealth(state: StealthState): boolean {
	return state !== "OFF";
}

export function canFaultStealth(state: StealthState): boolean {
	return state !== "FAULT";
}
