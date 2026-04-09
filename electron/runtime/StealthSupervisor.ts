import type { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, StealthState, SupervisorState } from './types';

export interface StealthDelegate {
  setEnabled(enabled: boolean): void | Promise<void>;
  isEnabled?(): boolean;
  verifyStealthState?(): boolean | Promise<boolean>;
}

export interface StealthSupervisorOptions {
  bus?: SupervisorBus;
  logger?: Pick<Console, 'warn'>;
  verifier?: () => boolean | Promise<boolean>;
}

export class StealthSupervisor implements ISupervisor {
  readonly name = 'stealth' as const;
  private state: SupervisorState = 'idle';
  private stealthState: StealthState = 'OFF';
  private pendingEnabled = false;

  constructor(
    private readonly delegate: StealthDelegate,
    private readonly bus: SupervisorBus,
    private readonly options: StealthSupervisorOptions = {},
  ) {}

  getState(): SupervisorState {
    return this.state;
  }

  getStealthState(): StealthState {
    return this.stealthState;
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start stealth supervisor while state is ${this.state}`);
    }

    this.state = 'starting';
    this.state = 'running';
    await this.syncDelegateWithState();
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    try {
      await this.disableStealth();
    } finally {
      this.state = 'idle';
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.pendingEnabled = enabled;

    if (enabled) {
      await this.armStealth();
      return;
    }

    await this.disableStealth();
  }

  private async syncDelegateWithState(): Promise<void> {
    if (this.pendingEnabled || this.readDelegateEnabled()) {
      await this.armStealth();
    }
  }

  private readDelegateEnabled(): boolean {
    try {
      return this.delegate.isEnabled?.() ?? false;
    } catch {
      return false;
    }
  }

  private async armStealth(): Promise<void> {
    if (this.stealthState === 'FULL_STEALTH' || this.stealthState === 'ARMING') {
      return;
    }

    const from = this.stealthState;
    await this.transitionTo('ARMING');

    try {
      await this.delegate.setEnabled(true);
      const verified = await this.verifyStealth();
      if (!verified) {
        throw new Error('stealth verification failed');
      }

      await this.transitionTo('FULL_STEALTH');
      this.pendingEnabled = true;
    } catch (error) {
      await this.failClosed(error);
      throw error;
    }
  }

  private async disableStealth(): Promise<void> {
    if (this.stealthState === 'OFF') {
      this.pendingEnabled = false;
      return;
    }

    const from = this.stealthState;
    try {
      await this.delegate.setEnabled(false);
    } catch (error) {
      await this.failClosed(error);
      throw error;
    }

    this.pendingEnabled = false;
    await this.transitionTo('OFF');
  }

  private async verifyStealth(): Promise<boolean> {
    if (this.options.verifier) {
      return Boolean(await this.options.verifier());
    }

    if (this.delegate.verifyStealthState) {
      return Boolean(await this.delegate.verifyStealthState());
    }

    return this.readDelegateEnabled();
  }

  private async failClosed(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.transitionTo('FAULT');
    this.pendingEnabled = false;

    try {
      await this.delegate.setEnabled(false);
    } catch (disableError) {
      this.options.logger?.warn('[StealthSupervisor] Failed to disable delegate after fault:', disableError);
    }

    await this.bus.emit({ type: 'stealth:fault', reason });
  }

  private async transitionTo(next: StealthState): Promise<void> {
    const from = this.stealthState;
    this.stealthState = next;
    await this.emitStateChange(from, next);
  }

  private async emitStateChange(from: StealthState, to: StealthState): Promise<void> {
    if (from === to) {
      return;
    }

    await this.bus.emit({ type: 'stealth:state-changed', from, to });
  }
}
