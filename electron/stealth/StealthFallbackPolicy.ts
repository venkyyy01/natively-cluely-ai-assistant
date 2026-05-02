export type StealthFallbackKind =
	| "python"
	| "sck-audio"
	| "native-stealth-load"
	| "private-macos-api";

export interface StealthFallbackPolicyInput {
	kind: StealthFallbackKind;
	env?: NodeJS.ProcessEnv;
	isProduction?: boolean;
	strict?: boolean;
	activeScreenShare?: boolean;
}

export interface StealthFallbackDecision {
	allow: boolean;
	kind: StealthFallbackKind;
	strict: boolean;
	production: boolean;
	reason: string;
	warning: string;
}

function isEnabled(value: string | undefined): boolean {
	return value === "1" || value === "true";
}

function resolveProduction(
	env: NodeJS.ProcessEnv,
	explicit?: boolean,
): boolean {
	if (typeof explicit === "boolean") {
		return explicit;
	}

	return env.NODE_ENV === "production" || isEnabled(env.NATIVELY_PACKAGED);
}

function resolveStrict(env: NodeJS.ProcessEnv, explicit?: boolean): boolean {
	if (typeof explicit === "boolean") {
		return explicit;
	}

	return isEnabled(env.NATIVELY_STRICT_PROTECTION);
}

export function decideStealthFallback(
	input: StealthFallbackPolicyInput,
): StealthFallbackDecision {
	const env = input.env ?? process.env;
	const strict = resolveStrict(env, input.strict);
	const production = resolveProduction(env, input.isProduction);

	switch (input.kind) {
		case "python": {
			if (production) {
				return {
					allow: false,
					kind: input.kind,
					strict,
					production,
					reason: strict
						? "python fallback is blocked in strict production protection mode"
						: "python fallback is blocked in production protection paths after native replacement",
					warning: "stealth_python_fallback_blocked",
				};
			}

			return {
				allow: true,
				kind: input.kind,
				strict,
				production,
				reason: isEnabled(env.NATIVELY_ALLOW_STEALTH_PYTHON_FALLBACK)
					? "python fallback explicitly enabled for development"
					: "python fallback allowed in development with degraded-state logging",
				warning: "stealth_python_fallback_used",
			};
		}

		case "sck-audio": {
			if (input.activeScreenShare) {
				return {
					allow: false,
					kind: input.kind,
					strict,
					production,
					reason:
						"ScreenCaptureKit audio fallback is blocked while another screen share is active",
					warning: "sck_audio_fallback_blocked_active_share",
				};
			}

			if (isEnabled(env.NATIVELY_ALLOW_SCK_AUDIO_FALLBACK)) {
				return {
					allow: true,
					kind: input.kind,
					strict,
					production,
					reason: "ScreenCaptureKit audio fallback explicitly enabled",
					warning: "sck_audio_fallback_used",
				};
			}

			return {
				allow: false,
				kind: input.kind,
				strict,
				production,
				reason:
					"ScreenCaptureKit audio fallback requires NATIVELY_ALLOW_SCK_AUDIO_FALLBACK=1",
				warning: "sck_audio_fallback_blocked",
			};
		}

		case "native-stealth-load":
		case "private-macos-api": {
			if (strict && production) {
				return {
					allow: false,
					kind: input.kind,
					strict,
					production,
					reason: `${input.kind} fallback is blocked in strict production protection mode`,
					warning: `${input.kind.replace(/-/g, "_")}_blocked`,
				};
			}

			return {
				allow: true,
				kind: input.kind,
				strict,
				production,
				reason: `${input.kind} fallback allowed with degraded-state logging`,
				warning: `${input.kind.replace(/-/g, "_")}_used`,
			};
		}
	}
}
