import { randomUUID } from 'node:crypto';

import { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, RuntimeLifecycleState, SupervisorName } from './types';
import type { WarmStandbyManager } from './WarmStandbyManager';

export interface RuntimeCoordinatorDelegate {
  prepareMeetingActivation(metadata?: unknown): Promise<void>;
  finalizeMeetingDeactivation(): Promise<void>;
}

interface RuntimeCoordinatorOptions {
  bus?: SupervisorBus;
  logger?: Pick<Console, 'warn'>;
  supervisors?: Partial<Record<SupervisorName, ISupervisor>>;
  managedSupervisorNames?: SupervisorName[];
  warmStandbyManager?: WarmStandbyManager<unknown, unknown, unknown>;
}

function buildCoordinatorError(message: string, errors: unknown[]): Error {
  if (errors.length === 1 && errors[0] instanceof Error) {
    return errors[0];
  }

  const error = new Error(message);
  (error as Error & { causes?: unknown[] }).causes = errors;
  return error;
}

export class RuntimeCoordinator {
  private readonly bus: SupervisorBus;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly supervisors: Partial<Record<SupervisorName, ISupervisor>>;
  private readonly managedSupervisorNames: SupervisorName[];
  private readonly warmStandbyManager?: WarmStandbyManager<unknown, unknown, unknown>;
  private lifecycleState: RuntimeLifecycleState = 'idle';
  private activeMeetingId: string | null = null;

  constructor(
    private readonly delegate: RuntimeCoordinatorDelegate,
    options: RuntimeCoordinatorOptions = {},
  ) {
    this.bus = options.bus ?? new SupervisorBus();
    this.logger = options.logger ?? console;
    this.supervisors = options.supervisors ?? {};
    this.managedSupervisorNames = options.managedSupervisorNames ?? ['recovery', 'audio', 'stt', 'inference'];
    this.warmStandbyManager = options.warmStandbyManager;
  }

  getBus(): SupervisorBus {
    return this.bus;
  }

  getLifecycleState(): RuntimeLifecycleState {
    return this.lifecycleState;
  }

  getSupervisor<TSupervisor extends ISupervisor = ISupervisor>(name: SupervisorName): TSupervisor {
    const supervisor = this.supervisors[name];
    if (!supervisor) {
      throw new Error(`Supervisor "${name}" is not registered`);
    }

    return supervisor as TSupervisor;
  }

  registerSupervisor(supervisor: ISupervisor): void {
    this.supervisors[supervisor.name] = supervisor;
  }

  async startSupervisors(names: SupervisorName[]): Promise<void> {
    const started: SupervisorName[] = [];

    try {
      for (const name of names) {
        const supervisor = this.getSupervisor(name);
        if (supervisor.getState() === 'running') {
          continue;
        }

        await supervisor.start();
        started.push(name);
      }
    } catch (error) {
      await this.rollbackStartedSupervisors(started);
      throw error;
    }
  }

  async stopSupervisors(names: SupervisorName[]): Promise<void> {
    let firstError: unknown = null;

    for (const name of [...names].reverse()) {
      try {
        await this.getSupervisor(name).stop();
      } catch (error) {
        this.logger.warn(`[RuntimeCoordinator] Failed stopping supervisor "${name}":`, error);
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }
  }

  async activate(metadata?: unknown): Promise<void> {
    if (this.lifecycleState !== 'idle') {
      throw new Error(`Cannot activate meeting while runtime is ${this.lifecycleState}`);
    }

    const meetingId = randomUUID();
    this.lifecycleState = 'starting';
    this.activeMeetingId = meetingId;
    await this.bus.emit({ type: 'lifecycle:meeting-starting', meetingId });

    try {
      await this.warmStandbyManager?.warmUp();
      await this.warmStandbyManager?.bindMeeting(meetingId);
      await this.delegate.prepareMeetingActivation(metadata);
      await this.startSupervisors(this.managedSupervisorNames);
      this.lifecycleState = 'active';
      await this.bus.emit({ type: 'lifecycle:meeting-active', meetingId });
    } catch (error) {
      await this.rollbackCoordinatorActivation();
      this.lifecycleState = 'idle';
      this.activeMeetingId = null;
      await this.bus.emit({ type: 'lifecycle:meeting-idle' });
      throw error;
    }
  }

  async deactivate(): Promise<void> {
    if (this.lifecycleState === 'idle') {
      this.logger.warn('[RuntimeCoordinator] Ignoring deactivate while runtime is idle');
      return;
    }

    if (this.lifecycleState === 'stopping') {
      this.logger.warn('[RuntimeCoordinator] Ignoring duplicate deactivate while runtime is stopping');
      return;
    }

    this.lifecycleState = 'stopping';
    await this.bus.emit({ type: 'lifecycle:meeting-stopping' });
    const errors: unknown[] = [];

    try {
      await this.stopSupervisors(this.managedSupervisorNames);
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Error during supervisor shutdown, continuing to finalize deactivation:', error);
      errors.push(error);
    }

    try {
      await this.delegate.finalizeMeetingDeactivation();
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Error while finalizing meeting deactivation:', error);
      errors.push(error);
    } finally {
      await this.warmStandbyManager?.unbindMeeting();
      this.lifecycleState = 'idle';
      this.activeMeetingId = null;
      await this.bus.emit({ type: 'lifecycle:meeting-idle' });
    }

    if (errors.length > 0) {
      throw buildCoordinatorError('RuntimeCoordinator deactivation completed with errors', errors);
    }
  }

  private async rollbackCoordinatorActivation(): Promise<void> {
    try {
      await this.stopSupervisors(this.managedSupervisorNames);
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Failed stopping supervisors during activation rollback:', error);
    }

    try {
      await this.warmStandbyManager?.unbindMeeting();
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Failed unbinding warm standby during activation rollback:', error);
    }

    try {
      await this.delegate.finalizeMeetingDeactivation();
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Failed finalizing meeting state during activation rollback:', error);
    }
  }

  private async rollbackStartedSupervisors(names: SupervisorName[]): Promise<void> {
    for (const name of [...names].reverse()) {
      try {
        await this.getSupervisor(name).stop();
      } catch (error) {
        this.logger.warn(`[RuntimeCoordinator] Failed rolling back supervisor "${name}":`, error);
      }
    }
  }
}
