export type AppleSiliconQoSClass =
	| "USER_INTERACTIVE"
	| "USER_INITIATED"
	| "BACKGROUND";

export interface AppleSiliconQoSAddon {
	setCurrentThreadQoS?: (qosClass: AppleSiliconQoSClass) => void;
}

export interface AppleSiliconQoSHandle {
	supported: boolean;
	setCurrentThreadQoS: (qosClass: AppleSiliconQoSClass) => void;
}

interface AppleSiliconQoSOptions {
	platform?: NodeJS.Platform;
	arch?: string;
	addonLoader?: () => AppleSiliconQoSAddon;
	logger?: Pick<Console, "warn">;
}

function shouldWarnOnQoSLoadFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return true;
	}

	const nodeError = error as NodeJS.ErrnoException;
	if (nodeError.code === "MODULE_NOT_FOUND") {
		return false;
	}

	return !/Cannot find module .*qos_helper\.node/.test(error.message);
}

function defaultAddonLoader(): AppleSiliconQoSAddon {
	return require("../native/qos_helper.node") as AppleSiliconQoSAddon;
}

export function createAppleSiliconQoS(
	options: AppleSiliconQoSOptions = {},
): AppleSiliconQoSHandle {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const logger = options.logger ?? console;

	if (platform !== "darwin" || arch !== "arm64") {
		return {
			supported: false,
			setCurrentThreadQoS() {},
		};
	}

	try {
		const addon = (options.addonLoader ?? defaultAddonLoader)();
		if (!addon?.setCurrentThreadQoS) {
			throw new Error("qos helper did not export setCurrentThreadQoS");
		}

		return {
			supported: true,
			setCurrentThreadQoS(qosClass) {
				addon.setCurrentThreadQoS?.(qosClass);
			},
		};
	} catch (error) {
		if (shouldWarnOnQoSLoadFailure(error)) {
			logger.warn(
				"[AppleSiliconQoS] QoS helper unavailable, continuing without QoS placement:",
				error,
			);
		}
		return {
			supported: false,
			setCurrentThreadQoS() {},
		};
	}
}

export const appleSiliconQoS = createAppleSiliconQoS();
