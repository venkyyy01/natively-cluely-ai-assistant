export interface StealthArmControllerDelegate {
	setEnabled: (enabled: boolean) => Promise<void> | void;
	verifyStealthState: () => Promise<boolean> | boolean;
	startHeartbeat?: () => Promise<void> | void;
	stopHeartbeat?: () => Promise<void> | void;
	armNativeStealth?: () => Promise<boolean> | boolean;
	requireNativeStealth?: (() => Promise<boolean> | boolean) | boolean;
	heartbeatNativeStealth?: () => Promise<boolean> | boolean;
	faultNativeStealth?: (reason: string) => Promise<void> | void;
}

export class StealthArmController {
	constructor(private readonly delegate: StealthArmControllerDelegate) {}

	async arm(): Promise<void> {
		const nativeArmed = await this.delegate.armNativeStealth?.();
		if (nativeArmed === false) {
			const requireNativeStealth =
				typeof this.delegate.requireNativeStealth === "function"
					? await this.delegate.requireNativeStealth()
					: (this.delegate.requireNativeStealth ?? false);

			if (requireNativeStealth) {
				throw new Error("native stealth helper did not arm");
			}
		}

		await this.delegate.setEnabled(true);

		const verified = await this.delegate.verifyStealthState();
		if (!verified) {
			throw new Error("stealth verification failed");
		}

		await this.delegate.startHeartbeat?.();
	}

	async disarm(): Promise<void> {
		const errors: unknown[] = [];

		try {
			await this.delegate.faultNativeStealth?.("stealth disabled");
		} catch (error) {
			errors.push(error);
		}

		try {
			await this.delegate.stopHeartbeat?.();
		} catch (error) {
			errors.push(error);
		}

		try {
			await this.delegate.setEnabled(false);
		} catch (error) {
			errors.push(error);
		}

		if (errors.length === 1) {
			throw errors[0];
		}

		if (errors.length > 1) {
			throw new AggregateError(
				errors,
				"stealth disarm failed with multiple cleanup errors",
			);
		}
	}
}
