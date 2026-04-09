import type { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, StealthState, SupervisorState } from './types';
import {
  canArmStealth,
  canDisableStealth,
  canFaultStealth,
  transitionStealthState,
} from '../stealth/StealthStateMachine';
import { StealthArmController } from '../stealth/StealthArmController';

export interface StealthDelegate {
  setEnabled(enabled: boolean): void | Promise<void>;
  isEnabled?(): boolean;
  verifyStealthState?(): boolean | Promise<boolean>;
}

export interface StealthSupervisorOptions {
  bus?: SupervisorBus;
  logger?: Pick<Console, 'warn'>;
  verifier?: () => boolean | Promise<boolean>;
  startHeartbeat?: () => Promise<void> | void;
  stopHeartbeat?: () => Promise<void> | void;
  heartbeatIntervalMs?: number;
  intervalScheduler?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalScheduler?: (handle: unknown) => void;
}

export class StealthSupervisor implements ISupervisor {
  readonly name = 'stealth' as const;
  private state: SupervisorState = 'idle';
  private stealthState: StealthState = 'OFF';
  private pendingEnabled = false;
  private readonly armController: StealthArmController;
  private readonly heartbeatIntervalMs: number;
  private readonly intervalScheduler: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearIntervalScheduler: (handle: unknown) => void;
  private heartbeatHandle: unknown = null;
  private heartbeatCheckInFlight = false;

  constructor(
    private readonly delegate: StealthDelegate,
    private readonly bus: SupervisorBus,
    private readonly options: StealthSupervisorOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 500;
    this.intervalScheduler = options.intervalScheduler ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearIntervalScheduler = options.clearIntervalScheduler ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.armController = new StealthArmController({
      setEnabled: (enabled) => this.delegate.setEnabled(enabled),
      verifyStealthState: () => this.verifyStealth(),
      startHeartbeat: () => this.startHeartbeat(),
      stopHeartbeat: () => this.stopHeartbeat(),
    });
  }

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

  async reportFault(error: unknown): Promise<void> {
    if (!canFaultStealth(this.stealthState)) {
      return;
    }

    await this.failClosed(error);
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
    if (!canArmStealth(this.stealthState)) {
      return;
    }

    await this.transitionTo(transitionStealthState(this.stealthState, 'arm-requested'));

    try {
      await this.armController.arm();
      await this.transitionTo(transitionStealthState(this.stealthState, 'arm-succeeded'));
      this.pendingEnabled = true;
    } catch (error) {
      await this.failClosed(error);
      throw error;
    }
  }

  private async disableStealth(): Promise<void> {
    if (!canDisableStealth(this.stealthState)) {
      this.pendingEnabled = false;
      return;
    }

    try {
      await this.armController.disarm();
    } catch (error) {
      await this.failClosed(error);
      throw error;
    }

    this.pendingEnabled = false;
    await this.transitionTo(transitionStealthState(this.stealthState, 'disabled'));
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
    if (canFaultStealth(this.stealthState)) {
      await this.transitionTo(transitionStealthState(this.stealthState, 'faulted'));
    }
    this.pendingEnabled = false;

    try {
      await this.armController.disarm();
    } catch (disableError) {
      this.options.logger?.warn('[StealthSupervisor] Failed to disable delegate after fault:', disableError);
    }

    await this.bus.emit({ type: 'stealth:fault', reason });
  }

  private async startHeartbeat(): Promise<void> {
    await this.options.startHeartbeat?.();
    if (this.heartbeatHandle || this.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatHandle = this.intervalScheduler(() => {
      void this.runHeartbeatCheck();
    }, this.heartbeatIntervalMs);

    const timeoutLikeHandle = this.heartbeatHandle as { unref?: () => void };
    timeoutLikeHandle.unref?.();
  }

  private async stopHeartbeat(): Promise<void> {
    if (this.heartbeatHandle) {
      this.clearIntervalScheduler(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    await this.options.stopHeartbeat?.();
  }

  private async runHeartbeatCheck(): Promise<void> {
    if (this.heartbeatCheckInFlight) {
      return;
    }

    if (this.state !== 'running' || this.stealthState !== 'FULL_STEALTH') {
      return;
    }

    this.heartbeatCheckInFlight = true;
    try {
      const verified = await this.verifyStealth();
      if (!verified) {
        await this.reportFault(new Error('stealth heartbeat missed'));
      }
    } catch (error) {
      await this.reportFault(error);
    } finally {
      this.heartbeatCheckInFlight = false;
    }
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
