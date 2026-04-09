export interface StealthArmControllerDelegate {
  setEnabled: (enabled: boolean) => Promise<void> | void;
  verifyStealthState: () => Promise<boolean> | boolean;
  startHeartbeat?: () => Promise<void> | void;
  stopHeartbeat?: () => Promise<void> | void;
}

export class StealthArmController {
  constructor(private readonly delegate: StealthArmControllerDelegate) {}

  async arm(): Promise<void> {
    await this.delegate.setEnabled(true);

    const verified = await this.delegate.verifyStealthState();
    if (!verified) {
      throw new Error('stealth verification failed');
    }

    await this.delegate.startHeartbeat?.();
  }

  async disarm(): Promise<void> {
    let firstError: unknown = null;

    try {
      await this.delegate.stopHeartbeat?.();
    } catch (error) {
      firstError = error;
    }

    try {
      await this.delegate.setEnabled(false);
    } catch (error) {
      firstError ??= error;
    }

    if (firstError) {
      throw firstError;
    }
  }
}
